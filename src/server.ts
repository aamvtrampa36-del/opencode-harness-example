import { DurableObject } from "cloudflare:workers";
import { PersonalSettings } from "./personal-settings";
export { PersonalSettings };
import { DevContainer } from "./dev-container";
export { DevContainer };
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { routeAgentRequest } from "agents";
import { OpenCodeHarness } from "agents/harness/opencode";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/opencode";
import { WebSockets } from "agents/websockets";
import { OpenCodeSessionSockets } from "./sockets";
import { workspacePlugin } from "./workspace";
import { openRouterCredentialPlugin } from "./openrouter";
import { MODEL_PRESETS } from "./model-presets";
import { GitHubBridge } from "./github";
import { verifyG8Proofs, G8_PROOFS } from "./g8-smoke";
import { assessG8LiveHistory, g8LivePrompt, G8_LIVE_CHECK_VERSION, type G8LiveCheck } from "./g8-live-agent";
import { G9_PROOF_VERSION, G9_REPO, G9_BRANCH, G9_PROJECT, G9_SOURCE, G9_TEST_PATH, G9_BROKEN, G9_FIXED, G9_TEST_SOURCE, assessG9History, g9AgentPrompt, assertG9BoundGitHubOperation, type G9ProofState } from "./g9-selfdev";
import { assertScopedTool, requireSameScope, scopeStorageKey, validateProjectScope, type ProjectScope, type ScopedToolAction } from "./project-scope";
import { remoteMcpPlugin } from "./mcp-plugin";
import { assessAgentToolEvidence, hasUnfinishedAgentCheck, isUnlimitedDevAgentCheck, isAgentCheckModel, explainAgentCheckFailure, isAgentCheckKind, repairSeedCommand, repairIsVerified, REPAIR_SOURCE_BROKEN, REPAIR_TEST } from "./agent-check";
import { inlinePreviewAssets } from "./preview-inline";
import { classifyAgentFailure, observeLinux, type IncidentObservation } from "./incident-diagnostics";
import { validateExportIdentity, sessionExportResponse } from "./session-export";
import { archiveDownloadResponse, archiveError } from "./download-response";
import { githubRepositoryDownload } from "./github-download";
import { checkIsolation } from "./isolation-check";
import { projectContainerName, repositoryProjectSlug } from "./project-container";
import { checkIsolatedBackup } from "./isolated-backup-check";

export const MODEL_ID = "@cf/openai/gpt-oss-20b";

/** A playable OpenCode instance backed by one Durable Object. */
export class OpenCodeAgent extends DurableObject<Env> {
  // Credentials are resolved server-side. All browsers share one owner config.
  private readonly personalConfig = this.env.SETTINGS.getByName("personal");
  private readonly providerConnection: {
    connect?: (key: string) => Promise<void>;
  } = {};
  private readonly mcpLifecycle: { reload?: () => Promise<void> } = {};
  async refreshMcps(): Promise<{ refreshed: boolean }> {
    if (!this.mcpLifecycle.reload) return { refreshed: false };
    await this.mcpLifecycle.reload();
    return { refreshed: true };
  }
  /** Persisted server-side transcript for the owner's authenticated download. */
  async exportSessionData(sessionID: string) {
    const sessions = await this.harness.sessions.list();
    if (!sessions.some(item => item.id === sessionID)) {
      throw new Error("La conversación no existe en este espacio");
    }
    return JSON.stringify(await this.harness.session(sessionID).history());
  }

  /** This selection is fixed per OpenCode conversation, not an LLM instruction. */
  async bindSessionScope(sessionID: string, input: unknown): Promise<void> {
    const next = validateProjectScope(input, await this.personalConfig.getAllowedRepositories());
    const key = scopeStorageKey(sessionID);
    await this.ctx.storage.transaction(async tx => {
      const old = await tx.get<ProjectScope>(key);
      const current = requireSameScope(old, next);
      if (!old) await tx.put(key, current);
    });
  }

  async inheritSessionScope(source: string, target: string, project: string): Promise<void> {
    const old = await this.ctx.storage.get<ProjectScope>(scopeStorageKey(source));
    if (old) {
      if (old.project !== project) throw new Error("La sesión delegada no puede cambiar de proyecto");
      await this.bindSessionScope(target, old);
    } else {
      await this.bindSessionScope(target, { project });
    }
  }

  async enforceSessionScope(sessionID: string, action: ScopedToolAction): Promise<void> {
    const scope = await this.ctx.storage.get<ProjectScope>(scopeStorageKey(sessionID));
    assertScopedTool(scope, action);
    if(action.kind === "github"){
      const g9 = await this.ctx.storage.get<G9ProofState>("g9-selfdev-v1");
      if(g9?.session === sessionID) {
        assertG9BoundGitHubOperation(action.operation, action.branch);
      }
    }
  }

  /** Trusted lookup for read-only GitHub tools. No LLM-provided repository. */
  async sessionRepository(sessionID: string): Promise<string> {
    const scope = await this.ctx.storage.get<ProjectScope>(scopeStorageKey(sessionID));
    if (!scope?.repository) {
      throw new Error("Esta sesión no tiene repositorio GitHub asignado. Selecciona uno desde Proyectos en una conversación nueva.");
    }
    return scope.repository;
  }

  /**
   * One owner-triggered two-repository acceptance test. Both use the ACTUAL
   * OpenCode Harness/model/plugin, read-only plan agent and two isolated
   * Durable Object sessions; never accept an LLM's textual success claim.
   * Repeated clicks reuse the saved attempt rather than spending more tokens.
   */
  async startG8LiveReview(): Promise<{ status: string; message?: string }> {
    const existing = await this.ctx.storage.get<G8LiveCheck>("g8-live-agent-v1");
    if (existing?.version === G8_LIVE_CHECK_VERSION) {
      return { status: "existing", message: "La prueba G8 ya fue iniciada. Consulta su resultado." };
    }
    const allowed = await this.personalConfig.getAllowedRepositories();
    if (!G8_PROOFS.every(p => allowed.some(name => name.toLowerCase() === p.repo.toLowerCase()))) {
      return { status: "rejected", message: "Autoriza ambos repositorios CDF CLOUD y WorkBench en Configuración." };
    }
    const githubKey = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN
      || await this.personalConfig.getGitHubKey();
    if (!githubKey) return { status: "rejected", message: "Conecta GitHub desde Configuración." };
    const state: G8LiveCheck = {
      version: G8_LIVE_CHECK_VERSION, status: "starting", startedAt: Date.now(), tasks: []
    };
    await this.ctx.storage.put("g8-live-agent-v1", state);
    try {
      for (const proof of G8_PROOFS) {
        const created = await this.harness.sessions.create();
        await this.bindSessionScope(created.id, { project: proof.project, repository: proof.repo });
        const task = {
          repo: proof.repo, project: proof.project, branch: proof.branch,
          session: created.id, startedAt: Date.now()
        };
        state.tasks.push(task);
        await this.ctx.storage.put("g8-live-agent-v1", state);
        const handle = this.harness.session(created.id);
        await handle.setAgent("plan");
        await handle.setModel(this.ai(MODEL_ID));
        await handle.submit(g8LivePrompt(proof), { whenBusy: "followUp" });
      }
      state.status = "running";
      await this.ctx.storage.put("g8-live-agent-v1", state);
      return { status: "started" };
    } catch (error) {
      state.status = "failed";
      state.reason = error instanceof Error ? error.message.slice(0, 180) : "No se pudo iniciar la prueba";
      await this.ctx.storage.put("g8-live-agent-v1", state);
      return { status: "failed", message: state.reason };
    }
  }

  async getG8LiveReview(): Promise<unknown> {
    const state = await this.ctx.storage.get<G8LiveCheck>("g8-live-agent-v1");
    if (!state || state.version !== G8_LIVE_CHECK_VERSION) return { status: "not-started" };
    if (state.status === "failed" || state.status === "passed") {
      return { status: state.status, reason: state.reason, results: state.results ?? [] };
    }
    const results = [];
    let waiting = state.status === "starting" || state.tasks.length !== G8_PROOFS.length;
    for (const task of state.tasks) {
      const proof = G8_PROOFS.find(p => p.repo === task.repo && p.branch === task.branch);
      if (!proof) return { status: "failed", reason: "Ámbito de la prueba inválido", results: [] };
      try {
        const handle = this.harness.session(task.session);
        const [running, history] = await Promise.all([handle.busy(), handle.history()]);
        const evidence = assessG8LiveHistory(history, proof);
        const noAnswerYet = !history.some(message => message.type === "assistant");
        const pending = running || (noAnswerYet && Date.now() - task.startedAt < 90_000);
        if (pending && Date.now() - task.startedAt > 6 * 60_000) {
          try { await handle.abort(); } catch { /* read-only check cannot run indefinitely */ }
          results.push({ repo: proof.repo, status: "failed", reason: "El modelo superó seis minutos",
            toolCalls: evidence.matchedTools });
          continue;
        }
        if (pending) waiting = true;
        results.push({
          repo: proof.repo, branch: proof.branch, status: pending ? "running" :
            evidence.passed ? "passed" : "failed",
          reason: pending ? "Ejecutando revisión de solo lectura" : evidence.reason,
          toolCalls: evidence.matchedTools,
          completedTools: evidence.completedTools,
          failedTools: evidence.failedTools
        });
      } catch {
        results.push({ repo: proof.repo, status: "failed",
          reason: "No se pudo recuperar el historial del agente; consulta los registros.",
          toolCalls: 0 });
      }
    }
    if (waiting) return { status: "running", results };
    const passed = results.length === G8_PROOFS.length && results.every(result => result.status === "passed");
    state.status = passed ? "passed" : "failed";
    state.results = results;
    state.reason = passed ? undefined : "Alguna sesión no completó repo_review correctamente";
    await this.ctx.storage.put("g8-live-agent-v1", state);
    return { status: state.status, results, ...(passed ? {} : { reason: state.reason }) };
  }

  /** One owner-authorized live G9 code repair, fully isolated in a draft branch.
   * Fixture and initial failure are seeded server-side; only the agent gets
   * credit for a subsequent GitHub source edit and draft PR.
   */
  async startG9SelfDev(): Promise<{status:string;reason?:string;session?:string}> {
    const allowed = await this.personalConfig.getAllowedRepositories();
    if (!allowed.some(name => name.toLowerCase() === G9_REPO.toLowerCase())) {
      return {status:"rejected",reason:"Autoriza el repositorio OpenCode Cloud en Configuración de GitHub."};
    }
    const token = (this.env as Env & {GITHUB_TOKEN?: string}).GITHUB_TOKEN
      || await this.personalConfig.getGitHubKey();
    if (!token) return {status:"rejected",reason:"Conecta GitHub dentro de OpenCode Cloud."};
    let already: G9ProofState | undefined;
    await this.ctx.storage.transaction(async tx => {
      already = await tx.get<G9ProofState>("g9-selfdev-v1");
      if(!already) {
        await tx.put("g9-selfdev-v1", {
          version:G9_PROOF_VERSION,status:"starting",startedAt:Date.now()
        } satisfies G9ProofState);
      }
    });
    if(already) return {status:"existing",session:already.session,
      reason:"La prueba G9 ya se inició. Consulta su estado; no se ejecutará otra inferencia."};
    const state: G9ProofState = {
      version:G9_PROOF_VERSION,status:"starting",startedAt:Date.now(),seedCommits:[]
    };
    try {
      await this.githubRunner.execute({action:"branch",repo:G9_REPO,branch:G9_BRANCH});
      const seedCode = await this.githubRunner.execute({
        action:"write",repo:G9_REPO,branch:G9_BRANCH,path:G9_SOURCE,
        content:G9_BROKEN,message:"test(g9): seed deliberately failing isolated source"
      }) as {commitSha?:string};
      const seedTest = await this.githubRunner.execute({
        action:"write",repo:G9_REPO,branch:G9_BRANCH,path:G9_TEST_PATH,
        content:G9_TEST_SOURCE,message:"test(g9): seed immutable Node regression"
      }) as {commitSha?:string};
      state.seedCommits=[seedCode.commitSha??"",seedTest.commitSha??""];
      const seedScript="const fs=require('node:fs');"+
        "fs.writeFileSync('add.mjs',"+JSON.stringify(G9_BROKEN)+");"+
        "fs.writeFileSync('add.test.mjs',"+JSON.stringify(G9_TEST_SOURCE)+");";
      const seed=await this.linuxRunner.run(G9_PROJECT,
        "node -e "+JSON.stringify(seedScript)+" && node --test --test-reporter=tap add.test.mjs");
      if(seed.exitCode!==1 || !seed.stdout.includes("not ok")) {
        throw new Error("El fixture inicial no falló como se esperaba; no se inicia inferencia.");
      }
      const created=await this.harness.sessions.create();
      await this.bindSessionScope(created.id,{project:G9_PROJECT,repository:G9_REPO});
      state.session=created.id;
      await this.ctx.storage.put("g9-selfdev-v1",state);
      const handle=this.harness.session(created.id);
      await handle.setAgent("build");
      // Prefer the same inexpensive model that completed G2; a functional
      // Cloudflare model is available if the owner has no OpenRouter connection.
      let selected: {providerID:string;id:string}|undefined;
      if(await this.isOpenRouterConfigured()){
        try {
          const registration=await this.refreshOpenRouter();
          if(registration.active) selected={providerID:"openrouter",id:MODEL_PRESETS.review.id};
        }catch { /* Use existing Workers AI provider, never expose credentials. */ }
      }
      await handle.setModel(selected ?? this.ai(MODEL_ID));
      await handle.submit(g9AgentPrompt(),{whenBusy:"followUp"});
      state.status="running";
      await this.ctx.storage.put("g9-selfdev-v1",state);
      return {status:"started",session:created.id};
    }catch(error){
      state.status="failed";
      state.reason=error instanceof Error ? error.message.slice(0,240) : "No se pudo iniciar G9";
      await this.ctx.storage.put("g9-selfdev-v1",state);
      return {status:"failed",reason:state.reason,session:state.session};
    }
  }

  async getG9SelfDev(): Promise<unknown> {
    const state=await this.ctx.storage.get<G9ProofState>("g9-selfdev-v1");
    if(!state || state.version!==G9_PROOF_VERSION)return {status:"not-started"};
    if(state.status==="failed" || state.status==="passed") return {
      status:state.status,reason:state.reason,result:state.result,session:state.session,
      branch:G9_BRANCH
    };
    if(!state.session || state.status==="verifying")
      return {status:"running",stage:state.status,branch:G9_BRANCH};
    try{
      const handle=this.harness.session(state.session);
      const [busy,history]=await Promise.all([handle.busy(),handle.history()]);
      const evidence=assessG9History(history);
      if(busy && Date.now()-state.startedAt < 8*60_000)
        return {status:"running",stage:"agent",session:state.session,
          toolCalls:evidence.toolCalls,branch:G9_BRANCH};
      if(busy){
        try{await handle.abort()}catch { /* ensure no unbounded background cost */ }
        throw new Error("La sesión superó el límite de seguridad de ejecución.");
      }
      state.result=evidence;
      if(!evidence.passed) throw new Error(
        "El agente no completó la secuencia roja → escritura GitHub → verde → diff → PR borrador. "+
        "Herramientas observadas: "+evidence.toolCalls+"; fallidas: "+evidence.failedTools);
      state.status="verifying";
      await this.ctx.storage.put("g9-selfdev-v1",state);
      const [source,original,comparison]=await Promise.all([
        this.githubRunner.execute({action:"read",repo:G9_REPO,ref:G9_BRANCH,path:G9_SOURCE}),
        this.githubRunner.execute({action:"read",repo:G9_REPO,ref:G9_BRANCH,path:G9_TEST_PATH}),
        this.githubRunner.execute({action:"review",repo:G9_REPO,branch:G9_BRANCH})
      ]) as [
        {content?:string},{content?:string},
        {repo?:string;branch?:string;base?:string;truncated?:boolean;files?:{path:string}[]}
      ];
      if(typeof source.content!=="string" || source.content.trim()!==G9_FIXED.trim() || original.content!==G9_TEST_SOURCE ||
         comparison.repo?.toLowerCase()!==G9_REPO.toLowerCase() ||
         comparison.branch!==G9_BRANCH || comparison.base!=="main" ||
         comparison.truncated ||
         comparison.files?.length!==2 ||
         ![G9_SOURCE,G9_TEST_PATH].every(path=>comparison.files!.some(file=>file.path===path))){
        throw new Error("La revisión independiente no coincide con el arreglo exacto y el test original.");
      }
      const script="const fs=require('node:fs');"+
        "fs.writeFileSync('add.mjs',"+JSON.stringify(source.content)+");"+
        "fs.writeFileSync('add.test.mjs',"+JSON.stringify(original.content)+");";
      const check=await this.linuxRunner.run(G9_PROJECT,
        "node -e "+JSON.stringify(script)+" && node --test --test-reporter=tap add.test.mjs");
      if(check.exitCode!==0 || !check.stdout.includes("ok 1 - G9: add(2,3) is five")){
        throw new Error("La prueba Node independiente no aprobó el código de GitHub.");
      }
      state.status="passed";
      state.reason=undefined;
      await this.ctx.storage.put("g9-selfdev-v1",state);
      return {status:"passed",result:state.result,session:state.session,
        branch:G9_BRANCH,independentLinuxExitCode:check.exitCode};
    }catch(error){
      state.status="failed";
      state.reason=error instanceof Error ? error.message.slice(0,350):"No se pudo verificar G9";
      await this.ctx.storage.put("g9-selfdev-v1",state);
      return {status:"failed",reason:state.reason,result:state.result,
        session:state.session,branch:G9_BRANCH};
    }
  }

  private readonly githubRunner = {
    execute: async (input: Parameters<GitHubBridge["execute"]>[0]) => {
      const key = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN
        || await this.personalConfig.getGitHubKey();
      if (!key) throw new Error("Conecta GitHub desde Configuración para trabajar con repositorios privados.");
      // Wrap the global fetch so it is called with the correct receiver in Workers.
      return new GitHubBridge(key, (url, init) => globalThis.fetch(url, init),
        await this.personalConfig.getAllowedRepositories()).execute(input);
    }
  };
  async isOpenRouterConfigured(): Promise<boolean> {
    const envKey = (this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
    return Boolean(envKey || await this.personalConfig.getOpenRouterKey());
  }
  async refreshOpenRouter(): Promise<{ active: boolean }> {
    const key = (this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY
      || await this.personalConfig.getOpenRouterKey();
    if (!key || !this.providerConnection.connect) return { active: false };
    await this.providerConnection.connect(key);
    return { active: true };
  }
  /** Explicit owner-initiated real-model/tool test, never a recurring cron. */
  async startAgentCheck(model: unknown = "cloudflare", kind: unknown = "repair"): Promise<{ status: string; session?: string; project?: string; model?: string; kind?: string; message?: string }> {
    if (!isAgentCheckModel(model)) {
      return { status: "rejected", message: "Solo se permiten modelos económicos en la autoprueba." };
    }
    if (!isAgentCheckKind(kind)) {
      return { status: "rejected", message: "Tipo de autoprueba desconocido." };
    }
    const preset = MODEL_PRESETS[model];
    if (preset.providerID === "openrouter" && !(await this.isOpenRouterConfigured())) {
      return { status: "rejected", message: "Conecta OpenRouter antes de probar este modelo. No se consumió la cuota." };
    }
    const previous = await this.ctx.storage.get<{
      session: string; project: string; token: string; startedAt: number; model?: string; kind?: string; error?: string
    }>("agent-check-v1");
    const outcome = await this.ctx.storage.get("agent-check-result-v1");
    if (hasUnfinishedAgentCheck(previous, outcome)) {
      return { status: "existing", session: previous!.session, project: previous!.project, model: previous!.model ?? "cloudflare", kind: previous!.kind ?? "linux" };
    }
    // Staging-only development switch: retries are allowed without a daily counter.
    // Production keeps the existing quota unless its own environment opts in.
    const unrestrictedDev = isUnlimitedDevAgentCheck((this.env as Env & { G1_DEV_UNLIMITED_CHECKS?: string }).G1_DEV_UNLIMITED_CHECKS);
    if (!unrestrictedDev && !(await this.personalConfig.reserveAgentCheck())) {
      return { status: "daily-limit", message: "Límite de dos verificaciones diarias para evitar gastos de IA" };
    }
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const project = "agent-check-" + token;
    const created = await this.harness.sessions.create();
    const state = { session: created.id, project, token, model, kind, startedAt: Date.now() };
    await this.bindSessionScope(created.id, { project });
    // Atomically replace the previous terminal proof only after creating a new session.
    // This keeps completed checks retryable without exposing stale pass results.
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put("agent-check-v1", state);
      await tx.delete("agent-check-result-v1");
    });
    try {
      if (kind === "repair") {
        const seed = await this.linuxRunner.run(project, repairSeedCommand());
        if (seed.exitCode !== 1 || !seed.stdout.includes("not ok")) {
          throw new Error("Prueba inicial no verificable: exitCode=" + seed.exitCode + "; salida TAP=" + seed.stdout.includes("not ok") + "; stderr presente=" + Boolean(seed.stderr));
        }
      }
      const handle = this.harness.session(created.id);
      await handle.setAgent("build");
      await handle.setModel(model === "cloudflare" ? this.ai(MODEL_ID) : {
        providerID: preset.providerID, id: preset.id
      });
      const command = "printf '" + token + "' > proof.txt && node -e " +
        JSON.stringify("const fs=require('node:fs');if(fs.readFileSync('proof.txt','utf8')!==" +
          JSON.stringify(token) + ")process.exit(2);console.log('AGENT_PROOF_OK:" + token + "')");
      const prompt = "Esta es una autoprueba REAL de herramientas, no una tarea de conversación. " +
        "Usa la herramienta linux con project=" + project + " y command=" +
        JSON.stringify(command) + ". Debes CREAR el archivo proof.txt en el Container y VERIFICARLO con Node. " +
        "No generes código solamente en tu respuesta. Espera el resultado real de linux " +
        "y describe su exitCode. No alteres ningún otro proyecto.";
      const repairPrompt = "Prueba REAL de reparación autónoma de código. Proyecto Linux aislado: " +
        project + ". Emplea ÚNICAMENTE la herramienta cuyo nombre exacto es linux " +
        "(con parámetros project y command). NO uses inspect_linux, exec, herramientas de archivos ni otros nombres. " +
        "Ya existen calc.mjs con un defecto y calc.test.mjs con el test original. " +
        "Paso 1: llama a linux para ejecutar node --test --test-reporter=tap calc.test.mjs; observa el fallo. " +
        "Paso 2: llama a linux con cat calc.mjs && cat calc.test.mjs para inspeccionar ambos archivos. " +
        "Paso 3: decide la reparación y escribe SOLO calc.mjs mediante otro comando linux que construyas tú; " +
        "no modifiques calc.test.mjs ni ningún otro proyecto. " +
        "Paso 4: vuelve a llamar a linux para ejecutar node --test --test-reporter=tap calc.test.mjs " +
        "y, únicamente cuando el test pase, imprime AGENT_PROOF_OK:" + token +
        " en la salida de esa misma llamada Linux. Espera los exitCode reales. " +
        "No basta con describir la reparación; todas las acciones deben realizarse mediante linux.";
      await handle.submit(kind === "repair" ? repairPrompt : prompt, { whenBusy: "followUp" });
      return { status: "started", session: created.id, project, model, kind };
    } catch (error) {
      const failed = {
        ...state, error: error instanceof Error ? error.message.slice(0, 250) : "No se pudo iniciar"
      };
      await this.ctx.storage.put("agent-check-v1", failed);
      return { status: "failed", message: failed.error, model, kind };
    }
  }





  async agentCheckStatus(): Promise<unknown> {
    const saved = await this.ctx.storage.get<{
      status: string; toolCalls: number; fileVerified: boolean; project: string; model?: string; kind?: string; reason?: string
    }>("agent-check-result-v1");
    if (saved) return saved;
    const state = await this.ctx.storage.get<{
      session: string; project: string; token: string; startedAt: number; model?: string; kind?: string; error?: string
    }>("agent-check-v1");
    if (!state) return { status: "not-started" };
    if (state.error) return { status: "failed", reason: state.error, project: state.project, model: state.model, kind: state.kind };
    const handle = this.harness.session(state.session);
    let running: boolean;
    let history: Awaited<ReturnType<typeof handle.history>>;
    try {
      [running, history] = await Promise.all([handle.busy(), handle.history()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /ModelUnavailableError|Model unavailable/i.test(message)
        ? "El modelo elegido no está disponible en el registro activo de OpenCode. Prueba otro modelo."
        : "No se pudo recuperar la ejecución del agente; consulta los registros del servicio.";
      const failed = { status: "failed", reason, toolCalls: 0, fileVerified: false,
        project: state.project, model: state.model, kind: state.kind };
      await this.ctx.storage.put("agent-check-result-v1", failed);
      return failed;
    }
    const evidence = assessAgentToolEvidence(history, state.project, state.token);
    if (running) {
      if (Date.now() - state.startedAt < 6 * 60_000) {
        return { status: "running", toolCalls: evidence.requestedTools, project: state.project, model: state.model, kind: state.kind };
      }
      try { await handle.abort(); } catch { /* Preserve timeout as a failure. */ }
      const timeout = { status: "failed", reason: "La autoprueba superó seis minutos y se detuvo para evitar consumo indefinido.",
        toolCalls: evidence.requestedTools, fileVerified: false, project: state.project, model: state.model, kind: state.kind };
      await this.ctx.storage.put("agent-check-result-v1", timeout);
      return timeout;
    }
    if (!history.some(message => message.type === "assistant") &&
        Date.now() - state.startedAt < 5 * 60_000) {
      return { status: "queued", toolCalls: 0, project: state.project, model: state.model, kind: state.kind };
    }
    const toolSequenceVerified = state.kind === "repair"
      ? evidence.verifiedRepairSequence : evidence.correctLinuxResult;
    let fileVerified = false;
    if (toolSequenceVerified) {
      try {
        const dev = await this.isolatedProject(state.project);
        if (state.kind === "repair") {
          const [source, test] = await Promise.all([
            dev.inspect(state.project, "read", "calc.mjs") as Promise<{ contents?: string }>,
            dev.inspect(state.project, "read", "calc.test.mjs") as Promise<{ contents?: string }>
          ]);
          if (source.contents && test.contents === REPAIR_TEST && source.contents !== REPAIR_SOURCE_BROKEN) {
            const run = await dev.run(state.project, "node --test --test-reporter=tap calc.test.mjs");
            fileVerified = repairIsVerified(source.contents, test.contents, run.exitCode);
          }
        } else {
          const actual = await dev.inspect(state.project, "read", "proof.txt") as { contents?: string };
          fileVerified = actual.contents === state.token;
        }
      } catch { /* Failed inspection or test cannot count as a verified repair. */ }
    }
    const outcome = {
      status: toolSequenceVerified && fileVerified ? "passed" : "failed",
      toolCalls: evidence.requestedTools,
      observedFailingTest: state.kind === "repair" ? evidence.observedFailingTest : undefined,
      fileVerified, project: state.project, model: state.model, kind: state.kind,
      ...(toolSequenceVerified && fileVerified ? {} : { reason: explainAgentCheckFailure(evidence, state.kind === "repair" ? "repair" : "linux") })
    };
    await this.ctx.storage.put("agent-check-result-v1", outcome);
    if (outcome.status === "failed") {
      const code = evidence.requestedTools === 0 ? "MODEL_UNAVAILABLE"
        : evidence.finishedLinuxTools === 0 ? "TOOL_MISSING"
          : state.kind === "repair" ? "TEST_FAILED" : "AGENT_FAILURE";
      await this.noteIncident({ source: "agent-check", code, project: state.project });
    }
    return outcome;
  }

  // Workers AI over the AI binding, as an OpenCode provider plugin.
  readonly ai = createAI({ binding: this.env.AI });
  // Files in the object's own storage. `exec` runs JavaScript in a Worker
  // Loader isolate with no network of its own. `git` turns on
  // `workspace.git`, which `codemode:git` uses to clone over HTTPS from the host.
  readonly workspace = new Workspace({
    // SAFETY: DurableObjectStorage has every member DurableObjectStorageLike
    // names; computer declares its own narrower type to avoid depending on
    // workers-types.
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    backends: [
      new CodemodeBackend({
        loader: this.env.LOADER,
        root: "/workspace",
        access: "read-write",
        modules: { "codemode:git": createGitModule({ allowNetwork: true }) }
      })
    ]
  });
  private async noteIncident(event: IncidentObservation): Promise<void> {
    try {
      await this.personalConfig.recordIncident(event);
    } catch {
      // Diagnostics must not turn an otherwise valid tool result into an error.
      console.warn("Incident ledger write unavailable");
    }
  }

  /** Route each project to its own Container, never the shared legacy VM. */
  private async isolatedProject(project: string, sessionID?: string) {
    const scope = sessionID ? await this.ctx.storage.get<ProjectScope>(scopeStorageKey(sessionID)) : undefined;
    if (sessionID) assertScopedTool(scope, { kind: "linux", project });
    const registry = this.env.DEV.getByName("personal");
    await registry.reserveIsolatedProject(project, scope?.repository);
    const dev = this.env.DEV.getByName(projectContainerName(project));
    if (scope?.repository) await dev.prepareRepository(project, scope.repository);
    return dev;
  }

  readonly linuxRunner = {
    run: async (project: string, command: string, sessionID?: string) => {
      try {
        const result = await (await this.isolatedProject(project, sessionID)).run(project, command);
        const incident = observeLinux(result);
        if (incident) await this.noteIncident(incident);
        return result;
      } catch (error) {
        await this.noteIncident({ source: "linux", project, tool: "linux",
          code: classifyAgentFailure(error instanceof Error ? error.message : "") });
        throw error;
      }
    },
    inspect: async (project: string, action: "list" | "read", path: string, sessionID?: string) => {
      try {
        return await (await this.isolatedProject(project, sessionID)).inspect(project, action, path);
      } catch (error) {
        await this.noteIncident({ source: "linux", project, tool: "inspect_linux",
          code: classifyAgentFailure(error instanceof Error ? error.message : "") });
        throw error;
      }
    }
  };

  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) =>
      OpenCodeWorkerd.create({
        // The object's storage, with OpenCode's tables under `opencode_`.
        storage,
        config: { default_agent: "build" },
        // Native OpenRouter discovery is opt-in and only activated when
        // the private Cloudflare Secret is available.
        models: { fetch: true },
        // OpenCode is silent unless given a log writer.
        log: {
          level: "warn",
          emit: (entry) =>
            console.warn(
              `opencode ${entry.level}: ${entry.message}`,
              entry.attributes,
              entry.cause
            )
        },
        plugins: [
          this.ai.plugin,
          openRouterCredentialPlugin(
            async () => (this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY
              || await this.personalConfig.getOpenRouterKey(),
            (connect) => { this.providerConnection.connect = connect; }
          ),
          remoteMcpPlugin(
            () => this.personalConfig.getRemoteMcps(),
            (reload) => { this.mcpLifecycle.reload = reload; }
          ),
          workspacePlugin(this.workspace, {}, this.linuxRunner, this.githubRunner,
            (sessionID, action) => this.enforceSessionScope(sessionID, action),
            (sessionID) => this.sessionRepository(sessionID))
        ]
      }),
    // Low effort: with more, the model sometimes writes its whole answer
    // into its reasoning.
    defaults: {
      model: this.ai(MODEL_ID),
      agent: "build"
    }
  });

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new OpenCodeSessionSockets(
    this.harness,
    (tag) => this.ctx.getWebSockets(tag),
    () => this.isOpenRouterConfigured(),
    (id: string) => this.personalConfig.getSpecialization(id),
    (incident: IncidentObservation) => this.noteIncident(incident),
    (sessionID: string, input: unknown) => this.bindSessionScope(sessionID, input),
    (source: string, target: string, project: string) => this.inheritSessionScope(source, target, project)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened OpenCode. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const personal = env.SETTINGS.getByName("personal");
      const projectRegistry = env.DEV.getByName("personal");
      const readableProject = async (name: string) => {
        const record = await projectRegistry.isolatedProject(name);
        if (!record) return projectRegistry;
        const dev = env.DEV.getByName(projectContainerName(name));
        if (record.repository) await dev.prepareRepository(name, record.repository);
        return dev;
      };
      const settingsOriginAllowed =
        request.headers.get("Origin") === url.origin &&
        request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json");
      if (url.pathname === "/api/session/export") {
        if (request.method !== "GET") return new Response("GET only", { status: 405 });
        const object = url.searchParams.get("object");
        const session = url.searchParams.get("session");
        try {
          validateExportIdentity(object, session);
          const historyJson = await env.OpenCodeAgent.getByName(object!).exportSessionData(session!);
          return sessionExportResponse(session!, JSON.parse(historyJson) as unknown);
        } catch (error) {
          const message = error instanceof Error ? error.message : "No se pudo exportar la sesión";
          return Response.json({ error: message }, { status: 422,
            headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
        }
      }
      if (url.pathname === "/api/settings" && request.method === "GET") {
        const existing = await personal.status();
        return Response.json({
          ...existing,
          openRouterConfigured: existing.openRouterConfigured ||
            Boolean((env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY),
          githubConfigured: existing.githubConfigured ||
            Boolean((env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN)
        }, { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/settings/openrouter/usage" && request.method === "GET") {
        const usage = await personal.openRouterUsage();
        return Response.json({ usage }, { headers: { "Cache-Control": "no-store" } });
      }
      if ((url.pathname === "/api/settings/openrouter" ||
           url.pathname === "/api/settings/github") && request.method === "POST") {
        if (!settingsOriginAllowed) {
          return Response.json({ error: "Solicitud de origen no permitido." }, { status: 403 });
        }
        const raw = await request.text();
        if (raw.length > 1500) return Response.json({ error: "Solicitud demasiado grande." }, { status: 413 });
        const body = JSON.parse(raw) as { key?: string; workspace?: string };
        if (url.pathname.endsWith("/openrouter")) {
          const result = await personal.connectOpenRouter(body.key);
          // Apply to the currently open browser's host. Other hosts receive
          // the credential on their next OpenCode initialization.
          const workspace = body.workspace;
          let applied = false;
          if (workspace && /^[a-f0-9-]{36}$/i.test(workspace)) {
            try {
              const state = await env.OpenCodeAgent.getByName(workspace).refreshOpenRouter();
              applied = state.active;
            } catch {
              // Safe fallback: the next session host initialization connects it.
            }
          }
          return Response.json({ ...result, activeOnCurrentHost: applied },
            { headers: { "Cache-Control": "no-store" } });
        }
        return Response.json(await personal.connectGitHub(body.key),
          { headers: { "Cache-Control": "no-store" } });
      }
      if ((url.pathname === "/api/settings/openrouter" ||
           url.pathname === "/api/settings/github") && request.method === "DELETE") {
        // The UI labels removal as disconnecting from this app; the provider
        // key itself must be revoked upstream to prevent stale stored hosts.
        if (request.headers.get("Origin") !== url.origin) {
          return Response.json({ error: "Origen no permitido." }, { status: 403 });
        }
        if (url.pathname.endsWith("/openrouter")) {
          await personal.disconnectOpenRouter();
        } else {
          await personal.disconnectGitHub();
        }
        return Response.json({ configured: false, revokeAtProvider: true },
          { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/settings/mcp") {
        if (request.method === "GET") {
          return Response.json({ servers: await personal.listPublicMcps() },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST" || request.method === "DELETE") {
          if (!settingsOriginAllowed) return Response.json({ error: "Origin and JSON required" }, { status: 403 });
          const raw = await request.text();
          if (raw.length > 1_800) return Response.json({ error: "Request too large" }, { status: 413 });
          try {
            const body = JSON.parse(raw) as { id?: string; workspace?: string };
            const result = request.method === "POST"
              ? await personal.saveRemoteMcp(body)
              : await personal.removeRemoteMcp(body.id ?? "");
            let live = false;
            if (body.workspace && /^[a-f0-9-]{36}$/i.test(body.workspace)) {
              try {
                live = (await env.OpenCodeAgent.getByName(body.workspace).refreshMcps()).refreshed;
              } catch { /* Next session host initialization picks up settings. */ }
            }
            return Response.json({ ...(result ?? {}), refreshedCurrentHost: live },
              { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Invalid MCP request" },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/api/settings/specializations") {
        if (request.method === "GET") {
          return Response.json({ specializations: await personal.listSpecializations() },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST" || request.method === "DELETE") {
          if (!settingsOriginAllowed) return Response.json({ error: "Origin and JSON required" }, { status: 403 });
          const raw = await request.text();
          if (raw.length > 5_000) return Response.json({ error: "Request too large" }, { status: 413 });
          try {
            const body = JSON.parse(raw) as { id?: string };
            if (request.method === "POST") {
              return Response.json({ specialization: await personal.saveSpecialization(body) },
                { headers: { "Cache-Control": "no-store" } });
            }
            await personal.removeSpecialization(body.id ?? "");
            return Response.json({ removed: true }, { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Invalid specialization" },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/api/settings/repositories") {
        if (request.method === "GET") {
          return Response.json({ repositories: await personal.getAllowedRepositories() },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST" || request.method === "DELETE") {
          if (!settingsOriginAllowed) return Response.json({ error: "Origin and JSON required" }, { status: 403 });
          const raw = await request.text();
          if (raw.length > 600) return Response.json({ error: "Request too large" }, { status: 413 });
          const body = JSON.parse(raw) as { repository?: string };
          try {
            if (request.method === "POST") {
              const result = await personal.authorizeRepository(body.repository);
              return Response.json(result, { headers: { "Cache-Control": "no-store" } });
            }
            await personal.revokeRepository(body.repository);
            return Response.json({ removed: true }, { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Invalid repository" },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/api/dev/g9-selfdev") {
        // This diagnostic initiates real development work and is strictly
        // staging-only, under the existing Cloudflare Access boundary.
        if(url.hostname!=="opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev"){
          return new Response("Not found",{status:404});
        }
        const object=url.searchParams.get("object");
        try{
          validateExportIdentity(object,"ses_root");
          const host=env.OpenCodeAgent.getByName(object!);
          if(request.method==="GET") return Response.json(await host.getG9SelfDev(),
            {headers:{"Cache-Control":"no-store"}});
          if(request.method!=="POST")return new Response("Method not allowed",{status:405});
          if(!settingsOriginAllowed)return Response.json({error:"Se requiere petición JSON autenticada del mismo origen."},{status:403});
          return Response.json(await host.startG9SelfDev(),
            {headers:{"Cache-Control":"no-store"}});
        }catch(error){
          return Response.json({error:error instanceof Error?error.message:"Error verificando G9"},
            {status:422,headers:{"Cache-Control":"no-store"}});
        }
      }
      if (url.pathname === "/api/dev/g8-agent-check") {
        const object = url.searchParams.get("object");
        try {
          validateExportIdentity(object, "ses_root");
          const host = env.OpenCodeAgent.getByName(object!);
          if (request.method === "GET") {
            return Response.json(await host.getG8LiveReview(), { headers: { "Cache-Control": "no-store" } });
          }
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          if (!settingsOriginAllowed) {
            return Response.json({ error: "Origin y JSON obligatorios" }, { status: 403 });
          }
          // A single explicit owner tap authorizes exactly two read-only real
          // model tasks. No user-provided repo, branch, prompt or model.
          return Response.json(await host.startG8LiveReview(), { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Error de prueba G8" },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/isolated-backup-probe" && request.method === "POST") {
        if (url.hostname !== "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" || !settingsOriginAllowed) {
          return Response.json({ error: "Solo disponible en staging con el mismo origen." }, { status: 403 });
        }
        try {
          const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          const result = await checkIsolatedBackup(name => env.DEV.getByName(name), nonce);
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Falló la prueba." },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/repository-import-probe" && request.method === "POST") {
        if (url.hostname !== "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" || !settingsOriginAllowed) {
          return Response.json({ error: "Solo disponible en staging con el mismo origen." }, { status: 403 });
        }
        try {
          const raw = await request.text();
          if (raw.length > 300) throw Error("Solicitud demasiado grande");
          const input = JSON.parse(raw) as { object?: string; session?: string };
          validateExportIdentity(input.object, input.session);
          const repo = await env.OpenCodeAgent.getByName(input.object!).sessionRepository(input.session!);
          const project = "repocheck-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          const dev = env.DEV.getByName(projectContainerName(project));
          const receipt = await dev.prepareRepository(project, repo);
          const listing = await dev.inspect(project, "list", "");
          return Response.json({ receipt, listing }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Falló la importación." },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/isolation-probe" && request.method === "POST") {
        if (url.hostname !== "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" || !settingsOriginAllowed) {
          return Response.json({ error: "Solo disponible en staging con el mismo origen." }, { status: 403 });
        }
        try {
          const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          const result = await checkIsolation(name => env.DEV.getByName(name), nonce);
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Falló la prueba." },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/g8-verify" && request.method === "POST") {
        if (!settingsOriginAllowed) {
          return Response.json({ error: "Se requiere una solicitud autenticada del mismo origen." }, { status: 403 });
        }
        const key = (env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN || await personal.getGitHubKey();
        if (!key) {
          return Response.json({ error: "Primero conecta GitHub en Configuración de OpenCode Cloud." }, { status: 422 });
        }
        try {
          const bridge = new GitHubBridge(key, (input, init) => globalThis.fetch(input, init),
            await personal.getAllowedRepositories());
          const outcome = await verifyG8Proofs(action => bridge.execute(action),
            await personal.getAllowedRepositories());
          return Response.json(outcome, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "G8 verification failed" },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/incidents" && request.method === "GET") {
        return Response.json({ incidents: await personal.listIncidents() },
          { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      }
      if (url.pathname === "/api/dev/agent-check") {
        const body = request.method === "POST" && request.headers.get("Origin") === url.origin &&
          request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")
          ? (await request.json()) as { workspace?: string; model?: string; kind?: string }
          : null;
        const workspace = request.method === "GET" ? url.searchParams.get("workspace") : body?.workspace;
        if (!workspace || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(workspace)) {
          return Response.json({ error: "Se requiere un espacio autenticado válido" }, { status: 403 });
        }
        const host = env.OpenCodeAgent.getByName(workspace);
        if (request.method === "GET") {
          return Response.json(await host.agentCheckStatus(), { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST") {
          return Response.json(await host.startAgentCheck(body?.model, body?.kind), { headers: { "Cache-Control": "no-store" } });
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/api/dev/backups" && request.method === "GET") {
        const isolated = await projectRegistry.listIsolatedProjects();
        const others = await Promise.all(isolated.map(p =>
          env.DEV.getByName(projectContainerName(p.project)).listBackups()));
        return Response.json({ backups: [...await projectRegistry.listBackups(), ...others.flat()] },
          { headers: { "Cache-Control": "no-store" } });
      }
      const durableBackup = url.pathname.match(/^\/api\/dev\/backup\/([a-z][a-z0-9-]{0,39})$/);
      if (durableBackup) {
        const project = durableBackup[1];
        const dev = await readableProject(project);
        if (request.method === "GET") return await dev.downloadSavedBackup(project);
        if (request.method === "POST") {
          if (request.headers.get("Origin") !== url.origin ||
              !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
            return Response.json({ error: "Origen no permitido" }, { status: 403 });
          }
          try {
            const raw = await request.text();
            if (raw.length > 300) return Response.json({ error: "Request too large" }, { status: 413 });
            const args = raw ? JSON.parse(raw) as { sessionRef?: string } : {};
            return Response.json({ backup: await dev.saveBackup(project, args.sessionRef) },
              { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Backup failed" },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        return new Response("Method not allowed", { status: 405 });
      }
      const restoreMatch = url.pathname.match(/^\/api\/dev\/restore\/([a-z][a-z0-9-]{0,39})$/);
      if (restoreMatch) {
        if (request.method !== "POST") return new Response("POST only", { status: 405 });
        if (request.headers.get("Origin") !== url.origin ||
            !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
          return Response.json({ error: "Same-origin JSON required" }, { status: 403 });
        }
        try {
          const raw = await request.text();
          if (raw.length > 300) return Response.json({ error: "Request too large" }, { status: 413 });
          const input = JSON.parse(raw) as { target?: string };
          const source = restoreMatch[1], target = input.target ?? "";
          const sourceDev = await readableProject(source);
          const metadata = (await sourceDev.listBackups()).find(item => item.project === source);
          if (!metadata) throw Error("No hay respaldo guardado");
          const archive = await sourceDev.downloadSavedBackup(source);
          if (!archive.ok) throw Error("No se pudo leer el respaldo");
          const bytes = new Uint8Array(await archive.arrayBuffer());
          await projectRegistry.reserveIsolatedProject(target);
          const targetDev = env.DEV.getByName(projectContainerName(target));
          const restored = await targetDev.restoreExternalBackup(source, target, bytes, metadata.sha256);
          const restoration = { ...restored,
            ...(metadata.sessionRef ? {sessionRef: metadata.sessionRef} : {}),
            ...(metadata.gitBranch ? {gitBranch: metadata.gitBranch} : {}),
            ...(metadata.gitHead ? {gitHead: metadata.gitHead} : {}) };
          return Response.json({ restoration }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Restore failed" },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/projects" && request.method === "GET") {
        const isolated = await projectRegistry.listIsolatedProjects();
        const projects = await Promise.all(isolated.map(p =>
          env.DEV.getByName(projectContainerName(p.project)).listProjects()));
        return Response.json({
          projects: [...await projectRegistry.listProjects(), ...projects.flat()]
        }, { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/dev/status" && request.method === "GET") {
        return Response.json(await env.DEV.getByName("personal").status(), {
          headers: { "Cache-Control": "no-store" }
        });
      }
      const downloadMatch = url.pathname.match(/^\/api\/dev\/download\/([a-z][a-z0-9-]{0,39})$/);
      if (downloadMatch) {
        if (request.method !== "GET") return new Response("GET only", { status: 405 });
        const project = downloadMatch[1];
        const source = url.searchParams.get("source");
        if (source && source !== "github") return archiveError(400, "Fuente de descarga no reconocida.");
        if (source === "github") {
          const object = url.searchParams.get("object");
          const session = url.searchParams.get("session");
          try {
            validateExportIdentity(object, session);
            // Retrieve the remote repository from immutable, server-stored
            // session scope. Never trust the URL or an LLM for repo identity.
            const selected = await env.OpenCodeAgent.getByName(object!).sessionRepository(session!);
            const normalizedProject = selected.split("/")[1].toLowerCase()
              .replace(/[^a-z0-9-]+/g, "-").replace(/-+$/, "").slice(0, 40);
            if (normalizedProject !== project && repositoryProjectSlug(selected) !== project) {
              return archiveError(403, "El repositorio de esta sesión no coincide con el proyecto solicitado.");
            }
            const token = (env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN || await personal.getGitHubKey();
            return githubRepositoryDownload(selected, token || "",
              await personal.getAllowedRepositories());
          } catch (error) {
            return archiveError(422, error instanceof Error ? error.message : "No se pudo identificar el repositorio seleccionado.");
          }
        }
        try {
          const file = await (await readableProject(project)).download(project);
          return await archiveDownloadResponse(project, file, "tar.gz");
        } catch {
          return archiveError(502, "No se pudo preparar el archivo del Container. Revisa que existan archivos locales o descarga desde el repositorio GitHub seleccionado.");
        }
      }
      const previewMatch = url.pathname.match(/^\/api\/dev\/preview\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/);
      if (previewMatch) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("GET only", { status: 405 });
        }
        const project = previewMatch[1];
        const path = previewMatch[2] || "index.html";
        const dev = await readableProject(project);
        const result = await dev.preview(project, path);
        const headers = new Headers(result.headers);
        let responseBody: BodyInit | null = request.method === "HEAD" ? null : result.body;
        if (request.method === "GET" && result.ok &&
            headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
          // In CSP sandbox, a generated page has an opaque origin. With
          // Cloudflare Access its own CSS/JS subrequests may lose cookies.
          // Embed only small assets from this project's dist/ on the server,
          // retaining the opaque-origin sandbox and denying source-tree reads.
          const html = await result.text();
          responseBody = await inlinePreviewAssets(html, path, (assetPath) =>
            dev.preview(project, assetPath));
          headers.delete("Content-Length");
        }
        // A generated application must not inherit the authenticated
        // OpenCode origin or invoke /api/dev/run from its own scripts.
        // CSP sandbox applies even when a preview URL is opened directly.
        headers.set("Content-Security-Policy",
          "sandbox allow-scripts; default-src https: data: blob:; script-src https: 'unsafe-inline' blob: data:; style-src https: 'unsafe-inline'; connect-src https:; img-src https: data: blob:; font-src https: data:; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("Cache-Control", "no-store");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(responseBody, {
          status: result.status,
          headers
        });
      }
      if (url.pathname === "/api/dev/review" && request.method === "POST") {
        if (!settingsOriginAllowed) return Response.json({ error: "Origen no permitido" }, { status: 403 });
        const body = await request.text();
        if (body.length > 300) return Response.json({ error: "Solicitud demasiado grande" }, { status: 413 });
        const { project } = JSON.parse(body) as { project: string };
        if (!await projectRegistry.isolatedProject(project)) {
          const listing = await projectRegistry.inspect(project, "list", "") as {
            entries: { name: string; type: string }[]
          };
          return Response.json({ project, exitCode: 0, stderr: "", truncated: false,
            stdout: "Proyecto anterior: listado de solo lectura; no es un diff Git.\\n" +
              listing.entries.map(item => item.name + (item.type === "directory" ? "/" : "")).join("\\n") },
            { headers: { "Cache-Control": "no-store" } });
        }
        const command = "if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then " +
          "printf 'ARCHIVOS MODIFICADOS\\n'; git status --short --untracked-files=normal; " +
          "printf '\\nRESUMEN DE DIFERENCIAS\\n'; git diff --stat; " +
          "printf '\\nÚLTIMO COMMIT\\n'; git log -1 --format='%h %s'; " +
          "else printf 'Sin repositorio Git: listado actual de archivos (no es un diff).\\n'; " +
          "find . -maxdepth 2 -type f -not -path './node_modules/*' | sort | head -80; fi";
        return Response.json(await (await readableProject(project)).run(project, command),
          { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/dev/run" && request.method === "POST") {
        // Cloudflare Access protects this same-origin endpoint. A third-party
        // website cannot drive the private container with a cross-site POST.
        if (request.headers.get("Origin") !== url.origin ||
            !request.headers.get("Content-Type")?.startsWith("application/json")) {
          return Response.json({ error: "Same-origin JSON request required" }, { status: 403 });
        }
        const body = await request.text();
        if (body.length > 16_000) {
          return Response.json({ error: "Request too large" }, { status: 413 });
        }
        const { project, command } = JSON.parse(body) as { project: string; command: string };
        try {
          if (!await projectRegistry.isolatedProject(project)) await projectRegistry.reserveIsolatedProject(project);
          const result = await (await readableProject(project)).run(project, command);
          const incident = observeLinux(result);
          if (incident) {
            try { await personal.recordIncident(incident); }
            catch { console.warn("Incident ledger write unavailable"); }
          }
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          try {
            await personal.recordIncident({ source: "linux", project, tool: "linux",
              code: classifyAgentFailure(error instanceof Error ? error.message : "") });
          } catch { console.warn("Incident ledger write unavailable"); }
          throw error;
        }
      }
      if (url.pathname === "/api/health") {
        return Response.json(
          {
            status: "ok",
            runtime: "workerd",
            openRouterConfigured: Boolean((env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY) || (await personal.status()).openRouterConfigured,
            githubConfigured: Boolean((env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN) || (await personal.status()).githubConfigured,
            features: {
              durableSessions: true,
              workspaceFiles: true,
              javascriptExec: true,
              gitClone: true,
              linuxShell: Boolean(env.DEV),
              npm: Boolean(env.DEV),
              githubWrite: Boolean((env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN) || (await personal.status()).githubConfigured
            }
          },
          { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }
        );
      }
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("OpenCode playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;

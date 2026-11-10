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
import { remoteMcpPlugin } from "./mcp-plugin";
import { assessAgentToolEvidence, hasUnfinishedAgentCheck, isUnlimitedDevAgentCheck, isAgentCheckModel, explainAgentCheckFailure, isAgentCheckKind, repairSeedCommand, repairIsVerified, REPAIR_SOURCE_BROKEN, REPAIR_TEST } from "./agent-check";
import { inlinePreviewAssets } from "./preview-inline";

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
        const dev = this.env.DEV.getByName("personal");
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
  readonly linuxRunner = {
    run: (project: string, command: string) =>
      this.env.DEV.getByName("personal").run(project, command),
    inspect: (project: string, action: "list" | "read", path: string) =>
      this.env.DEV.getByName("personal").inspect(project, action, path)
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
          workspacePlugin(this.workspace, {}, this.linuxRunner, this.githubRunner)
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
    (id: string) => this.personalConfig.getSpecialization(id)
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
      const settingsOriginAllowed =
        request.headers.get("Origin") === url.origin &&
        request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json");
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
        return Response.json({ backups: await env.DEV.getByName("personal").listBackups() },
          { headers: { "Cache-Control": "no-store" } });
      }
      const durableBackup = url.pathname.match(/^\/api\/dev\/backup\/([a-z][a-z0-9-]{0,39})$/);
      if (durableBackup) {
        const dev = env.DEV.getByName("personal");
        const project = durableBackup[1];
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
          return Response.json({ restoration:
            await env.DEV.getByName("personal").restoreSavedBackup(restoreMatch[1], input.target ?? "")
          }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Restore failed" },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/projects" && request.method === "GET") {
        return Response.json({
          projects: await env.DEV.getByName("personal").listProjects()
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
        const file = await env.DEV.getByName("personal").download(project);
        const headers = new Headers(file.headers);
        headers.set("Content-Type", "application/gzip");
        headers.set("Content-Disposition", 'attachment; filename="' + project + '.tar.gz"');
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Cache-Control", "no-store");
        return new Response(file.body, { status: file.status, headers });
      }
      const previewMatch = url.pathname.match(/^\/api\/dev\/preview\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/);
      if (previewMatch) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("GET only", { status: 405 });
        }
        const project = previewMatch[1];
        const path = previewMatch[2] || "index.html";
        const dev = env.DEV.getByName("personal");
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
        return Response.json(await env.DEV.getByName("personal").run(project, command), {
          headers: { "Cache-Control": "no-store" }
        });
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

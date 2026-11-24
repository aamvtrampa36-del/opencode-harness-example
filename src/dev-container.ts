import { DurableObject } from "cloudflare:workers";
import { MAX_SHELL_OUTPUT, validateCommand, validateProject } from "./dev-guard";
import { captureBoundedOutput } from "./bounded-process-output";
import { PREVIEW_SOURCE, PREVIEW_PORT } from "./preview-server";
import { INSPECT_SOURCE, validateInspectionPath } from "./linux-inspect";
import { TASK_ARTIFACT_SOURCE } from "./task-artifact-source";
import { chunkBackup, joinBackup, sha256Hex, MAX_ARCHIVE_BYTES, type StoredBackup } from "./durable-backup";
import {
  FS_VERIFY_SOURCE,
  normalizeImageRef,
  parseVerifyReport,
  preflightSnapshotSupport,
  type SnapshotPreflightReport,
  type VerifyRestoreResult
} from "./container-verify";
import { drillCreateSnapshot, drillRestoreSameDo, drillCrossRestore, drillCleanup, type DrillHost } from "./container-recovery-do";
import { jointPrepareDrill, jointVerifyCleanupDrill, jointEmergencyCleanupDrill } from "./joint-rollback-do";
import {
  extBackupCreate, extBackupCleanup, extBackupCrossRestore, extBackupDestroyInstance,
  extBackupMissingProbe, extBackupTamperProbe, type ExtBkHost
} from "./external-backup-do";
import { RESTORE_PROJECT_SOURCE } from "./restore-project";
import { GITHUB_IMPORT_SOURCE } from "./github-import-source";
import { githubSourceArchive, sourceReceiptMatches, RAW_TREE_CERTIFICATION } from "./github-import";
import { validateIsolatedRegistration, type IsolatedProject } from "./project-container";
import { assertRecoverableContainer, SNAPSHOT_TTL_MS } from "./snapshot-policy";
import { BUN_RUNTIME_VERSION, commandRequiresBun } from "./dev-runtime";

/**
 * Opt-in Linux computer. There is exactly ONE named instance ("personal")
 * for the account, independent of the number of chat sessions.
 *
 * Its base image is Cloudflare-managed (Node 24 on Debian); it is NOT
 * an OpenCode CLI server, and has NO production credentials.
 *
 * State is saved with Container snapshots, not with ChatGPT or browser state.
 * Container snapshots are a Cloudflare beta; never silently replace an
 * unavailable snapshot with a blank workspace.
 */
/** R2-T06: project-scoped one-shot subprocess supervisor, never a sandbox. */
const LINUX_RUNNER_SOURCE = String.raw`// Runs inside the dedicated project Container; Node 24 is provided by its base image.
// Never enumerate or signal processes outside this command's private process group.
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const command = process.argv[1];
const child = spawn("timeout", ["--signal=TERM", "--kill-after=5s", "180s", "bash", "-lc", command], {
  detached: true, stdio: ["ignore", "pipe", "pipe"]
});
let requestedSignal = null;
let settled = false;
let escalation = null;
let cleanupFailed = false;
function signalGroup(signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 2) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") { cleanupFailed = true; process.stderr.write("[linux runner: group signal failed]\n"); } }
}
// An RPC consumer may close stdout/stderr before the command finishes.
// Unhandled EPIPE crashes the supervisor and can leave its descendants alive.
// Stop only the owned group and drain child streams without buffering them.
let outputBroken = false;
function onForwardError(channel) {
  if (outputBroken) return;
  outputBroken = true;
  cleanupFailed = true;
  child.stdout?.unpipe(process.stdout);
  child.stderr?.unpipe(process.stderr);
  child.stdout?.resume();
  child.stderr?.resume();
  signalGroup("SIGTERM");
  escalation ??= setTimeout(() => signalGroup("SIGKILL"), 5_000);
  if (channel === "stdout" && !process.stderr.destroyed) {
    process.stderr.write("[linux runner: output pipe closed; terminating command group]\n");
  }
}
process.stdout.on("error", () => onForwardError("stdout"));
process.stderr.on("error", () => onForwardError("stderr"));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (settled) return;
    requestedSignal ??= signal;
    signalGroup("SIGTERM");
    escalation ??= setTimeout(() => signalGroup("SIGKILL"), 5_000);
  });
}
const done = stream => new Promise(resolve => {
  if (!stream) return resolve();
  stream.once("end", resolve);
  stream.once("close", resolve);
  stream.once("error", resolve);
});
const completed = Promise.all([done(child.stdout), done(child.stderr)]);
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.once("error", () => { if (!settled) { settled = true; process.exitCode = 125; } });
child.once("exit", (code, signal) => { void (async () => {
  if (settled) return;
  settled = true;
  if (escalation) clearTimeout(escalation);
  // Exit refers to the timeout root, not to every descendant.
  signalGroup("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 250));
  signalGroup("SIGKILL");
  let pipeTimer;
  const drained = await Promise.race([
    completed.then(() => true),
    new Promise(resolve => { pipeTimer = setTimeout(() => resolve(false), 1500); })
  ]);
  if (pipeTimer) clearTimeout(pipeTimer);
  if (!drained) {
    child.stdout.destroy();
    child.stderr.destroy();
    process.stderr.write("[linux runner: open pipes after group cleanup; detached process possible]\n");
  }
  const signalCode = signal ? constants.signals[signal] : undefined;
  const exitCode = cleanupFailed || !drained ? 125
    : requestedSignal ? 128 + constants.signals[requestedSignal]
    : (code ?? (signalCode ? 128 + signalCode : 125));
  process.exitCode = exitCode;
})().catch(() => { process.exitCode = 125; }); });
`;

const INACTIVITY_MS = 15 * 60_000;
const IDLE_MS = 5 * 60_000;
const CHECK_MS = 60_000;
const CHECKPOINT_MS = 2 * 60_000;
const TOKEN_ECONOMIZER_COMMIT = "7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0";
const TOKEN_ECONOMIZER_ROOT = "/workspace/projects/opencode-connectors/token-economizer";
const TOKEN_ECONOMIZER_STATE = "/workspace/projects/opencode-connectors/state";
const TOKEN_ECONOMIZER_RUNNER = `import contextlib, json, os, sys
body = json.load(sys.stdin)
payload = body.get("payload") or {}
transcript = body.get("transcript")
path = payload.get("transcript_path")
if path and isinstance(transcript, str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as stream:
        stream.write(transcript)
try:
    from tokeneconomizer.plugin.hook import run
    with contextlib.redirect_stdout(sys.stderr):
        result = run(payload, os.environ, host_hint="opencode") or {}
    from tokeneconomizer.plugin.paths import secure_root
    secure_root(os.environ)
except Exception:
    result = {}
print(json.dumps(result, ensure_ascii=False))`;
// Shared PREVIEW_PORT selects the new server without destroying persistent Container data.

export type LinuxResult = {
  project: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  persistence: "checkpoint-scheduled";
};

export class DevContainer extends DurableObject<Env> {
  private busy = 0;
  private previewStarting?: Promise<void>;
  private starting?: Promise<NonNullable<DurableObjectState["container"]>>;
  private commandQueue: Promise<void> = Promise.resolve();
  private connectorQueue: Promise<void> = Promise.resolve();

  private async acquireConnectorLock(): Promise<() => void> {
    const previous = this.connectorQueue;
    let release!: () => void;
    this.connectorQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(async()=>{
        const p=await ctx.storage.get<{closeUntil:number}>("pilot-deadline-v1");
        await container.setInactivityTimeout(p?Math.max(1,p.closeUntil-Date.now()):INACTIVITY_MS);
      });
    }
  }

  async configurePilotDeadline(project:string,workUntil:number,closeUntil:number) {
    const now=Date.now();
    if(!/^supervised-[a-f0-9]{16}$/.test(project)||this.ctx.id.name!=="project-v1:"+project||
        !Number.isSafeInteger(workUntil)||workUntil<=now||workUntil>now+900_000||closeUntil!==workUntil+300_000)
      throw Error("PILOT_CONTAINER_DEADLINE_INVALID");
    await this.ctx.storage.transaction(async tx=>{
      const previous=await tx.get<{project:string;workUntil:number;closeUntil:number}>("pilot-deadline-v1");
      if(previous){
        if(previous.project!==project||previous.workUntil!==workUntil||previous.closeUntil!==closeUntil)
          throw Error("PILOT_CONTAINER_DEADLINE_IMMUTABLE");
        return;
      }
      if(this.ctx.container?.running||await tx.get("snapshotId")||await tx.get("lastActivity"))
        throw Error("PILOT_CONTAINER_NOT_FRESH");
      await tx.put("pilot-deadline-v1",{project,workUntil,closeUntil});
    });
    await this.scheduleCheck();
  }
  private async checkPilotWork(){
    const p=await this.ctx.storage.get<{workUntil:number;closeUntil:number}>("pilot-deadline-v1");
    if(p&&(Date.now()>=p.workUntil||await this.ctx.storage.get("pilot-close-requested-v1")))throw Error("PILOT_CONTAINER_WORK_EXPIRED");
    return p;
  }
  private async pilotSignal(limit:number){
    const p=await this.checkPilotWork();
    const ms=p?Math.min(limit,p.workUntil-Date.now()):limit;
    if(ms<=0)throw Error("PILOT_CONTAINER_WORK_EXPIRED");
    return AbortSignal.timeout(ms);
  }
  private async scheduleCheck(){
    const p=await this.ctx.storage.get<{workUntil:number;closeUntil:number}>("pilot-deadline-v1");
    const now=Date.now();
    if(p&&now>=p.closeUntil){
      await this.ctx.storage.put("pilot-close-v1",{status:this.ctx.container?.running?"overdue":"not-running",at:now});
      return;
    }
    await this.ctx.storage.setAlarm(p?Math.min(now+CHECK_MS,now<p.workUntil?p.workUntil:p.closeUntil):now+CHECK_MS);
  }

  private async ensureRunning() {
    await this.checkPilotWork();
    this.starting ??= this.startOrRecover().finally(() => { this.starting = undefined; });
    return await this.starting;
  }

  private async startOrRecover() {
    const container = this.ctx.container;
    if (!container) throw new Error("Linux Container binding is not deployed");
    if (!container.running) {
      const snapshotId = await this.ctx.storage.get<string>("snapshotId");
      const savedAt = await this.ctx.storage.get<number>("savedAt");
      const lastActivity = await this.ctx.storage.get<number>("lastActivity");
      assertRecoverableContainer(snapshotId, savedAt, lastActivity, Date.now());
      const pilot=await this.checkPilotWork();
      container.start({
        ...(snapshotId
          ? { containerSnapshot: { id: snapshotId } }
          : { image: "cloudflare/debian-trixie" }),
        entrypoint: ["sleep", "infinity"],
        enableInternet: !pilot,
        instance: "basic"
      });
      // If snapshot restore fails, fail closed rather than losing project data.
      if (!(await this.ctx.storage.get<number>("lastActivity"))) {
        await this.ctx.storage.put("lastActivity", Date.now());
      }
    }
    const pilot=await this.checkPilotWork();
    await container.setInactivityTimeout(pilot?Math.max(1,pilot.closeUntil-Date.now()):INACTIVITY_MS);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.scheduleCheck();
    }
    return container;
  }

  async status() {
    const savedAt = (await this.ctx.storage.get<number>("savedAt")) ?? null;
    const smoke = await this.ctx.storage.get<unknown>("smokeReportV1");
    return {
      smoke,
      pilotClose: await this.ctx.storage.get("pilot-close-v1") ?? null,
      savedAt,
      snapshotExpiresAt: savedAt ? new Date(savedAt + SNAPSHOT_TTL_MS).toISOString() : null,
      running: this.ctx.container?.running ?? false,
      saved: Boolean(await this.ctx.storage.get<string>("snapshotId")),
      lastActivity: (await this.ctx.storage.get<number>("lastActivity")) ?? null,
      environment: "Debian + Node.js 24",
      instance: "basic",
      shell: "bash",
      git: "install-on-demand",
      bun: `install-on-demand (${BUN_RUNTIME_VERSION})`,
      persistMode: "Cloudflare container snapshots (beta, 30-day TTL)"
    };
  }

  /** Install the pinned, upstream TokenEconomizer Python hook in its own Container. */
  async installTokenEconomizer(): Promise<{ installed: true; commit: string }> {
    const release = await this.acquireConnectorLock();
    try {
      const container = await this.ensureRunning();
      this.busy++;
      try {
        await this.ctx.storage.put("lastActivity", Date.now());
        const script = [
          "set -e",
          "command -v python3 >/dev/null 2>&1 || (apt-get update -qq -o Acquire::Retries=2 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3 ca-certificates)",
          "command -v git >/dev/null 2>&1 || (apt-get update -qq -o Acquire::Retries=2 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates)",
          "mkdir -p /workspace/projects/opencode-connectors",
          `if [ ! -d ${TOKEN_ECONOMIZER_ROOT}/.git ]; then git clone --filter=blob:none --no-checkout https://github.com/microsoft/TokenEconomizer.git ${TOKEN_ECONOMIZER_ROOT}; fi`,
          `git -C ${TOKEN_ECONOMIZER_ROOT} fetch --depth=1 origin ${TOKEN_ECONOMIZER_COMMIT}`,
          `git -C ${TOKEN_ECONOMIZER_ROOT} checkout --detach ${TOKEN_ECONOMIZER_COMMIT}`,
          `test "$(git -C ${TOKEN_ECONOMIZER_ROOT} rev-parse HEAD)" = ${TOKEN_ECONOMIZER_COMMIT}`,
          `mkdir -p ${TOKEN_ECONOMIZER_STATE} /workspace/projects/opencode-connectors/workspaces`
        ].join(" && ");
        const process = await container.exec(["bash", "-lc", script], {
          signal: AbortSignal.timeout(180_000)
        });
        const output = await process.output();
        if (output.exitCode !== 0) {
          throw new Error("No se pudo instalar TokenEconomizer: " +
            new TextDecoder().decode(output.stderr).slice(-500));
        }
        await this.ctx.storage.put("connector:token-economizer:commit", TOKEN_ECONOMIZER_COMMIT);
        return { installed: true, commit: TOKEN_ECONOMIZER_COMMIT };
      } finally {
        this.busy--;
        await this.ctx.storage.put("lastActivity", Date.now());
        await this.scheduleCheck();
      }
    } finally {
      release();
    }
  }

  /** Run one bounded upstream hook; no arbitrary shell or package command is exposed. */
  async runTokenEconomizerHook(project: string, raw: unknown): Promise<unknown> {
    const id = validateProject(project);
    const installed = await this.ctx.storage.get<string>("connector:token-economizer:commit");
    if (installed !== TOKEN_ECONOMIZER_COMMIT) throw new Error("TokenEconomizer aún no está instalado.");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Evento del conector inválido.");
    const input = raw as { payload?: unknown; transcript?: unknown };
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      throw new Error("Carga del conector inválida.");
    }
    const payload = input.payload as Record<string, unknown>;
    const allowedEvents = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);
    if (!allowedEvents.has(String(payload.hook_event_name)) ||
        typeof payload.session_id !== "string" || !/^ses[A-Za-z0-9_]{1,64}$/.test(payload.session_id)) {
      throw new Error("Evento TokenEconomizer no admitido.");
    }
    if (typeof payload.transcript_path === "string" &&
        (input.transcript !== undefined && (typeof input.transcript !== "string" || input.transcript.length > 2_000_000))) {
      throw new Error("La transcripción excede el límite del conector.");
    }
    const release = await this.acquireConnectorLock();
    try {
      const container = await this.ensureRunning();
      this.busy++;
      try {
        await this.ctx.storage.put("lastActivity", Date.now());
        const workspace = `/workspace/projects/opencode-connectors/workspaces/${id}`;
        const path = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
        if (path && !new RegExp(`^/workspace/projects/opencode-connectors/state/opencode-sessions/${payload.session_id}\\.json$`).test(path)) {
          throw new Error("La ruta de transcripción del conector no está permitida.");
        }
        const directory = await container.exec(["mkdir", "-p", workspace]);
        const directoryOutput = await directory.output();
        if (directoryOutput.exitCode !== 0) throw new Error("No se pudo preparar el área del conector.");
        const process = await container.exec(["python3", "-c", TOKEN_ECONOMIZER_RUNNER], {
          cwd: workspace,
          env: {
            PYTHONPATH: TOKEN_ECONOMIZER_ROOT,
            TE_CORE_PATH: TOKEN_ECONOMIZER_ROOT,
            TOKENECONOMIZER_HOME: TOKEN_ECONOMIZER_STATE,
            PYTHONUTF8: "1",
            TE_OPENCODE_MODE: "run",
            TE_MICROSKILLS: "envfacts",
            TE_LOOPGUARD: "off",
            TE_TOOLPRUNE: "off",
            TE_REPOMAP: "off"
          },
          stdin: "pipe",
          signal: AbortSignal.timeout(20_000)
        });
        const writer = process.stdin?.getWriter();
        if (!writer) throw new Error("No se pudo abrir la entrada del hook.");
        await writer.write(new TextEncoder().encode(JSON.stringify({
          payload, transcript: typeof input.transcript === "string" ? input.transcript : undefined
        })));
        await writer.close();
        const output = await process.output();
        if (output.exitCode !== 0) throw new Error(new TextDecoder().decode(output.stderr).slice(-350));
        try { return JSON.parse(new TextDecoder().decode(output.stdout)); }
        catch { return {}; }
      } finally {
        this.busy--;
        await this.ctx.storage.put("lastActivity", Date.now());
        await this.scheduleCheck();
      }
    } finally {
      release();
    }
  }

  /** Durable project inventory; listing never starts the billable Linux VM. */
  async listProjects(): Promise<readonly { name: string; lastUsedAt: number }[]> {
    const rows = (await this.ctx.storage.get<{ name: string; lastUsedAt: number }[]>("projectInventory")) ?? [];
    return rows.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  private async recordProject(name: string): Promise<void> {
    const rows = (await this.ctx.storage.get<{ name: string; lastUsedAt: number }[]>("projectInventory")) ?? [];
    const next = [{ name, lastUsedAt: Date.now() }, ...rows.filter((x) => x.name !== name)];
    await this.ctx.storage.put("projectInventory", next.slice(0, 100));
  }

  /** Registry lives in the existing personal DO; its old data is untouched. */
  async reserveIsolatedProject(project: string, repository?: string): Promise<IsolatedProject> {
    const id = validateProject(project);
    return await this.ctx.storage.transaction(async tx => {
      const key = "isolated-project-v1:" + id;
      const old = await tx.get<IsolatedProject>(key);
      const legacy = (await tx.get<{name: string}[]>("projectInventory")) ?? [];
      if (!old && await tx.get("backup-meta:" + id)) {
        throw Error("Ya existe un respaldo anterior con este nombre; usa otro proyecto");
      }
      const record = validateIsolatedRegistration(legacy, old, {
        project: id, ...(repository ? { repository } : {})
      });
      if (!old) await tx.put(key, record);
      return record;
    });
  }

  async isolatedProject(project: string): Promise<IsolatedProject | undefined> {
    return await this.ctx.storage.get<IsolatedProject>("isolated-project-v1:" + validateProject(project));
  }

  async listIsolatedProjects(): Promise<IsolatedProject[]> {
    const entries = await this.ctx.storage.list<IsolatedProject>({ prefix: "isolated-project-v1:" });
    return [...entries.values()];
  }

  /**
   * Import source into a fresh isolated project only. The Worker uses the
   * owner's GitHub credential; the Container receives only archive bytes.
   * Never overwrites a project, even after an interrupted previous import.
   */
  async prepareRepository(project: string, repository: string, sourceCommit?: string,
    sourceTree?: string): Promise<{
    project: string; repository: string; commit: string; tree?: string;
    files: number; sha256: string;
  }> {
    const id = validateProject(project);
    if (sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(sourceCommit)) {
      throw new Error("Commit de origen inválido");
    }
    if (sourceTree !== undefined && !/^[a-f0-9]{40}$/.test(sourceTree)) {
      throw new Error("Árbol de origen inválido");
    }
    if (sourceTree !== undefined && sourceCommit === undefined) {
      throw new Error("sourceCommit es obligatorio cuando se fija sourceTree");
    }
    const previous = this.commandQueue;
    let release = () => {};
    this.commandQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const settings = this.env.SETTINGS.getByName("personal");
      const allowed = await settings.getAllowedRepositories();
      if (!allowed.some(item => item.toLowerCase() === repository.toLowerCase())) {
        throw Error("El repositorio ya no está autorizado");
      }
      const existing = await this.ctx.storage.get<{
        project: string; repository: string; commit: string; tree?: string;
        files: number; sha256: string; certification?: string
      }>("isolated-repository-v1");
      if (existing) {
        if (existing.project !== id || existing.repository.toLowerCase() !== repository.toLowerCase()) {
          throw Error("El entorno aislado ya pertenece a otro proyecto o repositorio");
        }
        if (sourceCommit && !sourceReceiptMatches(existing, sourceCommit, sourceTree)) {
          throw Error("El proyecto ya está importado desde otro commit o árbol de origen");
        }
        await this.ctx.storage.delete("repo-import-pending-v1");
        await this.recordProject(id);
        return existing;
      }
      const pilot=await this.checkPilotWork();
      const pending = await this.ctx.storage.get<{
        project: string; repository: string; sourceCommit?: string; sourceTree?: string
      }>("repo-import-pending-v1");
      if(pilot&&pending)throw Error("PILOT_IMPORT_EFFECT_UNKNOWN");
      if (pending && (pending.project !== id ||
          pending.repository.toLowerCase() !== repository.toLowerCase() ||
          (pending.sourceCommit ?? "") !== (sourceCommit ?? "") ||
          (pending.sourceTree ?? "") !== (sourceTree ?? ""))) {
        throw Error("Ya hay otra importación pendiente en este Container");
      }
      if (await this.ctx.storage.get("lastActivity") && !pending) {
        throw Error("El Container ya fue utilizado; no se importará sobre su contenido");
      }
      if (!pending) await this.ctx.storage.put("repo-import-pending-v1", {
        project: id, repository, ...(sourceCommit ? { sourceCommit } : {}),
        ...(sourceTree ? { sourceTree } : {})
      });
      const token = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN || await settings.getGitHubKey();
      const http:typeof fetch=pilot?async(input,init)=>fetch(input,{...init,signal:AbortSignal.any([await this.pilotSignal(120_000),...(init?.signal?[init.signal]:[])])}):fetch;
      const source = await githubSourceArchive(repository, token || "", allowed, http, sourceCommit, sourceTree);
      const container = await this.ensureRunning();
      this.busy++;
      try {
        await this.ctx.storage.put("lastActivity", Date.now());
        // Raw Git object hashes use Node only; no Git bootstrap or filters.
        const process = await container.exec(
          ["node", "--input-type=module", "-e", GITHUB_IMPORT_SOURCE, id,
            ...(sourceTree ? [sourceTree] : [])],
          { stdin: source.stream, signal: await this.pilotSignal(120_000) }
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          captureBoundedOutput(process.stdout, 4_096),
          captureBoundedOutput(process.stderr, 1_024),
          process.exitCode
        ]);
        if (exitCode !== 0 || stdout.truncated || stderr.truncated) {
          throw Error("No se pudo importar el repositorio de forma segura");
        }
        const receipt = JSON.parse(stdout.text) as {
          target: string; files: number; sha256: string; tree?: string; certification?: string
        };
        if (!receipt || receipt.target !== id || !Number.isSafeInteger(receipt.files) ||
            receipt.files < 1 || receipt.files > 15_000 ||
            typeof receipt.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw Error("Resultado de importación inválido");
        if (sourceTree !== undefined &&
            (source.tree !== sourceTree || receipt.tree !== sourceTree ||
             receipt.certification !== RAW_TREE_CERTIFICATION)) {
          throw Error("La importación no confirmó el árbol de origen verificado");
        }
        const record = { project: id, repository: source.repo, commit: source.commit,
          ...(sourceTree ? { tree: sourceTree, certification: RAW_TREE_CERTIFICATION } : {}),
          files: receipt.files, sha256: receipt.sha256 };
        await this.ctx.storage.put("isolated-repository-v1", record);
        await this.ctx.storage.delete("repo-import-pending-v1");
        await this.recordProject(id);
        return record;
      } finally {
        this.busy--;
        await this.ctx.storage.put("lastActivity", Date.now());
        await this.scheduleCheck();
      }
    } finally { release(); }
  }

  /** Read-only project inspection for Plan and Review without a shell. */
  async inspect(project: string, action: "list" | "read", relativePath: string): Promise<unknown> {
    const id = validateProject(project);
    if (action !== "list" && action !== "read") throw new Error("Invalid inspection action");
    const target = validateInspectionPath(relativePath, action);
    const container = await this.ensureRunning();
    this.busy++;
    await this.ctx.storage.put("lastActivity", Date.now());
    try {
      const process = await container.exec(["node", "-e", INSPECT_SOURCE, id, action, target],{signal:await this.pilotSignal(30_000)});
      const output = await process.output();
      const decoder = new TextDecoder();
      if (output.exitCode !== 0) {
        throw new Error("No se pudo inspeccionar el archivo: " +
          decoder.decode(output.stderr).slice(-250));
      }
      return JSON.parse(decoder.decode(output.stdout));
    } finally {
      this.busy--;
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.scheduleCheck();
    }
  }

  /**
   * Bounded binary readback for a supervised task's output. The Node process
   * opens a real file descriptor inside that task's isolated Container,
   * rejects symlinks/escapes, and reports the exact Base64 bytes + SHA-256.
   * Unlike inspect(read), it never converts file bytes to lossy UTF-8.
   */
  async readTaskArtifact(project: string, relativePath: string): Promise<unknown> {
    const id = validateProject(project);
    const target = validateInspectionPath(relativePath, "read");
    if (!target.startsWith("dist/")) throw new Error("ARTIFACT_SOURCE_RESTRICTED");
    const container = await this.ensureRunning();
    this.busy++;
    await this.ctx.storage.put("lastActivity", Date.now());
    try {
      const process = await container.exec(["node", "-e", TASK_ARTIFACT_SOURCE, id, target], {
        signal: AbortSignal.timeout(15_000)
      });
      // Drain stdout/stderr in parallel with hard memory caps; do not use
      // output(), which could buffer a compromised Container indefinitely.
      const [stdout, stderr, exitCode] = await Promise.all([
        captureBoundedOutput(process.stdout, 45_000),
        captureBoundedOutput(process.stderr, 1_024),
        process.exitCode
      ]);
      if (exitCode !== 0 || stdout.truncated || stderr.truncated)
        throw new Error("ARTIFACT_READ_UNAVAILABLE");
      // 32 KiB source becomes <=44 KiB Base64 + bounded metadata.
      if (stdout.totalBytes > 45_000) throw new Error("ARTIFACT_SOURCE_TOO_LARGE");
      return JSON.parse(stdout.text);
    } finally {
      this.busy--;
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.scheduleCheck();
    }
  }

  async run(project: string, command: string): Promise<LinuxResult> {
    const id = validateProject(project);
    const cmd = validateCommand(command);
    // Serialize shell commands so snapshotting cannot race two build steps.
    const previous = this.commandQueue;
    let release = () => {};
    this.commandQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (await this.ctx.storage.get("repo-import-pending-v1") ||
          await this.ctx.storage.get("restore-pending-v1")) {
        throw Error("El proyecto está pendiente de importación o restauración");
      }
      return await this.runExclusive(id, cmd);
    } finally {
      release();
    }
  }

  private async runExclusive(project: string, command: string): Promise<LinuxResult> {
    const container = await this.ensureRunning();
    this.busy++;
    await this.ctx.storage.put("lastActivity", Date.now());
    try {
      const pilot=await this.checkPilotWork();
      if(!pilot){await this.ensureGitAvailable(container);
        if(commandRequiresBun(command))await this.ensureBunAvailable(container);}
      else if(commandRequiresBun(command))throw Error("PILOT_OFFLINE_USE_NODE_OR_GITHUB_CI");
      // A Node supervisor owns only this command's private process group.
      // It closes inherited pipes after bounded cleanup; detached descendants
      // remain outside this guarantee (see R2-T06 negative fixtures).
      const wrapper = [
        "mkdir -p /workspace/projects/" + project,
        "cd /workspace/projects/" + project,
        "exec node -e \"$2\" \"$1\""
      ].join(" && ");
      const process = await container.exec(["bash", "-lc", wrapper, "opencode", command, LINUX_RUNNER_SOURCE],pilot?{signal:await this.pilotSignal(180_000)}:undefined);
      // Drain both pipes while the process runs. output() accumulates unbounded
      // stdout/stderr *before* a later slice, which can exhaust the DO isolate.
      const [stdout, stderr, exitCode] = await Promise.all([
        captureBoundedOutput(process.stdout, MAX_SHELL_OUTPUT),
        captureBoundedOutput(process.stderr, MAX_SHELL_OUTPUT),
        process.exitCode
      ]);
      await this.recordProject(project);
      return {
        project,
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        persistence: "checkpoint-scheduled"
      };
    } finally {
      this.busy--;
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.scheduleCheck();
    }
  }


  /** Debian's minimal managed image does not include git by default.
   * Install once on demand and keep it through the existing filesystem
   * checkpoint, rather than adding a second image or build pipeline. */
  private async ensureGitAvailable(container: NonNullable<DurableObjectState["container"]>): Promise<void> {
    const script = "command -v git >/dev/null 2>&1 || " +
      "timeout --signal=TERM 150s bash -lc " +
      "'apt-get update -qq -o Acquire::Retries=2 && " +
      "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates'";
    const handle = await container.exec(["bash", "-lc", script]);
    // Drain both streams before completion: output() buffers unbounded bytes.
    const [, stderr, exitCode] = await Promise.all([
      captureBoundedOutput(handle.stdout, MAX_SHELL_OUTPUT),
      captureBoundedOutput(handle.stderr, MAX_SHELL_OUTPUT),
      handle.exitCode
    ]);
    if (exitCode !== 0) {
      const error = stderr.text.slice(-350);
      throw new Error("Git bootstrap failed in the Linux container: " + (error || "package installation failed"));
    }
  }

  /** Install the pinned Bun version in the isolated Linux container, not the checkout. */
  private async ensureBunAvailable(container: NonNullable<DurableObjectState["container"]>): Promise<void> {
    const script = [
      `if command -v bun >/dev/null 2>&1 && [ "$(bun --version 2>/dev/null)" = "${BUN_RUNTIME_VERSION}" ]; then exit 0; fi`,
      "command -v npm >/dev/null 2>&1 || { echo 'npm is unavailable in the managed Node image' >&2; exit 127; }",
      `timeout --signal=TERM 150s npm install --global --no-audit --no-fund bun@${BUN_RUNTIME_VERSION} >/dev/null`,
      `test "$(bun --version 2>/dev/null)" = "${BUN_RUNTIME_VERSION}"`
    ].join(" && ");
    const process = await container.exec(["bash", "-lc", script], {
      signal: AbortSignal.timeout(160_000)
    });
    // npm stdout is redirected, but stderr may still be large. Drain concurrently.
    const [, , exitCode] = await Promise.all([
      captureBoundedOutput(process.stdout, MAX_SHELL_OUTPUT),
      captureBoundedOutput(process.stderr, MAX_SHELL_OUTPUT),
      process.exitCode
    ]);
    if (exitCode !== 0) {
      throw new Error(`Bun ${BUN_RUNTIME_VERSION} bootstrap failed in the Linux container (exit ${exitCode ?? "unknown"}).`);
    }
  }

  /** Stop admitting work, preserve files via normal snapshot, report state. */
  async closePilotProject(project:string){
    if(this.ctx.id.name!=="project-v1:"+project||!/^supervised-[a-f0-9]{16}$/.test(project))throw Error("PILOT_CONTAINER_SCOPE");
    const p=await this.ctx.storage.get<{project:string;workUntil:number;closeUntil:number}>("pilot-deadline-v1");
    if(!p){if(this.ctx.container?.running||await this.ctx.storage.get("lastActivity"))throw Error("PILOT_CONTAINER_UNTRACKED");
      return {running:false,close:{status:"never-started",at:Date.now()}};}
    if(p.project!==project)throw Error("PILOT_CONTAINER_SCOPE");
    await this.ctx.storage.put("pilot-close-requested-v1",true);
    await this.alarm();
    return {running:this.ctx.container?.running??false,close:await this.ctx.storage.get("pilot-close-v1")??null};
  }
  /** Durable Object alarm: checkpoint then suspend the idle VM. */
  async alarm() {
    const container = this.ctx.container;
    if (!container?.running) {
      if(await this.ctx.storage.get("pilot-deadline-v1"))await this.ctx.storage.put("pilot-close-v1",{status:"not-running",at:Date.now()});
      return;
    }
    if (this.busy > 0) {
      await this.scheduleCheck();
      return;
    }

    const lastActivity = (await this.ctx.storage.get<number>("lastActivity")) ?? 0;
    const savedAt = (await this.ctx.storage.get<number>("savedAt")) ?? 0;
    const pilot=await this.ctx.storage.get<{workUntil:number;closeUntil:number}>("pilot-deadline-v1");
    if(pilot&&Date.now()>=pilot.closeUntil){await this.scheduleCheck();return;}
    const idle = pilot ? Date.now()>=pilot.workUntil||Boolean(await this.ctx.storage.get("pilot-close-requested-v1")) : Date.now()-lastActivity>=IDLE_MS;
    const checkpointDue = lastActivity > savedAt && Date.now() - savedAt >= CHECKPOINT_MS;

    if (idle || checkpointDue) {
      try {
        const snapshot = await container.snapshotContainer({ name: "opencode-workspace" });
        await this.ctx.storage.put({ snapshotId: snapshot.id, savedAt: Date.now() });
      } catch (error) {
        // Never destroy the only unsaved copy of a project.
        console.error("Linux checkpoint failed", error instanceof Error ? error.message : "unknown");
        if(!pilot)await container.setInactivityTimeout(INACTIVITY_MS);
        await this.scheduleCheck();
        return;
      }
    }

    if (idle && this.busy === 0 &&
        (await this.ctx.storage.get<number>("lastActivity")) === lastActivity) {
      await container.destroy("idle");
      if(pilot)await this.ctx.storage.put("pilot-close-v1",{status:container.running?"unconfirmed":"stopped",at:Date.now()});
      if(pilot&&container.running)await this.scheduleCheck();
      return;
    }
    if(!pilot)await container.setInactivityTimeout(INACTIVITY_MS);
    await this.scheduleCheck();
  }

  /** HTTP-only static preview; isolation headers are applied by the Worker. */
  async preview(project: string, relativePath: string): Promise<Response> {
    const id = validateProject(project);
    if (relativePath.includes("\\") || relativePath.split("/").includes("..")) {
      return new Response("Invalid preview path", { status: 400 });
    }
    return this.proxyHttp("/" + id + "/" + relativePath.replace(/^\/+/, ""));
  }

  /** Stream a source backup to the owner without a model or external token. */
  async download(project: string): Promise<Response> {
    const id = validateProject(project);
    return this.proxyHttp("/__archive/" + id);
  }

  /**
   * On-demand, independent source backup stored in Durable Object SQLite.
   * This is NOT a Container snapshot and survives its 30-day expiration.
   * Up to 2 MiB compressed; large projects need an external store.
   */
  async saveBackup(project: string, sessionRef?: string): Promise<StoredBackup> {
    const previous = this.commandQueue;
    let release = () => {};
    this.commandQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await this.saveBackupExclusive(project, sessionRef); }
    finally { release(); }
  }

  private async saveBackupExclusive(project: string, sessionRef?: string): Promise<StoredBackup> {
    if (await this.ctx.storage.get("repo-import-pending-v1") ||
        await this.ctx.storage.get("restore-pending-v1")) {
      throw Error("El proyecto está pendiente de importación o restauración");
    }
    const id = validateProject(project);
    if (sessionRef !== undefined && (typeof sessionRef !== "string" ||
        !/^[a-zA-Z0-9_:-]{1,100}$/.test(sessionRef))) {
      throw new Error("Invalid session reference");
    }
    const archive = await this.download(id);
    if (!archive.ok || !archive.body) throw new Error("No se pudo archivar el proyecto");
    const reader = archive.body.getReader();
    const collected: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ARCHIVE_BYTES) {
          await reader.cancel();
          throw new Error("El proyecto supera 2 MiB comprimidos; usa Descargar y conserva el archivo fuera de Cloudflare.");
        }
        collected.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of collected) { bytes.set(part, offset); offset += part.byteLength; }
    const parts = chunkBackup(bytes);
    // Capture only Git identifiers: no remotes, tokens or .git internals.
    let gitBranch: string | undefined;
    let gitHead: string | undefined;
    try {
      const container = await this.ensureRunning();
      const cmd = 'cd /workspace/projects/' + id +
        ' && printf "%s\\n%s\\n" "$(git branch --show-current 2>/dev/null)" "$(git rev-parse --verify HEAD 2>/dev/null)"';
      const gitResult = await (await container.exec(["bash", "-lc", cmd])).output();
      if (gitResult.exitCode === 0) {
        const [branch, head] = new TextDecoder().decode(gitResult.stdout).trim().split("\n");
        if (branch && branch.length <= 160 && !/[\r\n\0]/.test(branch)) gitBranch = branch;
        if (/^[a-f0-9]{40,64}$/.test(head ?? "")) gitHead = head;
      }
    } catch { /* A source-only project need not be a Git checkout. */ }
    const version = crypto.randomUUID();
    const previous = await this.ctx.storage.get<StoredBackup>("backup-meta:" + id);
    const result: StoredBackup = {
      project: id, version, createdAt: new Date().toISOString(),
      bytes: total, chunks: parts.length, sha256: await sha256Hex(bytes),
      ...(sessionRef ? { sessionRef } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(gitHead ? { gitHead } : {})
    };
    // Versioned writes protect the last good backup if a new save fails.
    for (let i = 0; i < parts.length; i++) {
      await this.ctx.storage.put("backup-data:" + id + ":" + version + ":" + i, parts[i]);
    }
    await this.ctx.storage.put("backup-meta:" + id, result);
    if (previous) {
      for (let i = 0; i < previous.chunks; i++) {
        await this.ctx.storage.delete("backup-data:" + id + ":" + previous.version + ":" + i);
      }
    }
    return result;
  }

  /** Metadata only; this does not start the billable Linux Container. */
  async listBackups(): Promise<StoredBackup[]> {
    const map = await this.ctx.storage.list<StoredBackup>({ prefix: "backup-meta:" });
    return [...map.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Recover source archive from DO storage even if the Container snapshot is gone. */
  async downloadSavedBackup(project: string): Promise<Response> {
    const id = validateProject(project);
    const meta = await this.ctx.storage.get<StoredBackup>("backup-meta:" + id);
    if (!meta) return new Response("No hay respaldo guardado", { status: 404 });
    const parts: Uint8Array[] = [];
    for (let i = 0; i < meta.chunks; i++) {
      const data = await this.ctx.storage.get<Uint8Array>(
        "backup-data:" + id + ":" + meta.version + ":" + i
      );
      if (!data) throw new Error("El respaldo está incompleto");
      parts.push(data);
    }
    const bytes = joinBackup(parts, meta.bytes);
    if (await sha256Hex(bytes) !== meta.sha256) {
      throw new Error("El respaldo no superó la verificación SHA-256");
    }
    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="' + id + '-respaldo.tar.gz"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }

  /** Restore an already verified backup into this separate Container. */
  async restoreExternalBackup(sourceProject: string, targetProject: string, data: Uint8Array, expected: string) {
    const source = validateProject(sourceProject), target = validateProject(targetProject);
    if (source === target || !/^[a-f0-9]{64}$/.test(expected) ||
        data.byteLength > MAX_ARCHIVE_BYTES || await sha256Hex(data) !== expected) {
      throw Error("El respaldo o el destino no son válidos");
    }
    const previous = this.commandQueue;
    let release = () => {};
    this.commandQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const complete = await this.ctx.storage.get<{
        source: string; target: string; archiveSha256: string; files: number; sha256: string; bytes: number
      }>("restore-complete-v1");
      if (complete) {
        if (complete.source !== source || complete.target !== target || complete.archiveSha256 !== expected) {
          throw Error("El destino ya pertenece a otra restauración");
        }
        await this.ctx.storage.delete("restore-pending-v1");
        await this.recordProject(target);
        return complete;
      }
      const pending = await this.ctx.storage.get<{source: string; target: string; hash: string}>("restore-pending-v1");
      if (pending && (pending.source !== source || pending.target !== target || pending.hash !== expected)) {
        throw Error("Ya hay otra restauración pendiente en este Container");
      }
      if (await this.ctx.storage.get("lastActivity") && !pending) {
        throw Error("El Container de destino ya fue utilizado; elige un proyecto nuevo");
      }
      if (!pending) await this.ctx.storage.put("restore-pending-v1", {source, target, hash: expected});
      const container = await this.ensureRunning();
      this.busy++;
      await this.ctx.storage.put("lastActivity", Date.now());
      try {
        const stdin = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(data); controller.close(); }
        });
        const process = await container.exec(
          ["node", "--input-type=module", "-e", RESTORE_PROJECT_SOURCE, source, target], { stdin }
        );
        const result = await process.output();
        if (result.exitCode !== 0) throw Error("Restauración rechazada: " +
          new TextDecoder().decode(result.stderr).slice(-350));
        const receipt = JSON.parse(new TextDecoder().decode(result.stdout)) as {
          source: string; target: string; files: number; sha256: string; bytes: number
        };
        if (receipt.source !== source || receipt.target !== target ||
            !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw Error("Resultado de restauración inválido");
        const complete = { ...receipt, archiveSha256: expected };
        await this.ctx.storage.put("restore-complete-v1", complete);
        await this.recordProject(target);
        await this.ctx.storage.delete("restore-pending-v1");
        return complete;
      } finally {
        this.busy--;
        await this.ctx.storage.put("lastActivity", Date.now());
        await this.scheduleCheck();
      }
    } finally { release(); }
  }

  /**
   * G4: restore a verified independent backup into a NEW project, never overwrite.
   * The backup remains stored in Durable Object SQLite, separate from the VM snapshot.
   */
  async restoreSavedBackup(sourceProject: string, newProject: string): Promise<{
    source: string; target: string; files: number; sha256: string; bytes: number;
    archiveSha256: string; sessionRef?: string; gitBranch?: string; gitHead?: string;
  }> {
    const source = validateProject(sourceProject);
    const target = validateProject(newProject);
    if (source === target) throw new Error("Restore target must be a new project");
    // Serialize against shell writes; never destroy or overwrite an existing project.
    const previous = this.commandQueue;
    let release = () => {};
    this.commandQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const meta = await this.ctx.storage.get<StoredBackup>("backup-meta:" + source);
      if (!meta) throw new Error("No saved independent backup exists");
      const response = await this.downloadSavedBackup(source);
      if (!response.ok) throw new Error("The independent backup cannot be read");
      const data = new Uint8Array(await response.arrayBuffer());
      if (await sha256Hex(data) !== meta.sha256) throw new Error("Backup hash mismatch");
      const container = await this.ensureRunning();
      this.busy++;
      await this.ctx.storage.put("lastActivity", Date.now());
      try {
        const stdin = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(data); controller.close(); }
        });
        const process = await container.exec(["node", "--input-type=module", "-e", RESTORE_PROJECT_SOURCE, source, target], { stdin });
        const output = await process.output();
        const decoder = new TextDecoder();
        if (output.exitCode !== 0) {
          throw new Error("Restore refused: " + decoder.decode(output.stderr).slice(-500));
        }
        const restored = JSON.parse(decoder.decode(output.stdout)) as {
          source: string; target: string; files: number; sha256: string; bytes: number
        };
        if (restored.source !== source || restored.target !== target ||
            !/^[0-9a-f]{64}$/.test(restored.sha256)) throw new Error("Invalid restore receipt");
        await this.recordProject(target);
        return { ...restored, archiveSha256: meta.sha256,
          ...(meta.sessionRef ? { sessionRef: meta.sessionRef } : {}),
          ...(meta.gitBranch ? { gitBranch: meta.gitBranch } : {}),
          ...(meta.gitHead ? { gitHead: meta.gitHead } : {}) };
      } finally {
        this.busy--;
        await this.ctx.storage.put("lastActivity", Date.now());
        await this.scheduleCheck();
      }
    } finally {
      release();
    }
  }

  /**
   * Reproducible, isolated proof that project files survive a backup and
   * restore round trip. A freshly created payload is archived with tar+gzip,
   * the live copy is corrupted, restore happens from the external archive
   * and every SHA-256 anchor plus the machine identity is re-checked. The
   * result carries ok:false on ANY failure; it never synthesizes success.
   */
  async verifyRestore(project: string): Promise<VerifyRestoreResult> {
    const id = validateProject(project);
    const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    // Serialize so the payload cannot be mutated while a checkpoint or shell
    // command is in flight (same ordering as run()).
    const previous = this.commandQueue;
    let release = () => {};
    this.commandQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.verifyRestoreExclusive(id, runId);
    } finally {
      release();
    }
  }

  private async verifyRestoreExclusive(id: string, runId: string): Promise<VerifyRestoreResult> {
    const container = await this.ensureRunning();
    this.busy++;
    await this.ctx.storage.put("lastActivity", Date.now());
    try {
      const info = await container.inspect().catch(() => null);
      const handle = await container.exec(
        ["node", "--input-type=module", "-e", FS_VERIFY_SOURCE],
        {
          env: {
            VERIFY_PROJECT: id,
            VERIFY_ROOT: "/workspace/projects",
            VERIFY_RUN_ID: runId,
            VERIFY_NEGATIVE: "0"
          },
          signal: AbortSignal.timeout(120_000)
        }
      );
      const output = await handle.output();
      const report = parseVerifyReport(new TextDecoder().decode(output.stdout));
      if (!report) {
        throw new Error("La verificación de respaldo no produjo un informe analizable (exitCode=" + output.exitCode + ")");
      }
      return { ...report, exitCode: output.exitCode, containerImage: normalizeImageRef(info?.image) };
    } finally {
      this.busy--;
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.scheduleCheck();
    }
  }

  /**
   * Fail-closed snapshot preflight. The API surface is verifiable anywhere;
   * a real snapshot/restore round trip needs the deployed Worker, so the
   * result always reports liveProof: "pending-deployment" until it has been
   * exercised against the real Container. inspect() exposes the concrete
   * image reference (usually an OCI digest) for rollback bookkeeping.
   */
  async snapshotPreflight(): Promise<SnapshotPreflightReport> {
    const container = this.ctx.container;
    const preflight = preflightSnapshotSupport({
      containerApiAvailable: Boolean(container),
      hasSnapshotContainer: typeof container?.snapshotContainer === "function",
      // snapshotDirectory is not in the committed Container typings, so its
      // presence is probed structurally; its absence does not disable full snapshots.
      hasSnapshotDirectory: typeof (container as { snapshotDirectory?: unknown } | undefined)?.snapshotDirectory === "function"
    });
    let containerImage: string | null = null;
    let inspectError: string | undefined;
    if (container) {
      try {
        const info = await container.inspect();
        containerImage = normalizeImageRef(info?.image);
        if (!containerImage) inspectError = "container.inspect() returned an unusable image reference";
      } catch (error) {
        inspectError = error instanceof Error ? error.message.slice(0, 200) : "container.inspect() failed";
      }
    }
    return {
      ...preflight,
      containerImage,
      ...(inspectError ? { inspectError } : {}),
      snapshotId: (await this.ctx.storage.get<string>("snapshotId")) ?? null,
      savedAt: (await this.ctx.storage.get<number>("savedAt")) ?? null
    };
  }


  /** Explicit Durable Object RPC methods — no dynamic prototype augmentation.
   * Every helper refuses non-disposable projects and serializes mutations.
   */
  async drillCreateSnapshot(project: string) {
    return drillCreateSnapshot(this as unknown as DrillHost, project);
  }
  async drillRestoreSameDo(project: string) {
    return drillRestoreSameDo(this as unknown as DrillHost, project);
  }
  async drillCrossRestore(project: string, snapshotId: string, record: unknown) {
    return drillCrossRestore(this as unknown as DrillHost, project, snapshotId, record);
  }
  async drillCleanup(project: string) {
    return drillCleanup(this as unknown as DrillHost, project);
  }
  /** Joint Worker+Container+DO rollback drill (staging-only, private Workflow). */
  async jointPrepare(nonce: string) {
    return jointPrepareDrill(this as unknown as DrillHost, nonce);
  }
  async jointVerifyCleanup(nonce: string) {
    return jointVerifyCleanupDrill(this as unknown as DrillHost, nonce);
  }
  async jointEmergencyCleanup(nonce: string, reason: string) {
    return jointEmergencyCleanupDrill(this as unknown as DrillHost, nonce, reason);
  }

  /** External R2 backup + cross-restore drill — explicit RPC methods.
   * Every helper refuses non-disposable projects; the bucket is resolved
   * from the staging-only RECOVERY_R2 binding (wrangler.g1.jsonc) and the
   * drill fails closed when it is absent. */
  async extBackupCreate(project: string, runId: string) {
    return extBackupCreate(this as unknown as ExtBkHost, this.env.RECOVERY_R2, project, runId);
  }
  async extBackupDestroyInstance(project: string) {
    return extBackupDestroyInstance(this as unknown as ExtBkHost, project);
  }
  async extBackupCrossRestore(project: string, manifest: unknown, expectedManifestSha256: string) {
    return extBackupCrossRestore(this as unknown as ExtBkHost, this.env.RECOVERY_R2, project, manifest, expectedManifestSha256);
  }
  async extBackupTamperProbe(project: string, runId: string, manifest: unknown) {
    return extBackupTamperProbe(this as unknown as ExtBkHost, this.env.RECOVERY_R2, project, runId, manifest);
  }
  async extBackupMissingProbe(project: string, runId: string) {
    return extBackupMissingProbe(this as unknown as ExtBkHost, this.env.RECOVERY_R2, project, runId);
  }
  async extBackupCleanup(project: string) {
    return extBackupCleanup(this as unknown as ExtBkHost, project);
  }
  private async proxyHttp(path: string): Promise<Response> {
    const container = await this.ensureRunning();
    this.busy++;
    try {
      this.previewStarting ??= this.ensurePreviewService(container).finally(() => {
        this.previewStarting = undefined;
      });
      await this.previewStarting;
      return await container.getTcpPort(PREVIEW_PORT).fetch("http://container" + path, {
        method: "GET",
        // Generating a verified archive on disk can take longer than serving
        // a static page; keep a finite budget without aborting valid tar jobs.
        signal: AbortSignal.timeout(path.startsWith("/__archive/") ? 180_000 : 30_000)
      });
    } finally {
      this.busy--;
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.scheduleCheck();
    }
  }

  private async ensurePreviewService(container: NonNullable<DurableObjectState["container"]>): Promise<void> {
    const port = container.getTcpPort(PREVIEW_PORT);
    const healthy = async () => {
      try {
        const response = await port.fetch("http://container/__health", {
          signal: AbortSignal.timeout(1500)
        });
        await response.body?.cancel();
        return response.ok;
      } catch { return false; }
    };
    if (await healthy()) return;
    await container.exec(["node", "--input-type=module", "-e", PREVIEW_SOURCE]);
    for (let n = 0; n < 40; n++) {
      if (await healthy()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Project preview server did not become ready");
  }
}

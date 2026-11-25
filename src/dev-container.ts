import { DurableObject } from "cloudflare:workers";
import { makePreparationReceipt, preparationReceiptValid, pilotRuntimeMatches, pilotBootDisposition, pilotPinnedImage, validPreparationInput, type PilotPreparationInput, type PilotPreparationReceipt } from "./pilot-preparation";
import { assertSourceScope, assertSourceReceipt, assertImagePolicy, assertLease, assertRuntime, assertExecutionIdentity, type SourceScope, type SourceReceipt, type ImagePolicy, type BootReceipt, type RuntimeObservation, type ExecutionScope, type Lease } from "./metralla-m03-execution-identity";
import {assertContainerAuthority,assertContainerLease,type NormalContainerAuthority} from "./metralla-m08-container-authority";
import { MAX_SHELL_OUTPUT, validateCommand, validateProject, assertLinuxExecutionScope, linuxProjectCwdSource } from "./dev-guard";
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
import { assertRecoverableContainer, checkpointSnapshot, SNAPSHOT_TTL_MS } from "./snapshot-policy";
import { CLOSE_KEY, assertCloseRecord, assertRecoveryCheckpoint, type IdleCloseRecord } from "./metralla-m03-close";
import { BUN_RUNTIME_VERSION, commandRequiresBun } from "./dev-runtime";
import { beginLinuxReceipt, advanceLinuxReceipt, linuxReceiptPage } from "./metralla-m08-native-receipts";
declare const __OPENCODE_RELEASE_SHA__:string;

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
// Only signal processes in this command's private process group.
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const command = process.argv[1];
const child = spawn("timeout", ["--signal=TERM", "--kill-after=5s", "180s", "bash", "-c", command], {
  detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BASH_ENV: "", ENV: "" }
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
// A signal request is not evidence that live members have gone. Inspect only
// process metadata, never signal any PID outside the command's process group.
// Zombies are not running. A different session (setsid) is NOT covered.
function groupObservedInactive() {
  if (!Number.isSafeInteger(child.pid) || child.pid < 2) return false;
  try { process.kill(-child.pid, 0); }
  catch (error) { return error.code === "ESRCH"; }
  try {
    const fs = require("node:fs");
    const entries = fs.readdirSync("/proc");
    if (entries.length > 32768) return false;
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) continue;
      let stat;
      try { stat = fs.readFileSync("/proc/" + entry + "/stat", "utf8"); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; return false; }
      const end = stat.lastIndexOf(") ");
      if (end < 0) return false;
      const fields = stat.slice(end + 2).split(" ");
      if (Number(fields[2]) === child.pid && fields[0] !== "Z" && fields[0] !== "X") return false;
    }
    return true;
  } catch { return false; }
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
  const observeUntil = Date.now() + 1000;
  while (!groupObservedInactive() && Date.now() < observeUntil)
    await new Promise(resolve => setTimeout(resolve, 25));
  if (!groupObservedInactive()) {
    cleanupFailed = true;
    process.stderr.write("[linux runner: process group closure unverified]\n");
  }
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
  /** No exit code or group signal certifies closure of the entire VM/process tree. */
  physicalClosure?: "unverified";
};

export class DevContainer extends DurableObject<Env> {
  private busy = 0;
  private closing = false;
  private readonly pilotContainerOwner=crypto.randomUUID();
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
      if(await tx.get("pilot-close-requested-v1"))throw Error("PILOT_CONTAINER_WORK_EXPIRED");
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
    const p=await this.ctx.storage.get<{project:string;workUntil:number;closeUntil:number}>("pilot-deadline-v1");
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
    const normal=await this.ctx.storage.get<NormalContainerAuthority>("m08-normal-container-v1");
    if(normal){if(now>=normal.closeUntil)return;await this.ctx.storage.setAlarm(Math.min(now+CHECK_MS,now<normal.workUntil?normal.workUntil:normal.closeUntil));return;}
    if(p&&now>=p.closeUntil){
      await this.ctx.storage.put("pilot-close-v1",{status:this.ctx.container?.running?"overdue":"not-running",at:now});
      return;
    }
    await this.ctx.storage.setAlarm(p?Math.min(now+CHECK_MS,now<p.workUntil?p.workUntil:p.closeUntil):now+CHECK_MS);
  }

  /** Exact normal-lane authority, immutable for the lifetime of this project.
   * No automatic generation takeover, restart, or rebind after a lost effect. */
  async bindNormalExecution(input:NormalContainerAuthority){
    assertContainerAuthority(input,this.ctx.id.name,__OPENCODE_RELEASE_SHA__,Date.now());
    const image=pilotPinnedImage((this.ctx.container as unknown as {images?:Record<string,string>})?.images,input.imageDigest);
    await this.ctx.storage.transaction(async tx=>{
      const old=await tx.get<NormalContainerAuthority>("m08-normal-container-v1");
      if(old){if(JSON.stringify(old)!==JSON.stringify(input))throw Error("NORMAL_CONTAINER_AUTHORITY_CONFLICT");return;}
      if(this.ctx.container?.running||await tx.get("lastActivity")||await tx.get("snapshotId")||await tx.get(CLOSE_KEY)||await tx.get("pilot-deadline-v1"))throw Error("NORMAL_CONTAINER_NOT_FRESH");
      await tx.put("m08-normal-container-v1",input);
    });
    return {imageDigest:input.imageDigest,image};
  }
  private async ensureRunning() {
    if(this.closing)throw Error("M03_CLOSE_IN_PROGRESS");
    const pilot=await this.checkPilotWork();
    const normal=await this.ctx.storage.get<NormalContainerAuthority>("m08-normal-container-v1");
    if(normal&&(Date.now()>=normal.workUntil||await this.ctx.storage.get("m08-normal-close-requested-v1")))throw Error("NORMAL_CONTAINER_WORK_EXPIRED");
    const lane=(this.env as Env & {OPENCODE_PILOT_HYBRID_REQUEST_ID?:string}).OPENCODE_PILOT_HYBRID_REQUEST_ID;
    if(lane&&(!(this.env as Env & {OPENCODE_PILOT_AUTHORIZATION?:string}).OPENCODE_PILOT_AUTHORIZATION||!pilot||this.ctx.id.name!=="project-v1:supervised-"+lane))throw Error("PILOT_EXCLUSIVE_CONTAINER");
    const bound=await this.ctx.storage.get<BootReceipt>("m03-execution-boot-v1");
    const closing=await this.ctx.storage.get<IdleCloseRecord>(CLOSE_KEY);
    if(closing && (bound||pilot||this.ctx.container?.running))throw Error("M03_CLOSE_IN_PROGRESS");
    if(this.closing)throw Error("M03_CLOSE_IN_PROGRESS");
    if(bound){
      if(pilot)throw Error("M03_VM_IDENTITY_MISMATCH");
      assertRuntime(bound,await this.observeNormalBoot(bound.project),bound.project,this.configuredNormalImages());
      if(this.closing)throw Error("M03_CLOSE_IN_PROGRESS");
      const container=this.ctx.container;
      if(!container?.running)throw Error("M03_VM_IDENTITY_MISMATCH");
      return container;
    }
    this.starting ??= this.startOrRecover().finally(() => { this.starting = undefined; });
    return await this.starting;
  }

  /** Read-only pre-admission gate. Merely inspect the existing version image
   * map; never start a VM, create a deadline or consume a pilot claim here. */
  async preflightPilotImage(project:string,imageDigest:string):Promise<{imageDigest:string}>{
    const lane=(this.env as Env & {OPENCODE_PILOT_HYBRID_REQUEST_ID?:string}).OPENCODE_PILOT_HYBRID_REQUEST_ID;
    if(!lane||project!=="supervised-"+lane||this.ctx.id.name!=="project-v1:"+project||
       !(this.env as Env & {OPENCODE_PILOT_AUTHORIZATION?:string}).OPENCODE_PILOT_AUTHORIZATION)
      throw Error("PILOT_PREPARATION_SCOPE");
    if(!this.ctx.container||this.ctx.container.running||await this.ctx.storage.get("pilot-close-requested-v1")||
       await this.ctx.storage.get("pilot-boot-v1")||await this.ctx.storage.get("pilot-preparation-intent-v1")||
       await this.ctx.storage.get("pilot-deadline-v1")||await this.ctx.storage.get("snapshotId")||await this.ctx.storage.get("lastActivity"))
      throw Error("PILOT_CONTAINER_NOT_FRESH");
    pilotPinnedImage((this.ctx.container as unknown as {images?:Record<string,string>}).images,imageDigest);
    return {imageDigest};
  }

  private async startOrRecover() {
    const container = this.ctx.container;
    if (!container) throw new Error("Linux Container binding is not deployed");
    const pilot=await this.checkPilotWork();
    const prior=pilot?await this.ctx.storage.get<{owner:string;label:string}>("pilot-boot-v1"):undefined;
    const normal=await this.ctx.storage.get<NormalContainerAuthority>("m08-normal-container-v1");
    if(normal&&(Date.now()>=normal.workUntil||await this.ctx.storage.get("m08-normal-close-requested-v1")))throw Error("NORMAL_CONTAINER_WORK_EXPIRED");
    const normalIntent=normal?await this.ctx.storage.get<{label:string;image:string}>("m08-normal-boot-intent-v1"):undefined;
    if(normal&&normalIntent&&!container.running)throw Error("NORMAL_CONTAINER_LOST_NO_RESTART");
    if(normal&&container.running&&!normalIntent)throw Error("NORMAL_CONTAINER_UNTRACKED");
    if(pilot&&pilotBootDisposition(prior,this.pilotContainerOwner,container.running)==="stop")
      throw Error("PILOT_CONTAINER_LOST_NO_RESTART");
    if (!container.running) {
      const snapshotId = await this.ctx.storage.get<string>("snapshotId");
      const savedAt = await this.ctx.storage.get<number>("savedAt");
      const lastActivity = await this.ctx.storage.get<number>("lastActivity");
      assertRecoverableContainer(snapshotId, savedAt, lastActivity, Date.now());
      const close=await this.ctx.storage.get<IdleCloseRecord>(CLOSE_KEY);
      if(close){
        assertRecoveryCheckpoint(close,this.ctx.id.toString(),snapshotId,savedAt,Date.now());
        // Legacy resume only from the acknowledged, exact persisted checkpoint.
        // Certified boot recovery still requires explicit rebind; never clear its binding here.
        if(pilot||await this.ctx.storage.get("m03-execution-boot-v1"))throw Error("M03_RECOVERY_REBIND_REQUIRED");
        await this.ctx.storage.transaction(async tx=>{
          const current=await tx.get<IdleCloseRecord>(CLOSE_KEY);
          if(JSON.stringify(current)!==JSON.stringify(close))throw Error("M03_CLOSE_EFFECT_UNKNOWN");
          await tx.put("m03-last-close-v1",close);
          await tx.delete(CLOSE_KEY);
        });
      }
      if(this.closing)throw Error("M03_CLOSE_IN_PROGRESS");
      let label:string|undefined;
      let image="cloudflare/debian-trixie";
      const normalLabel=!pilot&&this.ctx.id.name?.startsWith("project-v1:")?crypto.randomUUID():undefined;
      if(normal){
        if(snapshotId||lastActivity||normalIntent||!normalLabel)throw Error("NORMAL_CONTAINER_NOT_FRESH");
        image=pilotPinnedImage((container as unknown as {images?:Record<string,string>}).images,normal.imageDigest);
        await this.ctx.storage.put("m08-normal-boot-intent-v1",{label:normalLabel,image});
        if(Date.now()>=normal.workUntil||await this.ctx.storage.get("m08-normal-close-requested-v1"))throw Error("NORMAL_CONTAINER_WORK_EXPIRED");
      }
      if(pilot){
        const intent=await this.ctx.storage.get<PilotPreparationInput>("pilot-preparation-intent-v1");
        if(!intent||!validPreparationInput(intent)||intent.project!==pilot.project||intent.workUntil!==pilot.workUntil||intent.closeUntil!==pilot.closeUntil)throw Error("PILOT_PREPARATION_SCOPE");
        image=pilotPinnedImage((container as unknown as {images?:Record<string,string>}).images,intent.imageDigest);
        if(snapshotId||lastActivity||prior)throw Error("PILOT_CONTAINER_NOT_FRESH");
        label=crypto.randomUUID();
        // Write ahead: a lost start response must not create a second VM.
        await this.ctx.storage.put("pilot-boot-v1",{owner:this.pilotContainerOwner,label});
        await this.checkPilotWork();
      }
      container.start({
        ...(snapshotId
          ? { containerSnapshot: { id: snapshotId } }
          : { image }),
        entrypoint: ["sleep", "infinity"],
        enableInternet: !pilot&&!normal,
        instance: "basic",
        ...(label?{labels:{pilotboot:label}}:normalLabel?{labels:{m03boot:normalLabel}}:{})
      });
      // If snapshot restore fails, fail closed rather than losing project data.
      if (!(await this.ctx.storage.get<number>("lastActivity"))) {
        await this.ctx.storage.put("lastActivity", Date.now());
      }
    }
    await this.checkPilotWork();
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
    files: number; sha256: string; certification?:string;
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
    if (sourceTree !== undefined && this.ctx.id.name !== "project-v1:" + id) throw Error("M03_SOURCE_SCOPE_MISMATCH");
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
      const pilot=await this.checkPilotWork();
      const normal=await this.ctx.storage.get<NormalContainerAuthority>("m08-normal-container-v1");
      if(normal&&(normal.source.project!==id||normal.source.repository.toLowerCase()!==repository.toLowerCase()||normal.source.commit!==sourceCommit||normal.source.tree!==sourceTree||Date.now()>=normal.workUntil||await this.ctx.storage.get("m08-normal-close-requested-v1")))throw Error("NORMAL_IMPORT_SCOPE");
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
        if (sourceTree !== undefined && sourceCommit !== undefined) {
          assertSourceReceipt({project:id,repository,commit:sourceCommit,tree:sourceTree}, {...existing,tree:existing.tree ?? "",certification:existing.certification ?? ""});
        }
        await this.ctx.storage.delete("repo-import-pending-v1");
        await this.recordProject(id);
        return existing;
      }
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
      const importSignal=async()=>normal?AbortSignal.timeout(Math.max(1,Math.min(120000,normal.workUntil-Date.now()))):this.pilotSignal(120000);
      const http:typeof fetch=pilot||normal?async(input,init)=>{
        if(normal&&Date.now()>=normal.workUntil)throw Error("NORMAL_CONTAINER_WORK_EXPIRED");
        return fetch(input,{...init,signal:AbortSignal.any([await importSignal(),...(init?.signal?[init.signal]:[])])});
      }:fetch;
      const source = await githubSourceArchive(repository, token || "", allowed, http, sourceCommit, sourceTree);
      if (sourceTree !== undefined && sourceCommit !== undefined) {
        assertSourceScope({project:id,repository,commit:sourceCommit,tree:sourceTree},{project:id,repository:source.repo,commit:source.commit,tree:source.tree ?? ""});
      }
      const container = await this.ensureRunning();
      this.busy++;
      try {
        await this.ctx.storage.put("lastActivity", Date.now());
        // For a newly certified normal source, bind the real VM before import.
        const boot = !pilot && sourceTree !== undefined ? await this.captureNormalBoot(id) : undefined;
        // Raw Git object hashes use Node only; no Git bootstrap or filters.
        const process = await container.exec(
          ["node", "--input-type=module", "-e", GITHUB_IMPORT_SOURCE, id,
            ...(sourceTree ? [sourceTree] : [])],
          { stdin: source.stream, signal: await importSignal() }
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
        if (boot) {
          assertRuntime(boot, await this.observeNormalBoot(id), id, this.configuredNormalImages());
          await this.ctx.storage.transaction(async tx => {
            if (await tx.get("m03-execution-boot-v1")) throw Error("M03_BOOT_ALREADY_BOUND");
            await tx.put("m03-execution-boot-v1", boot);
            await tx.put("isolated-repository-v1", record);
          });
        } else await this.ctx.storage.put("isolated-repository-v1", record);
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
    const id = assertLinuxExecutionScope(this.ctx.id.name, project);
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
      if(await this.ctx.storage.get("m03-execution-boot-v1"))throw Error("M03_FENCED_EXECUTION_REQUIRED");
      return await this.runExclusive(id, cmd);
    } finally {
      release();
    }
  }

  /** Existing image references only. Managed tags are not digest attestations. */
  private configuredNormalImages(): string[] {
    const images=(this.ctx.container as unknown as {images?:Record<string,string>}|undefined)?.images;
    return ["cloudflare/debian-trixie", ...Object.values(images ?? {}).filter(x=>typeof x==="string")];
  }

  /** Read the running VM; do not call ensureRunning or recreate a missing boot. */
  private async observeNormalBoot(project:string):Promise<RuntimeObservation>{
    const container=this.ctx.container;
    if(this.ctx.id.name!=="project-v1:"+project||!container?.running)throw Error("M03_VM_IDENTITY_MISMATCH");
    const before=await container.inspect() as unknown as {image?:unknown;labels?:Record<string,unknown>};
    if(typeof before?.image!=="string"||typeof before.labels?.m03boot!=="string")throw Error("M03_VM_IDENTITY_MISMATCH");
    const proc=await container.exec(["node","-e",
      "const fs=require('node:fs');process.stdout.write(fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim())"
    ],{signal:AbortSignal.timeout(15000)});
    const [out,err,exit]=await Promise.all([captureBoundedOutput(proc.stdout,128),captureBoundedOutput(proc.stderr,128),proc.exitCode]);
    const after=await container.inspect() as unknown as {image?:unknown;labels?:Record<string,unknown>};
    if(exit!==0||out.truncated||err.truncated||!container.running||after?.image!==before.image||after?.labels?.m03boot!==before.labels.m03boot||
       !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(out.text))throw Error("M03_VM_IDENTITY_MISMATCH");
    return {project,objectId:this.ctx.id.toString(),running:true,bootLabel:before.labels.m03boot,bootId:out.text,imageReference:before.image};
  }

  private async captureNormalBoot(project:string):Promise<BootReceipt>{
    const observation=await this.observeNormalBoot(project);
    const normal=await this.ctx.storage.get<NormalContainerAuthority>("m08-normal-container-v1");
    const intent=await this.ctx.storage.get<{label:string;image:string}>("m08-normal-boot-intent-v1");
    if(normal&&(!intent||intent.label!==observation.bootLabel||intent.image!==observation.imageReference))throw Error("NORMAL_BOOT_INTENT_MISMATCH");
    const image:ImagePolicy=normal?{kind:"pinned",reference:intent!.image,digest:normal.imageDigest}:{kind:"reference",reference:"cloudflare/debian-trixie"};
    assertImagePolicy(image,this.configuredNormalImages());
    const boot:BootReceipt={project,objectId:this.ctx.id.toString(),bootLabel:observation.bootLabel,bootId:observation.bootId,image};
    assertRuntime(boot,observation,project,this.configuredNormalImages());
    return boot;
  }

  /** Server-only handoff; the durable source and boot are not supplied by a model.
   * The supervisor's existing admission journal must fence the operation before
   * passing a fresh slot observation. This RPC does not mint or renew leases. */
  async executionBoot(source:SourceScope):Promise<BootReceipt>{
    if(this.ctx.id.name!=="project-v1:"+source.project)throw Error("M03_SOURCE_SCOPE_MISMATCH");
    const receipt=await this.ctx.storage.get<SourceReceipt>("isolated-repository-v1");
    if(!receipt)throw Error("M03_SOURCE_UNCERTIFIED");
    assertSourceReceipt(source,receipt);
    const boot=await this.ctx.storage.get<BootReceipt>("m03-execution-boot-v1");
    if(!boot)throw Error("M03_VM_IDENTITY_MISMATCH");
    assertRuntime(boot,await this.observeNormalBoot(source.project),source.project,this.configuredNormalImages());
    return boot;
  }

  /** Explicit fenced normal-lane command path. Existing unscoped legacy Linux
   * is not upgraded by guessing identity. No implicit start or bootstrap here. */
  async runFenced(scope:ExecutionScope,currentLease:Lease,command:string,callId?:string,releaseSha?:string):Promise<LinuxResult>{
    if(this.closing||await this.ctx.storage.get(CLOSE_KEY))throw Error("M03_CLOSE_IN_PROGRESS");
    const id=assertLinuxExecutionScope(this.ctx.id.name,scope.source.project);
    const cmd=validateCommand(command);
    assertLease(scope.lease,currentLease,id,Date.now());
    const previous=this.commandQueue;
    let release=()=>{};
    this.commandQueue=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try {
      if(await this.ctx.storage.get("repo-import-pending-v1")||await this.ctx.storage.get("restore-pending-v1"))
        throw Error("M03_SOURCE_UNCERTIFIED");
      const authority=await this.ctx.storage.get<NormalContainerAuthority>("m08-normal-container-v1");
      if(authority){assertContainerLease(authority,scope.lease,scope.source,releaseSha,Date.now());}
      const receipt=await this.ctx.storage.get<SourceReceipt>("isolated-repository-v1");
      const boot=await this.ctx.storage.get<BootReceipt>("m03-execution-boot-v1");
      if(!receipt||!boot)throw Error("M03_VM_IDENTITY_MISMATCH");
      assertSourceReceipt(scope.source,receipt);
      assertLease(scope.lease,currentLease,id,Date.now());
      const observed=await this.observeNormalBoot(id);
      if(this.closing||await this.ctx.storage.get(CLOSE_KEY))throw Error("M03_CLOSE_IN_PROGRESS");
      assertRuntime(boot,observed,id,this.configuredNormalImages());
      assertExecutionIdentity(scope,receipt,observed,currentLease,this.configuredNormalImages(),Date.now());
      const container=this.ctx.container;
      if(!container?.running)throw Error("M03_VM_IDENTITY_MISMATCH");
      if(!authority||typeof releaseSha!=="string"||releaseSha!==__OPENCODE_RELEASE_SHA__||!callId)throw Error("LINUX_RECEIPT_SCOPE");
      const commandHash=await sha256Hex(new TextEncoder().encode(cmd));
      const seq=await this.ctx.storage.transaction(tx=>beginLinuxReceipt(tx,scope,callId,releaseSha,commandHash));
      const observe=(event:Parameters<typeof advanceLinuxReceipt>[3])=>this.ctx.storage.transaction(tx=>advanceLinuxReceipt(tx,seq,callId,event));
      try{return await this.runExclusive(id,cmd,container,async()=>{
        assertExecutionIdentity(scope,receipt,await this.observeNormalBoot(id),currentLease,this.configuredNormalImages(),Date.now());
        assertContainerLease(authority!,scope.lease,scope.source,releaseSha,Date.now());
        if(await this.ctx.storage.get("m08-normal-close-requested-v1"))throw Error("NORMAL_CONTAINER_WORK_EXPIRED");
        const remaining=currentLease.expiresAt-Date.now();
        if(remaining<=0)throw Error("M03_LEASE_FENCED");
        return AbortSignal.timeout(Math.min(remaining,180000));
      },observe);}catch(e){await observe({kind:"unknown"}).catch(()=>{});throw e;}
    } finally {release();}
  }

  private async runExclusive(project: string, command: string, existing?:NonNullable<DurableObjectState["container"]>, fencedSignal?:()=>Promise<AbortSignal>,observe?:(event:Parameters<typeof advanceLinuxReceipt>[3])=>Promise<void>): Promise<LinuxResult> {
    const container = existing ?? await this.ensureRunning();
    if(this.closing)throw Error("M03_CLOSE_IN_PROGRESS");
    this.busy++;
    await this.ctx.storage.put("lastActivity", Date.now());
    try {
      const pilot=await this.checkPilotWork();
      if(!pilot&&!fencedSignal){await this.ensureGitAvailable(container);
        if(commandRequiresBun(command))await this.ensureBunAvailable(container);}
      else if(pilot&&commandRequiresBun(command))throw Error("PILOT_OFFLINE_USE_NODE_OR_GITHUB_CI");
      // A Node supervisor owns only this command's private process group.
      // It closes inherited pipes after bounded cleanup; detached descendants
      // remain outside this guarantee (see R2-T06 negative fixtures).
      const process = await container.exec(["node", "-e",
        linuxProjectCwdSource() + "\n" + LINUX_RUNNER_SOURCE, command, project],
        fencedSignal?{signal:await fencedSignal()}:pilot?{signal:await this.pilotSignal(180_000)}:undefined);
      if(observe)await observe({kind:"accepted"});
      // Drain both pipes while the process runs. output() accumulates unbounded
      // stdout/stderr *before* a later slice, which can exhaust the DO isolate.
      const [stdout, stderr, exitCode] = await Promise.all([
        captureBoundedOutput(process.stdout, MAX_SHELL_OUTPUT),
        captureBoundedOutput(process.stderr, MAX_SHELL_OUTPUT),
        process.exitCode
      ]);
      if(observe)await observe({kind:"exited",exitCode,truncated:stdout.truncated||stderr.truncated});
      await this.recordProject(project);
      return {
        project,
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        physicalClosure: "unverified",
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

  /** Only the supervisor's typed RPC uses this path. No SDK/model calls. */
  async preparePilotProject(input:PilotPreparationInput):Promise<PilotPreparationReceipt>{
    const lane=(this.env as Env & {OPENCODE_PILOT_HYBRID_REQUEST_ID?:string}).OPENCODE_PILOT_HYBRID_REQUEST_ID;
    if(!validPreparationInput(input)||lane!==input.requestId||this.ctx.id.name!=="project-v1:"+input.project||
        Date.now()>=input.workUntil)throw Error("PILOT_PREPARATION_SCOPE");
    await this.preflightPilotImage(input.project,input.imageDigest);
    await this.ctx.storage.transaction(async tx=>{
      if(await tx.get("pilot-preparation-intent-v1")||await tx.get("pilot-close-requested-v1"))throw Error("PILOT_PREPARATION_NO_REPLAY");
      await tx.put("pilot-preparation-intent-v1",input);
    });
    this.busy++;
    try{
      await this.configurePilotDeadline(input.project,input.workUntil,input.closeUntil);
      const source=await this.prepareRepository(input.project,input.repository,input.sourceCommit,input.sourceTree);
      if(source.commit!==input.sourceCommit||source.tree!==input.sourceTree||source.certification!==RAW_TREE_CERTIFICATION||
         source.repository!==input.repository||source.project!==input.project)throw Error("PILOT_SOURCE_UNCERTIFIED");
      const boot=await this.ctx.storage.get<{owner:string;label:string}>("pilot-boot-v1");
      if(!boot||boot.owner!==this.pilotContainerOwner)throw Error("PILOT_CONTAINER_LOST_NO_RESTART");
      const runtime=await this.pilotRuntimeProbe(boot.label,input.imageDigest);
      const receipt=await makePreparationReceipt({schema:"pilot-preparation-v1",input,
        containerObject:this.ctx.id.toString(),containerOwner:this.pilotContainerOwner,bootLabel:boot.label,
        bootId:runtime.bootId,imageDigest:input.imageDigest,nodeVersion:runtime.nodeVersion,os:"debian-trixie",
        sourceDigest:source.sha256,sourceFiles:source.files,preparedAt:Date.now()});
      if(!await preparationReceiptValid(receipt,input))throw Error("PILOT_PREPARATION_INVALID");
      await this.ctx.storage.transaction(async tx=>{
        if(await tx.get("pilot-close-requested-v1")||await tx.get("pilot-preparation-v1")||Date.now()>=input.workUntil)
          throw Error("PILOT_PREPARATION_FENCED");
        await tx.put("pilot-preparation-v1",receipt);
      });
      return receipt;
    }finally{this.busy--;await this.scheduleCheck();}
  }

  private async pilotRuntimeProbe(label:string,image:string):Promise<{bootId:string;nodeVersion:string}>{
    const container=this.ctx.container;
    const signal=await this.pilotSignal(15000);
    const pinned=pilotPinnedImage((container as unknown as {images?:Record<string,string>}|undefined)?.images,image);
    const matches=(info:unknown)=>pilotRuntimeMatches(info,label,image)&&(info as {image?:unknown}|null)?.image===pinned;
    if(!container?.running||!matches(await container.inspect()))
      throw Error("PILOT_CONTAINER_IDENTITY_MISMATCH");
    const proc=await container.exec(["node","-e",
      "const fs=require('node:fs'),cp=require('node:child_process');const os=fs.readFileSync('/etc/os-release','utf8');if(!/^ID=debian$/m.test(os)||!/^VERSION_CODENAME=trixie$/m.test(os)||process.versions.node.split('.')[0]!=='24'||cp.spawnSync('/bin/bash',['-c','exit 0']).status!==0)process.exit(2);console.log(JSON.stringify({bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),nodeVersion:process.versions.node}))"
      ],{signal});
    const [stdout,stderr,exitCode]=await Promise.all([captureBoundedOutput(proc.stdout,1024),
      captureBoundedOutput(proc.stderr,1024),proc.exitCode]);
    if(exitCode!==0||stdout.truncated||stderr.truncated||!container.running||
        !matches(await container.inspect()))throw Error("PILOT_RUNTIME_INCOMPATIBLE");
    const runtime=JSON.parse(stdout.text) as {bootId:string;nodeVersion:string};
    await this.checkPilotWork();
    return runtime;
  }

  /** Recheck the actual running VM; never invoke ensureRunning on this route. */
  async assertPilotPreparation(receipt:PilotPreparationReceipt):Promise<boolean>{
    const stored=await this.ctx.storage.get<PilotPreparationReceipt>("pilot-preparation-v1");
    if(!stored||receipt.digest!==stored.digest||receipt.containerObject!==this.ctx.id.toString()||
       receipt.containerOwner!==this.pilotContainerOwner||!await preparationReceiptValid(receipt,stored.input)||
       !await this.checkPilotWork())return false;
    this.busy++;
    try{
      const r=await this.pilotRuntimeProbe(receipt.bootLabel,receipt.imageDigest);
      return r.bootId===receipt.bootId&&r.nodeVersion===receipt.nodeVersion&&
        !await this.ctx.storage.get("pilot-close-requested-v1");
    }finally{this.busy--;}
  }

  async readNativeLinuxReceipts(project:string,releaseSha:string,after:string|null){
    if(this.ctx.id.name!=="project-v1:"+project||releaseSha!==__OPENCODE_RELEASE_SHA__)throw Error("LINUX_RECEIPT_SCOPE");
    return linuxReceiptPage(this.ctx.storage,project,releaseSha,after);
  }

  /** Internal project-scoped readback for the supervisor; never a native closure attestation. */
  async readCloseReceipt(project:string):Promise<IdleCloseRecord|null>{
    const id=validateProject(project);
    if(this.ctx.id.name!=="project-v1:"+id)throw Error("M03_CLOSE_SCOPE_MISMATCH");
    const r=await this.ctx.storage.get<IdleCloseRecord>(CLOSE_KEY);
    if(!r)return null;
    assertCloseRecord(r,this.ctx.id.toString());
    return r;
  }

  /** Stop admitting work, preserve files via normal snapshot, report state. */
  async requestNormalClose(project:string,generation:number,releaseSha:string){
    const normal=await this.ctx.storage.get<NormalContainerAuthority>("m08-normal-container-v1");
    if(!normal||normal.source.project!==project||this.ctx.id.name!=="project-v1:"+project||normal.generation!==generation||normal.releaseSha!==releaseSha||releaseSha!==__OPENCODE_RELEASE_SHA__||Date.now()>=normal.closeUntil)throw Error("NORMAL_CLOSE_SCOPE");
    await this.ctx.storage.put("m08-normal-close-requested-v1",true);
    await this.alarm();
    return {requested:true,physicalClosureVerified:false,receipt:await this.readCloseReceipt(project)};
  }

  async closePilotProject(project:string){
    if(this.ctx.id.name!=="project-v1:"+project||!/^supervised-[a-f0-9]{16}$/.test(project))throw Error("PILOT_CONTAINER_SCOPE");
    await this.ctx.storage.put("pilot-close-requested-v1",true);
    const p=await this.ctx.storage.get<{project:string;workUntil:number;closeUntil:number}>("pilot-deadline-v1");
    if(!p){if(this.ctx.container?.running||await this.ctx.storage.get("lastActivity"))throw Error("PILOT_CONTAINER_UNTRACKED");
      return {running:false,close:{status:"never-started",at:Date.now()}};}
    if(p.project!==project)throw Error("PILOT_CONTAINER_SCOPE");
    await this.alarm();
    return {running:this.ctx.container?.running??false,close:await this.ctx.storage.get("pilot-close-v1")??null};
  }
  /** Durable Object alarm: checkpoint then suspend the idle VM.
   * Single writer in the project DO. Durable intent precedes destruction;
   * restart/lost reply never automatically repeat the effect. */
  async alarm() {
    if(this.closing||this.busy>0||this.starting){await this.scheduleCheck();return;}
    this.closing=true;
    try {await this.checkpointAndClose();} finally {this.closing=false;}
  }

  private async checkpointAndClose(){
    const container=this.ctx.container;
    const prior=await this.ctx.storage.get<IdleCloseRecord>(CLOSE_KEY);
    const pilot=await this.ctx.storage.get<{project:string;workUntil:number;closeUntil:number}>("pilot-deadline-v1");
    if(prior){
      assertCloseRecord(prior,this.ctx.id.toString());
      // Neither running=false nor a returned destroy RPC proves native termination.
      if(pilot)await this.ctx.storage.put("pilot-close-v1",{status:"unconfirmed",at:Date.now()});
      return;
    }
    if(!container?.running){
      if(pilot)await this.ctx.storage.put("pilot-close-v1",{status:"not-running",at:Date.now()});
      return;
    }
    if(this.busy>0||this.starting){await this.scheduleCheck();return;}
    const lastActivity=(await this.ctx.storage.get<number>("lastActivity"))??0;
    const savedAt=(await this.ctx.storage.get<number>("savedAt"))??0;
    if(pilot&&Date.now()>=pilot.closeUntil){await this.scheduleCheck();return;}
    const normal=await this.ctx.storage.get<NormalContainerAuthority>("m08-normal-container-v1");
    if(normal&&Date.now()>=normal.closeUntil)return;
    const idle=pilot?Date.now()>=pilot.workUntil||Boolean(await this.ctx.storage.get("pilot-close-requested-v1")):normal?Date.now()>=normal.workUntil||Boolean(await this.ctx.storage.get("m08-normal-close-requested-v1")):Date.now()-lastActivity>=IDLE_MS;
    const checkpointDue=lastActivity>savedAt&&Date.now()-savedAt>=CHECKPOINT_MS;
    if(!idle&&!checkpointDue){if(!pilot)await container.setInactivityTimeout(INACTIVITY_MS);await this.scheduleCheck();return;}
    const bound=await this.ctx.storage.get<BootReceipt>("m03-execution-boot-v1");
    const pilotBoot=pilot?await this.ctx.storage.get<PilotPreparationReceipt>("pilot-preparation-v1"):undefined;
    const identity=async()=>{
      if(bound){
        const observation=await this.observeNormalBoot(bound.project);
        assertRuntime(bound,observation,bound.project,this.configuredNormalImages());
        return JSON.stringify({objectId:bound.objectId,boot:bound.bootId,label:bound.bootLabel,image:observation.imageReference});
      }
      if(pilot){
        if(!pilotBoot||pilotBoot.containerObject!==this.ctx.id.toString()||
           pilotBoot.input.project!==pilot.project||this.ctx.id.name!=="project-v1:"+pilot.project)
          throw Error("M03_CLOSE_IDENTITY_MISMATCH");
        const pinned=pilotPinnedImage((container as unknown as {images?:Record<string,string>}).images,pilotBoot.imageDigest);
        const matches=(info:unknown)=>pilotRuntimeMatches(info,pilotBoot.bootLabel,pilotBoot.imageDigest)&&
          (info as {image?:unknown}|null)?.image===pinned;
        if(!container.running||!matches(await container.inspect()))throw Error("M03_CLOSE_IDENTITY_MISMATCH");
        const remaining=pilot.closeUntil-Date.now();
        if(remaining<=0)throw Error("M03_CLOSE_FENCED");
        const proc=await container.exec(["node","-e","process.stdout.write(require('node:fs').readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim())"],
          {signal:AbortSignal.timeout(Math.min(remaining,15000))});
        const [out,err,exit]=await Promise.all([captureBoundedOutput(proc.stdout,128),captureBoundedOutput(proc.stderr,128),proc.exitCode]);
        if(exit!==0||out.truncated||err.truncated||out.text!==pilotBoot.bootId||!container.running||
           !matches(await container.inspect()))throw Error("M03_CLOSE_IDENTITY_MISMATCH");
        return JSON.stringify({objectId:pilotBoot.containerObject,boot:out.text,label:pilotBoot.bootLabel,image:pinned});
      }
      // Legacy workspace: never claim digest or boot attestation from a tag.
      const info=await container.inspect();
      const image=normalizeImageRef(info?.image);
      if(!image)throw Error("M03_CLOSE_IDENTITY_MISMATCH");
      return JSON.stringify({objectId:this.ctx.id.toString(),image,legacy:true});
    };
    try {
      const before=await identity();
      const snapshot=await checkpointSnapshot({
        now:Date.now,
        snapshot:()=>container.snapshotContainer({name:"opencode-workspace"}),
        persist:async value=>{
          // Do not replace a known checkpoint with a snapshot of a changed VM.
          if(!container.running||await identity()!==before||this.busy!==0||
             ((await this.ctx.storage.get<number>("lastActivity"))??0)!==lastActivity)
            throw Error("M03_SNAPSHOT_IDENTITY_CHANGED");
          await this.ctx.storage.put(value);
        },
        readback:async()=>({snapshotId:await this.ctx.storage.get("snapshotId"),savedAt:await this.ctx.storage.get("savedAt")})
      });
      if(idle&&this.busy===0&&!this.starting&&container.running&&
         ((await this.ctx.storage.get<number>("lastActivity"))??0)===lastActivity&&
         await identity()===before&&(!pilot||Date.now()<pilot.closeUntil)){
        const intent:IdleCloseRecord={operation:crypto.randomUUID(),objectId:this.ctx.id.toString(),identity:before,
          activity:lastActivity,snapshot,phase:"destroy_requested"};
        await this.ctx.storage.transaction(async tx=>{
          if(await tx.get(CLOSE_KEY)||((await tx.get<number>("lastActivity"))??0)!==lastActivity||
             await tx.get("snapshotId")!==snapshot.snapshotId||await tx.get("savedAt")!==snapshot.savedAt)
            throw Error("M03_CLOSE_FENCED");
          await tx.put(CLOSE_KEY,intent);
        });
        const recorded=await this.ctx.storage.get<IdleCloseRecord>(CLOSE_KEY);
        if(JSON.stringify(recorded)!==JSON.stringify(intent)||this.busy!==0||this.starting||
           !container.running||await identity()!==before|| (pilot&&Date.now()>=pilot.closeUntil))
          throw Error("M03_CLOSE_FENCED");
        await container.destroy("idle");
        // A lost reply leaves the original durable intent; never issue destroy again.
        await this.ctx.storage.put(CLOSE_KEY,{...intent,phase:"destroy_acknowledged"});
        if(pilot)await this.ctx.storage.put("pilot-close-v1",{status:"unconfirmed",at:Date.now()});
        return;
      }
    }catch{
      // Preserve the unsaved copy and previous checkpoint. No blind retry of destroy.
      if(pilot)await this.ctx.storage.put("pilot-close-v1",{status:"unconfirmed",at:Date.now()});
    }
    if(!pilot&&container.running)await container.setInactivityTimeout(INACTIVITY_MS);
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

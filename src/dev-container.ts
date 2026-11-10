import { DurableObject } from "cloudflare:workers";
import { MAX_SHELL_OUTPUT, validateCommand, validateProject } from "./dev-guard";
import { PREVIEW_SOURCE } from "./preview-server";
import { INSPECT_SOURCE, validateInspectionPath } from "./linux-inspect";
import { chunkBackup, joinBackup, sha256Hex, MAX_ARCHIVE_BYTES, type StoredBackup } from "./durable-backup";
import { RESTORE_PROJECT_SOURCE } from "./restore-project";

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
const INACTIVITY_MS = 15 * 60_000;
const IDLE_MS = 5 * 60_000;
const CHECK_MS = 60_000;
const CHECKPOINT_MS = 2 * 60_000;
const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60_000;
// Port version bump prevents a still-running old preview process from serving stale archive code.
// The old process stops with the normal Container lifecycle; no data reset is needed.
const PREVIEW_PORT = 4322;

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
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
    }
  }

  private async ensureRunning() {
    const container = this.ctx.container;
    if (!container) throw new Error("Linux Container binding is not deployed");
    if (!container.running) {
      const snapshotId = await this.ctx.storage.get<string>("snapshotId");
      const savedAt = await this.ctx.storage.get<number>("savedAt");
      if (snapshotId && (!savedAt || Date.now() - savedAt >= SNAPSHOT_TTL_MS)) {
        throw new Error("Linux snapshot is over 30 days old; verified recovery is required before continuing.");
      }
      container.start({
        ...(snapshotId
          ? { containerSnapshot: { id: snapshotId } }
          : { image: "cloudflare/debian-trixie" }),
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
        instance: "basic"
      });
      // If snapshot restore fails, fail closed rather than losing project data.
      if (!(await this.ctx.storage.get<number>("lastActivity"))) {
        await this.ctx.storage.put("lastActivity", Date.now());
      }
    }
    await container.setInactivityTimeout(INACTIVITY_MS);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
    }
    return container;
  }

  async status() {
    const savedAt = (await this.ctx.storage.get<number>("savedAt")) ?? null;
    const smoke = await this.ctx.storage.get<unknown>("smokeReportV1");
    return {
      smoke,
      savedAt,
      snapshotExpiresAt: savedAt ? new Date(savedAt + SNAPSHOT_TTL_MS).toISOString() : null,
      running: this.ctx.container?.running ?? false,
      saved: Boolean(await this.ctx.storage.get<string>("snapshotId")),
      lastActivity: (await this.ctx.storage.get<number>("lastActivity")) ?? null,
      environment: "Debian + Node.js 24",
      instance: "basic",
      shell: "bash",
      git: "install-on-demand",
      persistMode: "Cloudflare container snapshots (beta, 30-day TTL)"
    };
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

  /** Read-only project inspection for Plan and Review without a shell. */
  async inspect(project: string, action: "list" | "read", relativePath: string): Promise<unknown> {
    const id = validateProject(project);
    if (action !== "list" && action !== "read") throw new Error("Invalid inspection action");
    const target = validateInspectionPath(relativePath, action);
    const container = await this.ensureRunning();
    this.busy++;
    await this.ctx.storage.put("lastActivity", Date.now());
    try {
      const process = await container.exec(["node", "-e", INSPECT_SOURCE, id, action, target]);
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
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
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
      await this.ensureGitAvailable(container);
      // Pass the command as a positional argument: no injection into wrapper.
      // GNU timeout bounds one foreground command to 180 s. Jobs that need
      // longer must be broken into resumable steps.
      const wrapper = [
        "mkdir -p /workspace/projects/" + project,
        "cd /workspace/projects/" + project,
        "timeout --signal=TERM 180s bash -lc \"$1\""
      ].join(" && ");
      const process = await container.exec(["bash", "-lc", wrapper, "opencode", command]);
      const output = await process.output();
      const decoder = new TextDecoder();
      const stdout = decoder.decode(output.stdout);
      const stderr = decoder.decode(output.stderr);
      await this.recordProject(project);
      return {
        project,
        exitCode: output.exitCode,
        stdout: stdout.slice(0, MAX_SHELL_OUTPUT),
        stderr: stderr.slice(0, MAX_SHELL_OUTPUT),
        truncated: stdout.length > MAX_SHELL_OUTPUT || stderr.length > MAX_SHELL_OUTPUT,
        persistence: "checkpoint-scheduled"
      };
    } finally {
      this.busy--;
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
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
    const outcome = await handle.output();
    if (outcome.exitCode !== 0) {
      const error = new TextDecoder().decode(outcome.stderr).slice(-350);
      throw new Error("Git bootstrap failed in the Linux container: " + (error || "package installation failed"));
    }
  }

  /** Durable Object alarm: checkpoint then suspend the idle VM. */
  async alarm() {
    const container = this.ctx.container;
    if (!container?.running) return;
    if (this.busy > 0) {
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
      return;
    }

    const lastActivity = (await this.ctx.storage.get<number>("lastActivity")) ?? 0;
    const savedAt = (await this.ctx.storage.get<number>("savedAt")) ?? 0;
    const idle = Date.now() - lastActivity >= IDLE_MS;
    const checkpointDue = lastActivity > savedAt && Date.now() - savedAt >= CHECKPOINT_MS;

    if (idle || checkpointDue) {
      try {
        const snapshot = await container.snapshotContainer({ name: "opencode-workspace" });
        await this.ctx.storage.put({ snapshotId: snapshot.id, savedAt: Date.now() });
      } catch (error) {
        // Never destroy the only unsaved copy of a project.
        console.error("Linux checkpoint failed", error instanceof Error ? error.message : "unknown");
        await container.setInactivityTimeout(INACTIVITY_MS);
        await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
        return;
      }
    }

    if (idle && this.busy === 0 &&
        (await this.ctx.storage.get<number>("lastActivity")) === lastActivity) {
      await container.destroy("idle");
      return;
    }
    await container.setInactivityTimeout(INACTIVITY_MS);
    await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
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
        await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
      }
    } finally {
      release();
    }
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
        signal: AbortSignal.timeout(30_000)
      });
    } finally {
      this.busy--;
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
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

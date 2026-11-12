import { DurableObject } from "cloudflare:workers";
import { MAX_SHELL_OUTPUT, validateCommand, validateProject } from "./dev-guard";
import { PREVIEW_SOURCE, PREVIEW_PORT } from "./preview-server";
import { INSPECT_SOURCE, validateInspectionPath } from "./linux-inspect";
import { chunkBackup, joinBackup, sha256Hex, MAX_ARCHIVE_BYTES, type StoredBackup } from "./durable-backup";
import {
  FS_VERIFY_SOURCE,
  normalizeImageRef,
  parseVerifyReport,
  preflightSnapshotSupport,
  type SnapshotPreflightReport,
  type VerifyRestoreResult
} from "./container-verify";
import { RESTORE_PROJECT_SOURCE } from "./restore-project";
import { GITHUB_IMPORT_SOURCE } from "./github-import-source";
import { githubSourceArchive } from "./github-import";
import { validateIsolatedRegistration, type IsolatedProject } from "./project-container";
import { assertRecoverableContainer, SNAPSHOT_TTL_MS } from "./snapshot-policy";

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
    }
  }

  private async ensureRunning() {
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
  async prepareRepository(project: string, repository: string): Promise<{
    project: string; repository: string; commit: string; files: number; sha256: string;
  }> {
    const id = validateProject(project);
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
        project: string; repository: string; commit: string; files: number; sha256: string
      }>("isolated-repository-v1");
      if (existing) {
        if (existing.project !== id || existing.repository.toLowerCase() !== repository.toLowerCase()) {
          throw Error("El entorno aislado ya pertenece a otro proyecto o repositorio");
        }
        await this.ctx.storage.delete("repo-import-pending-v1");
        await this.recordProject(id);
        return existing;
      }
      const pending = await this.ctx.storage.get<{project: string; repository: string}>("repo-import-pending-v1");
      if (pending && (pending.project !== id || pending.repository.toLowerCase() !== repository.toLowerCase())) {
        throw Error("Ya hay otra importación pendiente en este Container");
      }
      if (await this.ctx.storage.get("lastActivity") && !pending) {
        throw Error("El Container ya fue utilizado; no se importará sobre su contenido");
      }
      if (!pending) await this.ctx.storage.put("repo-import-pending-v1", {project: id, repository});
      const token = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN || await settings.getGitHubKey();
      const source = await githubSourceArchive(repository, token || "", allowed);
      const container = await this.ensureRunning();
      this.busy++;
      await this.ctx.storage.put("lastActivity", Date.now());
      try {
        const process = await container.exec(
          ["node", "--input-type=module", "-e", GITHUB_IMPORT_SOURCE, id], { stdin: source.stream }
        );
        const result = await process.output();
        if (result.exitCode !== 0) {
          throw Error("No se pudo importar el repositorio de forma segura: " +
            new TextDecoder().decode(result.stderr).slice(-350));
        }
        const receipt = JSON.parse(new TextDecoder().decode(result.stdout)) as {
          target: string; files: number; sha256: string
        };
        if (receipt.target !== id || !Number.isSafeInteger(receipt.files) || receipt.files < 1 ||
            !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw Error("Resultado de importación inválido");
        const record = { project: id, repository: source.repo, commit: source.commit,
          files: receipt.files, sha256: receipt.sha256 };
        await this.ctx.storage.put("isolated-repository-v1", record);
        await this.ctx.storage.delete("repo-import-pending-v1");
        await this.recordProject(id);
        return record;
      } finally {
        this.busy--;
        await this.ctx.storage.put("lastActivity", Date.now());
        await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
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
        await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
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
        await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
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
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
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

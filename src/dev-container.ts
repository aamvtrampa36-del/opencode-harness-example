import { DurableObject } from "cloudflare:workers";
import { MAX_SHELL_OUTPUT, validateCommand, validateProject } from "./dev-guard";
import { PREVIEW_SOURCE } from "./preview-server";

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
const PREVIEW_PORT = 4321;

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
}

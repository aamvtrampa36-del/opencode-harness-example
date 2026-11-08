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


  /** Disposable, idempotent end-to-end verification of actual Container RPC. */
  async liveIntegrationOnce(): Promise<unknown> {
    const prior = await this.ctx.storage.get("livePreviewReport20261108");
    if (prior) return prior;
    const started = await this.ctx.storage.get("livePreviewStarted20261108");
    if (started) return { status: "already-started", startedAt: started };
    await this.ctx.storage.put("livePreviewStarted20261108", Date.now());
    const project = "opencode-live-preview";
    const command = [
      "node --version",
      "npm --version",
      "cat > package.json <<'END_PKG'",
      '{"name":"opencode-live-preview","version":"1.0.0","type":"module","scripts":{"test":"node --test","build":"mkdir -p dist && cp index.html dist/index.html"}}',
      "END_PKG",
      "cat > index.html <<'END_HTML'",
      '<!doctype html><html><head><meta charset="utf-8"><title>OpenCode live preview OK</title></head><body><h1>OpenCode live preview OK</h1></body></html>',
      "END_HTML",
      "cat > app.test.mjs <<'END_TEST'",
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'test("app source exists", () => assert.match(readFileSync("index.html", "utf8"), /live preview OK/));',
      "END_TEST",
      "npm install --ignore-scripts --no-audit --no-fund",
      "npm test",
      "npm run build",
      "if command -v git >/dev/null 2>&1; then git --version; git init -q; git add .; git -c user.name='OpenCode Test' -c user.email=test@example.invalid commit -qm 'app smoke'; git log -1 --format=%h; else echo GIT_NOT_INSTALLED; fi"
    ].join("\n");
    try {
      const build = await this.run(project, command);
      if (build.exitCode !== 0) {
        const fail = { status: "fail", stage: "app-build", exitCode: build.exitCode, stderr: build.stderr.slice(-300) };
        await this.ctx.storage.put("livePreviewReport20261108", fail);
        return fail;
      }
      const preview = await this.preview(project, "dist/");
      const html = await preview.text();
      const download = await this.download(project);
      const bytes = new Uint8Array(await download.arrayBuffer());
      const report = {
        status: preview.status === 200 && html.includes("OpenCode live preview OK") &&
                download.status === 200 && bytes[0] === 31 && bytes[1] === 139 ? "pass" : "fail",
        buildExitCode: build.exitCode,
        previewStatus: preview.status,
        previewHasExpectedTitle: html.includes("OpenCode live preview OK"),
        archiveStatus: download.status,
        archiveSizeBytes: bytes.byteLength,
        archiveIsGzip: bytes[0] === 31 && bytes[1] === 139,
        gitAvailable: !build.stdout.includes("GIT_NOT_INSTALLED"),
        nodeNpmTestPassed: build.stdout.includes("pass 1")
      };
      await this.ctx.storage.put("livePreviewReport20261108", report);
      return report;
    } catch (error) {
      const fail = { status: "fail", stage: "exception", error: error instanceof Error ? error.message.slice(0,350) : "unknown" };
      await this.ctx.storage.put("livePreviewReport20261108", fail);
      return fail;
    }
  }

}

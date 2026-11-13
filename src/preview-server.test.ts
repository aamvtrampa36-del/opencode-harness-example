import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_SOURCE } from "./preview-server";

async function runPreviewCase(tarBin?: string): Promise<{
  url: string; close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "g8-archive-ci-"));
  const project = join(root, "test-download");
  await mkdir(join(project, "dist"), { recursive: true });
  await mkdir(join(project, "node_modules"), { recursive: true });
  await writeFile(join(project, "index.html"), "<h1>Archive content</h1>");
  await writeFile(join(project, "dist", "app.js"), "console.log('download');");
  await writeFile(join(project, ".env"), "PRIVATE=never_export");
  await writeFile(join(project, "node_modules", "heavy.txt"), "skip-me");
  const port = 33000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn("node", ["--input-type=module", "-e", PREVIEW_SOURCE], {
    env: { ...process.env, PREVIEW_ROOT: root, PREVIEW_PORT: String(port),
      ...(tarBin ? { PREVIEW_TAR_BIN: tarBin } : {}) },
    stdio: "ignore"
  });
  const url = "http://127.0.0.1:" + port;
  try {
    let ready = false;
    for (let i = 0; i < 70; i++) {
      if (child.exitCode !== null) throw new Error("Preview exited early");
      try {
        const response = await fetch(url + "/__health", { signal: AbortSignal.timeout(400) });
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for Node startup. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Preview did not start");
  } catch (error) {
    child.kill();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { url, close: async () => {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }};
}

describe("actual project tar.gz download over HTTP", () => {
  test("returns a complete, valid tar archive with exact length and secret exclusions", async () => {
    const server = await runPreviewCase();
    try {
      const response = await fetch(server.url + "/__archive/test-download");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/gzip");
      expect(response.headers.get("content-length")).toMatch(/^[1-9][0-9]*$/);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(Number(response.headers.get("content-length")));
      expect(bytes[0]).toBe(0x1f);
      expect(bytes[1]).toBe(0x8b);
      const tar = spawnSync("tar", ["-tzf", "-"], { input: bytes, encoding: "utf8" });
      expect(tar.status).toBe(0);
      expect(tar.stdout).toContain("test-download/index.html");
      expect(tar.stdout).toContain("test-download/dist/app.js");
      expect(tar.stdout).not.toContain(".env");
      expect(tar.stdout).not.toContain("node_modules");
    } finally { await server.close(); }
  }, 20000);

  test("missing Linux project is an actual 404 without download disposition", async () => {
    const server = await runPreviewCase();
    try {
      const response = await fetch(server.url + "/__archive/absent");
      expect(response.status).toBe(404);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await response.text()).toContain("Project files not found");
    } finally { await server.close(); }
  }, 20000);

  test("tar startup failure is HTTP 500 before headers, not an aborted 200 gzip", async () => {
    const server = await runPreviewCase("missing-opencode-tar-executable-for-test");
    try {
      const response = await fetch(server.url + "/__archive/test-download");
      expect(response.status).toBe(500);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toContain("Project archive or preview unavailable");
    } finally { await server.close(); }
  }, 20000);
});

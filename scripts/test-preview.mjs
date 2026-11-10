import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { PREVIEW_SOURCE } from "../src/preview-server.ts";

const temp = mkdtempSync(join(tmpdir(), "opencode-preview-"));
const folder = join(temp, "preview-check", "dist");
mkdirSync(join(folder, "assets"), { recursive: true });
writeFileSync(join(folder, "index.html"), "<!doctype html><title>Preview OK</title><h1>Preview OK</h1>");
writeFileSync(join(folder, "assets", "app.js"), "console.log('preview OK')");
symlinkSync("/etc/passwd", join(folder, "secret.txt"));
writeFileSync(join(temp, "preview-check", ".env"), "SECRET_DO_NOT_ARCHIVE=untrusted");
mkdirSync(join(temp, "preview-check", "node_modules"));
writeFileSync(join(temp, "preview-check", "node_modules", "private.txt"), "PRIVATE_DEPENDENCY_DATA");

const port = 4322;
const child = spawn("node", ["--input-type=module", "-e", PREVIEW_SOURCE], {
  env: { ...process.env, PREVIEW_ROOT: temp, PREVIEW_PORT: String(port) },
  stdio: "ignore"
});
const endpoint = "http://127.0.0.1:" + port;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(endpoint + "/__health", { signal: AbortSignal.timeout(500) })).ok) {
        ready = true;
        break;
      }
    } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "preview service must start");
  const index = await fetch(endpoint + "/preview-check/dist/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") || "", /text\/html/);
  assert.match(await index.text(), /Preview OK/);

  const javascript = await fetch(endpoint + "/preview-check/dist/assets/app.js");
  assert.equal(javascript.status, 200);
  assert.match(javascript.headers.get("content-type") || "", /javascript/);
  assert.match(await javascript.text(), /preview OK/);

  const missing = await fetch(endpoint + "/preview-check/dist/not-found.js");
  assert.equal(missing.status, 404);

  const privateFile = await fetch(endpoint + "/preview-check/package.json");
  assert.equal(privateFile.status, 403, "do not expose source tree outside dist");
  const symlink = await fetch(endpoint + "/preview-check/dist/secret.txt");
  assert.equal(symlink.status, 403, "do not follow symlinks outside build tree");
  const unsafe = await fetch(endpoint + "/%2e%2e/%2e%2e/etc/passwd");
  assert.notEqual(unsafe.status, 200, "preview must not serve files outside project root");

  const archive = await fetch(endpoint + "/__archive/preview-check");
  assert.equal(archive.status, 200);
  assert.match(archive.headers.get("content-type") || "", /gzip/);
  const tarText = gunzipSync(new Uint8Array(await archive.arrayBuffer())).toString("utf8");
  assert.match(tarText, /Preview OK/, "archive must contain source and build");
  assert.doesNotMatch(tarText, /SECRET_DO_NOT_ARCHIVE|PRIVATE_DEPENDENCY_DATA/,
    "archive must not contain .env or node_modules");
  const rejectedPost = await fetch(endpoint + "/preview-check/dist/", { method: "POST" });
  assert.equal(rejectedPost.status, 405);

  console.log("PASS: Node static preview, compiled project URL, assets, 404, source and symlink isolation, safe project archive and POST rejection");
} finally {
  child.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}

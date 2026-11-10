/**
 * Small standalone static preview server.
 * Running in the untrusted *development* container, not in the Cloudflare
 * Worker: the Worker never exposes its own credentials or system APIs.
 *
 * No dependencies, no git, no package manager.
 */
export const PREVIEW_SOURCE = String.raw`
import http from "node:http";
import { readFile, stat, realpath, mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, sep, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
const ROOT = process.env.PREVIEW_ROOT || "/workspace/projects";
const TAR_BIN = process.env.PREVIEW_TAR_BIN || "tar";
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff",
  ".map": "application/json"
};
http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
  try {
    const url = new URL(req.url || "/", "http://container");
    if (url.pathname === "/__health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ready");
      return;
    }
    if (url.pathname.startsWith("/__archive/")) {
      const project = url.pathname.slice("/__archive/".length);
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(project)) {
        res.writeHead(400).end(); return;
      }
      const source = resolve(ROOT, project);
      const dir = await stat(source);
      if (!dir.isDirectory()) { res.writeHead(404).end(); return; }
      // Build and VERIFY the archive before sending HTTP 200. The previous
      // direct tar stdout pipe could abort mid-response or return a broken gzip.
      // Temp disk stores the archive; neither Worker nor DO buffers the file.
      const temp = await mkdtemp(join(tmpdir(), "opencode-download-"));
      let streaming = false;
      try {
        const archive = join(temp, "project.tar.gz");
        await new Promise((resolveDone, rejectDone) => {
          const child = spawn(TAR_BIN, [
            "--exclude=node_modules", "--exclude=.git", "--exclude=.env",
            "--exclude=.env.*", "--exclude=*.pem", "--exclude=*.key",
            "-czf", archive, "-C", ROOT, project
          ], { stdio: ["ignore", "ignore", "pipe"] });
          child.once("error", rejectDone);
          child.once("close", code => {
            if (code === 0) resolveDone();
            else rejectDone(new Error("tar failed, exit code " + code));
          });
        });
        const output = await stat(archive);
        if (!output.isFile() || output.size === 0) throw new Error("Archive empty");
        if (output.size > 256 * 1024 * 1024) {
          res.writeHead(413, { "Content-Type": "text/plain" }).end("Project archive exceeds 256 MiB; use a smaller project export.");
          return;
        }
        const cleanup = () => { void rm(temp, { recursive: true, force: true }).catch(() => undefined); };
        const file = createReadStream(archive);
        file.once("error", () => {
          if (!res.headersSent) res.writeHead(500).end("Archive stream failed");
          else res.destroy();
          cleanup();
        });
        res.once("finish", cleanup);
        res.once("close", cleanup);
        res.writeHead(200, {
          "Content-Type": "application/gzip",
          "Content-Disposition": 'attachment; filename="' + project + '.tar.gz"',
          "Content-Length": String(output.size),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        file.pipe(res);
        streaming = true;
      } finally {
        if (!streaming) await rm(temp, { recursive: true, force: true });
      }
      return;
    }
    const relative = decodeURIComponent(url.pathname);
    if (relative.includes("\\") || relative.includes("\0")) {
      res.writeHead(400).end(); return;
    }
    const parts = relative.split("/").filter(Boolean);
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(parts[0] || "") || parts[1] !== "dist") {
      res.writeHead(403).end(); return;
    }
    const projectRoot = resolve(ROOT, parts[0], "dist");
    let file = resolve(ROOT, "." + relative);
    if (file !== projectRoot && !file.startsWith(projectRoot + sep)) {
      res.writeHead(403).end(); return;
    }
    let info = await stat(file);
    if (info.isDirectory()) { file = resolve(file, "index.html"); info = await stat(file); }
    const realFile = await realpath(file);
    const realRoot = await realpath(projectRoot);
    if (!realFile.startsWith(realRoot + sep)) {
      res.writeHead(403).end(); return;
    }
    if (!info.isFile() || info.size > 10 * 1024 * 1024) {
      res.writeHead(413).end(); return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": String(data.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (err) {
    const missingProject = err && err.code === "ENOENT" && !String(err.syscall || "").startsWith("spawn");
    const code = missingProject ? 404 : 500;
    if (res.headersSent) res.destroy();
    else res.writeHead(code, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
      .end(code === 404 ? "Project files not found" : "Project archive or preview unavailable");
  }
}).listen(Number(process.env.PREVIEW_PORT || 4321), "0.0.0.0");
`;

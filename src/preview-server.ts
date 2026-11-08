/**
 * Small standalone static preview server.
 * Running in the untrusted *development* container, not in the Cloudflare
 * Worker: the Worker never exposes its own credentials or system APIs.
 *
 * No dependencies, no git, no package manager.
 */
export const PREVIEW_SOURCE = String.raw`
import http from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
const ROOT = process.env.PREVIEW_ROOT || "/workspace/projects";
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
    const code = err && err.code === "ENOENT" ? 404 : 500;
    res.writeHead(code, { "Content-Type": "text/plain" }).end(code === 404 ? "Preview not found" : "Preview error");
  }
}).listen(4321, "0.0.0.0");
`;

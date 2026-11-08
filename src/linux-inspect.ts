/** Pure validation for a read-only view into one Linux project. */
export function validateInspectionPath(input: unknown, action: "list" | "read"): string {
  if (typeof input !== "string" || input.length > 240 || (action === "read" && !input)) {
    throw new Error("Ruta de inspección inválida");
  }
  if (!input && action === "list") return "";
  const parts = input.split("/");
  if (input.startsWith("/") || input.includes("\\") ||
      parts.some(p => !p || p === "." || p === ".." || !/^[A-Za-z0-9_.-]+$/.test(p))) {
    throw new Error("La inspección solo admite rutas relativas seguras");
  }
  if (parts.some(p => p === ".git" || p === "node_modules" || /^\.env/i.test(p) ||
      /\.(?:key|pem|p12|pfx)$/i.test(p) || /(?:credentials|secrets)\.json$/i.test(p))) {
    throw new Error("Los archivos sensibles y dependencias no se pueden inspeccionar");
  }
  return input;
}

/**
 * Run as a single, argument-bound Node process IN the Linux Container.
 * No shell, and no writes. realpath checks stop symlink escapes.
 * The returned text is bounded before returning to OpenCode.
 */
export const INSPECT_SOURCE = String.rawconst fs = require("node:fs");
const path = require("node:path");
const [project, action, requested] = process.argv.slice(1);
const rootParent = fs.realpathSync("/workspace/projects");
const root = fs.realpathSync(path.join(rootParent, project));
if (!root.startsWith(rootParent + "/")) throw Error("Project escapes the project root");
const resolved = fs.realpathSync(path.resolve(root, requested || "."));
if (resolved !== root && !resolved.startsWith(root + "/")) throw Error("Path escapes the current project");
if (action === "list") {
  if (!fs.statSync(resolved).isDirectory()) throw Error("Not a directory");
  const hidden = (name) => name === ".git" || name === "node_modules" || /^\.env/i.test(name) ||
    /\.(?:key|pem|p12|pfx)$/i.test(name) || /(?:credentials|secrets)\.json$/i.test(name);
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter(e => !e.isSymbolicLink() && !hidden(e.name))
    .slice(0, 100)
    .map(e => ({ name: e.name, type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other" }));
  process.stdout.write(JSON.stringify({ path: requested || ".", entries }));
} else if (action === "read") {
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > 32768) throw Error("Not a readable text file of up to 32 KiB");
  const contents = fs.readFileSync(resolved, "utf8");
  process.stdout.write(JSON.stringify({ path: requested, size: stat.size, contents }));
} else {
  throw Error("Unsupported read-only operation");
};

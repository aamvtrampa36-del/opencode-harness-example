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
export const INSPECT_SOURCE = "const fs = require(\"node:fs\");\nconst path = require(\"node:path\");\nconst [project, action, requested] = process.argv.slice(1);\nconst rootParent = fs.realpathSync(\"/workspace/projects\");\nconst root = fs.realpathSync(path.join(rootParent, project));\nif (!root.startsWith(rootParent + \"/\")) throw Error(\"Project escapes the project root\");\nconst resolved = fs.realpathSync(path.resolve(root, requested || \".\"));\nif (resolved !== root && !resolved.startsWith(root + \"/\")) throw Error(\"Path escapes the current project\");\nconst relativeParts = path.relative(root, resolved).split(path.sep);\nif (relativeParts.some(name => name === \".git\" || name === \"node_modules\" || /^\\.env/i.test(name) ||\\n  /\\.(?:key|pem|p12|pfx)$/i.test(name) || /(?:credentials|secrets)\\.json$/i.test(name))) throw Error(\"Sensitive files are not readable\");\nif (action === \"list\") {\n  if (!fs.statSync(resolved).isDirectory()) throw Error(\"Not a directory\");\n  const hidden = (name) => name === \".git\" || name === \"node_modules\" || /^\\.env/i.test(name) ||\n    /\\.(?:key|pem|p12|pfx)$/i.test(name) || /(?:credentials|secrets)\\.json$/i.test(name);\n  const entries = fs.readdirSync(resolved, { withFileTypes: true })\n    .filter(e => !e.isSymbolicLink() && !hidden(e.name))\n    .slice(0, 100)\n    .map(e => ({ name: e.name, type: e.isDirectory() ? \"directory\" : e.isFile() ? \"file\" : \"other\" }));\n  process.stdout.write(JSON.stringify({ path: requested || \".\", entries }));\n} else if (action === \"read\") {\n  const stat = fs.statSync(resolved);\n  if (!stat.isFile() || stat.size > 32768) throw Error(\"Not a readable text file of up to 32 KiB\");\n  const contents = fs.readFileSync(resolved, \"utf8\");\n  process.stdout.write(JSON.stringify({ path: requested, size: stat.size, contents }));\n} else {\n  throw Error(\"Unsupported read-only operation\");\n}";

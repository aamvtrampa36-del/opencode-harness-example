/**
 * F0-C10/R2-T09. Isolated Node readback of the BYTES of an existing task output.
 * A successful read is a bounded, independently hashed binary receipt, never an
 * LLM claim, text-decoded conversion, or arbitrary host path.
 */
export function taskArtifactReaderSource(projectRoot = "/workspace/projects"): string {
  if (!projectRoot.startsWith("/") || projectRoot.includes("\u0000")) {
    throw new Error("INVALID_ARTIFACT_ROOT");
  }
  // The root is a trusted Worker constant, not a client-controlled parameter.
  const embeddedRoot = JSON.stringify(projectRoot);
  return String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [project, requested] = process.argv.slice(1);
const MAX = 32 * 1024;
function refuse() { throw Error("ARTIFACT_READ_UNAVAILABLE"); }
try {
if (!/^[a-z][a-z0-9-]{0,39}$/.test(project || "") ||
    typeof requested !== "string" || requested.length > 240 || requested.includes("..") ||
    !/^dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:txt|md|json)$/.test(requested)) refuse();
const base = fs.realpathSync(${embeddedRoot});
const directory = fs.realpathSync(path.join(base, project));
if (directory !== path.join(base, project)) refuse();
const dist = fs.realpathSync(path.join(directory, "dist"));
if (dist !== path.join(directory, "dist")) refuse();
const destination = path.resolve(directory, requested);
if (!destination.startsWith(dist + path.sep)) refuse();
// O_NOFOLLOW prevents following final symlinks. A /proc fd realpath checks
// the actual opened inode, not only an earlier possibly raced path lookup.
const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
try {
  const opened = fs.realpathSync("/proc/self/fd/" + fd);
  if (opened !== destination) refuse();
  const st = fs.fstatSync(fd);
  // A hardlink is a second name for the same inode and defeats realpath-only
  // containment. Reject it even when the opened fd appears under dist/.
  if (!st.isFile() || st.nlink !== 1 || st.size > MAX || st.size < 0) refuse();
  // Fixed allocation, including one extra byte to detect growth. Never readFileSync.
  const buffer = Buffer.alloc(st.size + 1);
  let count = 0;
  while (count < buffer.length) {
    const n = fs.readSync(fd, buffer, count, buffer.length - count, count);
    if (n === 0) break;
    count += n;
  }
  if (count !== st.size) refuse();
  const bytes = buffer.subarray(0, count);
  const after = fs.fstatSync(fd);
  if (!after.isFile() || after.nlink !== 1 || after.dev !== st.dev ||
      after.ino !== st.ino || after.size !== st.size ||
      after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) refuse();
  // Reject recognisable credential material before it can enter the storage receipt.
  const text = bytes.toString("utf8");
  if (/(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b)/i.test(text) ||
      /(?:^|[\s,{])["\x27]?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization)["\x27]?\s*[:=]\s*["\x27]?[^\s,"\x27}]{4,}/i.test(text)) refuse();
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  process.stdout.write(JSON.stringify({
    path: requested, byteSize: bytes.length, base64: bytes.toString("base64"), sha256
  }));
} finally { fs.closeSync(fd); }
} catch {
  process.stderr.write("ARTIFACT_READ_UNAVAILABLE\n");
  process.exitCode = 1;
}
`;
}

export const TASK_ARTIFACT_SOURCE = taskArtifactReaderSource();
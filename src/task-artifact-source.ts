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
if (!/^[a-z][a-z0-9-]{0,39}$/.test(project || "") ||
    typeof requested !== "string" || requested.length > 240 ||
    !/^dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:txt|md|json)$/.test(requested)) refuse();
const base = fs.realpathSync(${embeddedRoot});
const directory = fs.realpathSync(path.join(base, project));
if (!directory.startsWith(base + path.sep)) refuse();
const dist = fs.realpathSync(path.join(directory, "dist"));
if (!dist.startsWith(directory + path.sep)) refuse();
const destination = path.resolve(directory, requested);
if (!destination.startsWith(dist + path.sep)) refuse();
// O_NOFOLLOW prevents following final symlinks. A /proc fd realpath checks
// the actual opened inode, not only an earlier possibly raced path lookup.
const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
try {
  const opened = fs.realpathSync("/proc/self/fd/" + fd);
  if (!opened.startsWith(dist + path.sep)) refuse();
  const st = fs.fstatSync(fd);
  // A hardlink is a second name for the same inode and defeats realpath-only
  // containment. Reject it even when the opened fd appears under dist/.
  if (!st.isFile() || st.nlink !== 1 || st.size > MAX || st.size < 0) refuse();
  const bytes = fs.readFileSync(fd);
  if (bytes.length > MAX || bytes.length !== st.size) refuse();
  const after = fs.fstatSync(fd);
  if (!after.isFile() || after.nlink !== 1 || after.dev !== st.dev ||
      after.ino !== st.ino || after.size !== st.size ||
      after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) refuse();
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  process.stdout.write(JSON.stringify({
    path: requested, byteSize: bytes.length, base64: bytes.toString("base64"), sha256
  }));
} finally { fs.closeSync(fd); }
`;
}

export const TASK_ARTIFACT_SOURCE = taskArtifactReaderSource();
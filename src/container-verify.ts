/**
 * Verifiable backup/restore path for project Linux filesystems, plus a
 * fail-closed Container snapshot preflight. Kept deliberately small.
 *
 * FS_VERIFY_SOURCE is a dependency-free Node program that runs INSIDE a
 * project Linux container (the same source runs from the Worker via
 * container.exec and from scripts/verify-backup-restore.mjs). It:
 *   1. creates an isolated directory with a random 64 KiB payload,
 *   2. records SHA-256 anchors for payload, archive and machine identity,
 *   3. archives the data with tar+gzip to an external location (/tmp),
 *   4. corrupts the live copy (append + delete manifest),
 *   5. restores from the external archive and re-computes every hash,
 *   6. reports one final VERIFY_REPORT JSON line; exit code 0 only when
 *      every check passed. Failures are always ok:false — never a
 *      synthetic PASS. With VERIFY_NEGATIVE=1 the archive is corrupted
 *      before restore and the run MUST fail (negative control).
 *
 * Snapshot restore round trips are NOT simulated here: starting from a
 * containerSnapshot requires the deployed Worker runtime, so this module
 * ships a fail-closed preflight plus the real archive path instead.
 */

/** Dependency-free Node program executed with: node --input-type=module -e */
export const FS_VERIFY_SOURCE = String.raw`
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";

const PREFIX = "VERIFY_REPORT:";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const emit = (report) => { process.stdout.write(PREFIX + JSON.stringify(report) + "\n"); };

const project = String(process.env.VERIFY_PROJECT || "");
const runId = String(process.env.VERIFY_RUN_ID || "");
const root = String(process.env.VERIFY_ROOT || "");
const negative = process.env.VERIFY_NEGATIVE === "1";
const mode = negative ? "negative" : "normal";
const checks = [];
const step = (name, pass, detail) => {
  checks.push({ step: name, status: pass ? "pass" : "fail", detail: detail || "" });
  return pass;
};
const finish = (ok, extra) => {
  emit({
    ok, mode, project, runId,
    artifactsKept: !ok,
    identity: extra.identity,
    identitySha256: extra.identitySha256,
    payloadSha256: extra.payloadSha256,
    archiveSha256: extra.archiveSha256,
    archiveBytes: extra.archiveBytes,
    checks
  });
  process.exit(ok ? 0 : 1);
};
const emptyExtra = () => ({ identity: null, identitySha256: null, payloadSha256: null, archiveSha256: null, archiveBytes: null });

const slugOk = /^[a-z][a-z0-9-]{0,39}$/.test(project);
const runOk = /^[a-f0-9]{8,32}$/.test(runId);
const rootOk = root.startsWith("/") && !root.includes("..") && /^[A-Za-z0-9._/-]+$/.test(root);
if (!slugOk || !runOk || !rootOk) {
  step("preflight", false, "invalid VERIFY_PROJECT, VERIFY_RUN_ID or VERIFY_ROOT");
  finish(false, emptyExtra());
}

function machineIdentity() {
  let pretty = "unknown";
  try {
    for (const line of readFileSync("/etc/os-release", "utf8").split("\n")) {
      if (line.startsWith("PRETTY_NAME=")) {
        pretty = line.slice(12).replace(/^"+|"+$/g, "");
      }
    }
  } catch { pretty = "unknown"; }
  return { os: pretty, kernel: os.release(), node: process.version, arch: os.arch() };
}
const identityOf = (i) => sha256([i.os, i.kernel, i.node, i.arch].join("|"));
const tmp = os.tmpdir ? os.tmpdir() : "/tmp";

const tarCheck = spawnSync("tar", ["--version"], { encoding: "utf8" });
if (!step("tar-available", tarCheck.status === 0, "tar is required to archive and restore the payload")) {
  finish(false, emptyExtra());
}

const dir = root + "/__verify-" + project + "-" + runId;
const backupPath = tmp + "/verify-backup-" + runId + ".tgz";
const dataDir = dir + "/data";
const payloadPath = dataDir + "/payload.bin";
const manifestPath = dataDir + "/verify-manifest.json";

let setupOk = true;
try {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
} catch (error) {
  setupOk = step("setup-isolated-dir", false, String((error && error.message) || error).slice(0, 200));
}
if (!setupOk) finish(false, emptyExtra());

const identityBefore = machineIdentity();
const identityHashBefore = identityOf(identityBefore);
const payload = randomBytes(65536);
const payloadShaBefore = sha256(payload);
writeFileSync(payloadPath, payload);
writeFileSync(manifestPath, JSON.stringify({
  project, runId, createdAt: new Date().toISOString(),
  payloadSha256: payloadShaBefore, identitySha256: identityHashBefore
}, null, 2));
step("payload-created", sha256(readFileSync(payloadPath)) === payloadShaBefore,
  "64 KiB random payload anchored by SHA-256");

const tarCreate = spawnSync("tar", ["-czf", backupPath, "-C", dir, "data"], { encoding: "utf8" });
let archiveShaBefore = null;
let archiveBytes = null;
if (step("backup-created", tarCreate.status === 0 && existsSync(backupPath),
  "tar -czf wrote the external archive copy under " + tmp)) {
  const archive = readFileSync(backupPath);
  archiveShaBefore = sha256(archive);
  archiveBytes = archive.byteLength;
  step("backup-readable", archiveBytes > 0 && archive[0] === 0x1f && archive[1] === 0x8b,
    "gzip magic verified, " + archiveBytes + " bytes");
}

writeFileSync(payloadPath, Buffer.concat([payload, randomBytes(128)]));
rmSync(manifestPath, { force: true });
step("live-copy-corrupted",
  sha256(readFileSync(payloadPath)) !== payloadShaBefore && !existsSync(manifestPath),
  "payload appended and manifest deleted before restore");

if (negative) {
  const raw = readFileSync(backupPath);
  writeFileSync(backupPath, raw.subarray(0, Math.max(1, raw.byteLength - 64)));
  step("negative-injection",
    sha256(readFileSync(backupPath)) !== archiveShaBefore,
    "archive truncated by 64 bytes to prove that corruption is detected");
}

rmSync(dataDir, { recursive: true, force: true });
const tarRestore = spawnSync("tar", ["-xzf", backupPath, "-C", dir], { encoding: "utf8" });
let payloadShaAfter = null;
if (step("restore-extracted", tarRestore.status === 0 && existsSync(manifestPath) && existsSync(payloadPath),
  "data/ tree restored from the external archive copy")) {
  payloadShaAfter = sha256(readFileSync(payloadPath));
  step("payload-integrity", payloadShaAfter === payloadShaBefore,
    "SHA-256 after restore equals the pre-backup anchor");
  let manifestOk = false;
  try {
    const restored = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifestOk = restored.project === project && restored.runId === runId &&
      restored.payloadSha256 === payloadShaBefore && restored.identitySha256 === identityHashBefore;
  } catch { manifestOk = false; }
  step("manifest-integrity", manifestOk, "manifest matches run identity and original hashes");
  const identityAfter = machineIdentity();
  step("image-identity", identityOf(identityAfter) === identityHashBefore,
    "os/kernel/node/arch identity stable across backup and restore");
}

const ok = checks.every((c) => c.status === "pass");
if (ok) {
  rmSync(dir, { recursive: true, force: true });
  rmSync(backupPath, { force: true });
}
finish(ok, {
  identity: identityBefore,
  identitySha256: identityHashBefore,
  payloadSha256: payloadShaAfter,
  archiveSha256: archiveShaBefore,
  archiveBytes
});
`;

export type VerifyCheck = {
  step: string;
  status: "pass" | "fail";
  detail?: string;
};

export type VerifyReport = {
  ok: boolean;
  mode: "normal" | "negative";
  project: string;
  runId: string;
  artifactsKept: boolean;
  identity: { os: string; kernel: string; node: string; arch: string } | null;
  identitySha256: string | null;
  payloadSha256: string | null;
  archiveSha256: string | null;
  archiveBytes: number | null;
  checks: VerifyCheck[];
};

export type VerifyRestoreResult = VerifyReport & {
  exitCode: number;
  containerImage: string | null;
};

const VERIFY_PREFIX = "VERIFY_REPORT:";
const HEX64 = /^[a-f0-9]{64}$/;

/** Strict parser: anything malformed becomes null so callers fail closed. */
export function parseVerifyReport(stdout: string): VerifyReport | null {
  const start = stdout.lastIndexOf(VERIFY_PREFIX);
  if (start < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start + VERIFY_PREFIX.length).split("\n")[0]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.ok !== true && r.ok !== false) return null;
  const mode = r.mode === "normal" || r.mode === "negative" ? r.mode : null;
  if (!mode || !Array.isArray(r.checks) || r.checks.length === 0) return null;
  const parsedChecks: VerifyCheck[] = [];
  for (const item of r.checks) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    if (typeof c.step !== "string" || !c.step || (c.status !== "pass" && c.status !== "fail")) return null;
    parsedChecks.push({
      step: c.step,
      status: c.status,
      ...(typeof c.detail === "string" ? { detail: c.detail } : {})
    });
  }
  const hash = (value: unknown): string | null =>
    typeof value === "string" && HEX64.test(value) ? value : null;
  let identity: VerifyReport["identity"] = null;
  if (r.identity && typeof r.identity === "object") {
    const i = r.identity as Record<string, unknown>;
    if (typeof i.os === "string" && typeof i.kernel === "string" &&
        typeof i.node === "string" && typeof i.arch === "string") {
      identity = { os: i.os, kernel: i.kernel, node: i.node, arch: i.arch };
    }
  }
  let archiveBytes: number | null = null;
  if (typeof r.archiveBytes === "number") {
    if (!Number.isSafeInteger(r.archiveBytes) || r.archiveBytes < 0) return null;
    archiveBytes = r.archiveBytes;
  } else if (r.archiveBytes !== null && r.archiveBytes !== undefined) {
    return null;
  }
  return {
    ok: r.ok === true,
    mode,
    project: typeof r.project === "string" ? r.project : "",
    runId: typeof r.runId === "string" ? r.runId : "",
    artifactsKept: r.artifactsKept === true,
    identity,
    identitySha256: hash(r.identitySha256),
    payloadSha256: hash(r.payloadSha256),
    archiveSha256: hash(r.archiveSha256),
    archiveBytes,
    checks: parsedChecks
  };
}

/** Container/OCI image identity as emitted by container.inspect().image. */
export function normalizeImageRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  if (!ref || ref.length > 512) return null;
  if (/^sha256:[a-f0-9]{64}$/.test(ref)) return ref;
  // A bare sha256: reference must be a complete digest; truncated or
  // malformed digests are rejected instead of accepted as names.
  if (ref.startsWith("sha256:")) return null;
  return /^[A-Za-z0-9_][A-Za-z0-9_./:-]*(@sha256:[a-f0-9]{64})?$/.test(ref) ? ref : null;
}

export type SnapshotPreflightInput = {
  containerApiAvailable: boolean;
  hasSnapshotContainer: boolean;
  hasSnapshotDirectory: boolean;
};

export type SnapshotPreflight = {
  supported: boolean;
  reasons: string[];
  fullContainerSnapshot: boolean;
  directorySnapshot: boolean;
  liveProof: "pending-deployment";
};

/**
 * Fail-closed: absent API surface means UNSUPPORTED. Presence of the API
 * alone is not runtime proof, so liveProof stays "pending-deployment"
 * until a real snapshot/restore round trip runs in the deployed Worker.
 */
export function preflightSnapshotSupport(input: SnapshotPreflightInput): SnapshotPreflight {
  const reasons: string[] = [];
  if (!input.containerApiAvailable) {
    reasons.push("Container binding unavailable in this runtime (local dev or undeployed Worker)");
  }
  if (!input.hasSnapshotContainer) {
    reasons.push("container.snapshotContainer() is not exposed by the installed runtime/SDK");
  }
  if (!input.hasSnapshotDirectory) {
    reasons.push("container.snapshotDirectory() is not exposed by the installed runtime/SDK");
  }
  return {
    supported: reasons.length === 0,
    reasons,
    fullContainerSnapshot: input.hasSnapshotContainer,
    directorySnapshot: input.hasSnapshotDirectory,
    liveProof: "pending-deployment"
  };
}

export type SnapshotPreflightReport = SnapshotPreflight & {
  containerImage: string | null;
  inspectError?: string;
  snapshotId: string | null;
  savedAt: number | null;
};

export type IntegrityInput = {
  payloadSha256Before: string | null;
  payloadSha256After: string | null;
  identitySha256Before: string | null;
  identitySha256After: string | null;
};

/** Every mismatch is a failure; an absent anchor is a failure too. */
export function assertRoundTripIntegrity(input: IntegrityInput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const hex = (v: string | null): v is string => typeof v === "string" && HEX64.test(v);
  if (!hex(input.payloadSha256Before) || !hex(input.payloadSha256After) ||
      input.payloadSha256Before !== input.payloadSha256After) {
    failures.push("payload SHA-256 mismatch between backup and restore (or anchor missing)");
  }
  if (!hex(input.identitySha256Before) || !hex(input.identitySha256After) ||
      input.identitySha256Before !== input.identitySha256After) {
    failures.push("image identity changed during the verification window (or anchor missing)");
  }
  return { ok: failures.length === 0, failures };
}

export type RollbackPath =
  | "worker-versions-api"
  | "worker-source-redeploy"
  | "container-image-restore"
  | "container-filesystem-restore"
  | "persistent-do-storage";

export type RollbackPathStatus = {
  path: RollbackPath;
  status: "available" | "unavailable" | "requires-deployment";
  reason: string;
};

/**
 * Honest assessment of each rollback path. With
 * scheduling_policy=durable_object, GET /versions legitimately returns [],
 * so versions-API rollback is unavailable and source redeploy is the path.
 */
export function evaluateRollbackPaths(input: {
  versionsCount: number | null;
  schedulingPolicy?: string;
}): RollbackPathStatus[] {
  const durableObject = input.schedulingPolicy === "durable_object";
  const workerVersions: RollbackPathStatus =
    input.versionsCount === null
      ? { path: "worker-versions-api", status: "requires-deployment",
          reason: "GET /versions needs the deployed Worker and credentials" }
      : input.versionsCount === 0 && durableObject
        ? { path: "worker-versions-api", status: "unavailable",
            reason: "scheduling_policy=durable_object keeps the version list empty; roll back by redeploying a previous git commit" }
        : { path: "worker-versions-api", status: "available",
            reason: "listed versions can be rolled back with wrangler rollback" };
  return [
    workerVersions,
    { path: "worker-source-redeploy", status: "available",
      reason: "redeploy a previous commit from git; owner-approved operation, not executed here" },
    { path: "container-image-restore", status: "requires-deployment",
      reason: "start({containerSnapshot:{id}}) and inspect().image (OCI digest) only run in the deployed Worker" },
    { path: "container-filesystem-restore", status: "available",
      reason: "tar+gzip archive restored and hash-verified by verifyRestore (runs in any project container)" },
    { path: "persistent-do-storage", status: "available",
      reason: "versioned chunked backups in Durable Object SQLite with SHA-256 verification survive the 30-day snapshot expiry" }
  ];
}

/**
 * Snapshot recovery drill: a SAFE, disposable rehearsal of losing a Container
 * instance and restoring its filesystem from a real snapshotContainer() handle.
 *
 * Safety invariants (fail-closed everywhere):
 *   - Drill methods only ever touch Durable Objects/Containers whose project
 *     slug starts with "snaprec-" (never personal, never an imported project).
 *   - Each run uses a fresh 12-hex nonce, so both drill DOs are brand new and
 *     disposable; cleanup destroys the container and drops the snapshot handle.
 *   - A unique marker file is created with a SHA-256 anchor that is computed
 *     twice (inside the container AND in the Durable Object) and must match.
 *   - After snapshotting, the live disk is deliberately mutated (control
 *     negativo). A valid restore MUST NOT contain the mutation: the marker
 *     SHA-256 must equal the pre-snapshot anchor and the mutation file must
 *     be absent. Detecting the mutation is a pass; surviving it is a failure.
 *   - Missing or expired snapshot handles abort the restore instead of
 *     booting a blank image (assertSnapshotHandle, mirror of snapshot-policy).
 *   - The restored image reference (container.inspect().image) must equal the
 *     image captured before the snapshot (assertCompatibleImage).
 *
 * The in-container program DRILL_SOURCE is dependency-free and is parsed
 * strictly by parseDrillReport; a malformed report is a failure, never a
 * synthetic pass. Cross-DO restore is attempted and reported; if the platform
 * rejects restoring another DO's snapshot id, the phase reports the captured
 * platform error as pending - it is never attributed to application code.
 */

import { validateProject } from "./dev-guard";
import { normalizeImageRef } from "./container-verify";
import { SNAPSHOT_TTL_MS } from "./snapshot-policy";
import { sha256Hex } from "./durable-backup";

export const DRILL_PROJECT_PREFIX = "snaprec-";
/** Root the drill owns inside every project Container. */
export const DRILL_ROOT_PATH = "/workspace/projects";
const HEX64 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{12}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9._:-]{1,256}$/;

/** Drill methods refuse everything that is not a disposable snaprec-* project. */
export function assertDrillProject(project: unknown): string {
  const id = validateProject(project);
  if (!id.startsWith(DRILL_PROJECT_PREFIX)) {
    throw new Error(
      "El ensayo de recuperación solo opera en proyectos desechables " +
      DRILL_PROJECT_PREFIX + "* (operación fuera del proyecto)"
    );
  }
  return id;
}

export function drillProjectNames(nonce: unknown): { creator: string; restorer: string } {
  if (typeof nonce !== "string" || !NONCE.test(nonce)) {
    throw new Error("Invalid drill nonce: 12 hex characters required");
  }
  return {
    creator: DRILL_PROJECT_PREFIX + "a-" + nonce,
    restorer: DRILL_PROJECT_PREFIX + "b-" + nonce
  };
}

export type DrillCheck = {
  step: string;
  status: "pass" | "fail";
  detail?: string;
};

export type DrillIdentity = { os: string; kernel: string; node: string; arch: string };

type DrillReportBase = {
  ok: boolean;
  phase: "create" | "mutate" | "verify";
  project: string;
  runId: string;
  identity: DrillIdentity | null;
  identitySha256: string | null;
  checks: DrillCheck[];
};

export type DrillCreateReport = DrillReportBase & {
  dir: string;
  markerRelPath: string;
  markerContent: string;
  markerBytes: number;
  markerSha256: string;
  manifestSha256: string;
};

export type DrillMutateReport = DrillReportBase & {
  mutatedSha256: string;
  mutationFileRelPath: string;
  mutationFileSha256: string;
};

export type DrillVerifyReport = DrillReportBase & {
  markerSha256: string | null;
  manifestOk: boolean;
  mutationPresent: boolean;
};

export type DrillReport = DrillCreateReport | DrillMutateReport | DrillVerifyReport;

/** Durable, fail-closed record of one drill run (stored in the creator DO). */
export type DrillRecord = {
  version: 1;
  project: string;
  runId: string;
  markerPath: string;
  markerContent: string;
  markerSha256: string;
  mutatedSha256: string;
  mutationFileSha256: string;
  manifestSha256: string;
  snapshotId: string;
  snapshotSavedAt: number;
  image: string | null;
  identitySha256: string | null;
  createdAt: string;
};

/** Missing or expired handles abort the restore; a blank image is never used. */
export function assertSnapshotHandle(
  snapshotId: unknown, savedAt: unknown, now: number
): { id: string; ageMs: number } {
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID.test(snapshotId)) {
    throw new Error("El ensayo no tiene instantánea guardada; no se arrancará una imagen vacía (fail-closed).");
  }
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt) ||
      now - savedAt >= SNAPSHOT_TTL_MS) {
    throw new Error("La instantánea del ensayo venció (TTL de 30 días); no se puede restaurar.");
  }
  return { id: snapshotId, ageMs: Math.max(0, now - savedAt) };
}

/** The restored image must be the exact reference captured before the snapshot. */
export function assertCompatibleImage(before: unknown, after: unknown): string {
  const a = normalizeImageRef(before);
  const b = normalizeImageRef(after);
  if (!a || !b) {
    throw new Error("Identidad de imagen no verificable en el ensayo (falta o es inválida).");
  }
  if (a !== b) {
    throw new Error("Imagen incompatible: la referencia restaurada difiere de la instantaneada (" +
      a + " != " + b + ").");
  }
  return a;
}

/** The Cloudflare-managed image alias is resolved by the platform when
 * restoring a snapshot. A digest string cannot be compared lexically to an
 * image alias. Restrict the exception to Cloudflare's own exact Debian Trixie
 * image family, with a full immutable digest, and report that digest equality
 * was NOT independently observable before the snapshot.
 */
export function assertManagedSnapshotImage(
  before: unknown, after: unknown
): "exact-reference" | "cloudflare-managed-alias" {
  const a = normalizeImageRef(before);
  const b = normalizeImageRef(after);
  if (!a || !b) throw new Error("Identidad de imagen no verificable");
  if (a === b) return "exact-reference";
  if (a === "cloudflare/debian-trixie" &&
      /^registry\.cloudflare\.com\/[a-f0-9]+\/cf\/production\/node-24-trixie@sha256:[a-f0-9]{64}$/.test(b)) {
    return "cloudflare-managed-alias";
  }
  throw new Error("Imagen incompatible: distintas familias o versiones de referencia no justificadas");
}

/**
 * The restored marker must hash to the pre-snapshot anchor and the deliberate
 * post-snapshot mutation must be absent. Any deviation means the restore did
 * not come from the snapshot handle.
 */
export function assertMarkerIntegrity(
  expectedSha256: string, actualSha256: string | null, mutationPresent: boolean
): void {
  if (typeof expectedSha256 !== "string" || !HEX64.test(expectedSha256)) {
    throw new Error("El ensayo no tiene ancla SHA-256 del marcador (registro inválido).");
  }
  if (typeof actualSha256 !== "string" || !HEX64.test(actualSha256) || actualSha256 !== expectedSha256) {
    throw new Error("El marcador restaurado NO coincide con el ancla previa al snapshot; " +
      "la restauración no provino de la instantánea.");
  }
  if (mutationPresent) {
    throw new Error("Cambios posteriores al snapshot sobrevivieron a la restauración.");
  }
}

/** Drill state may only be driven by the DO that owns the record. */
export function assertDrillRecordProject(
  record: DrillRecord | null | undefined, project: string
): DrillRecord {
  if (!record) {
    throw new Error("Este Durable Object no tiene un registro de ensayo (operación fuera del proyecto).");
  }
  if (record.project !== project || !record.project.startsWith(DRILL_PROJECT_PREFIX)) {
    throw new Error("El registro de ensayo pertenece a otro proyecto (operación fuera del proyecto).");
  }
  return record;
}

/** DO-side hash of the marker content; cross-checks the container-computed one. */
export function hashText(content: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(content));
}

const DRILL_PHASES = ["create", "mutate", "verify"] as const;

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function parseChecks(value: unknown): DrillCheck[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed: DrillCheck[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    if (typeof c.step !== "string" || !c.step ||
        (c.status !== "pass" && c.status !== "fail")) return null;
    parsed.push({
      step: c.step,
      status: c.status,
      ...(typeof c.detail === "string" ? { detail: c.detail } : {})
    });
  }
  return parsed;
}

function parseIdentity(value: unknown): DrillIdentity | null {
  if (!value || typeof value !== "object") return null;
  const i = value as Record<string, unknown>;
  if (typeof i.os !== "string" || typeof i.kernel !== "string" ||
      typeof i.node !== "string" || typeof i.arch !== "string") return null;
  return { os: i.os, kernel: i.kernel, node: i.node, arch: i.arch };
}

function parseBase(
  raw: Record<string, unknown>, expectedPhase: (typeof DRILL_PHASES)[number]
): DrillReportBase | null {
  if (raw.ok !== true && raw.ok !== false) return null;
  if (raw.phase !== expectedPhase) return null;
  if (typeof raw.project !== "string" || !raw.project.startsWith(DRILL_PROJECT_PREFIX)) return null;
  if (typeof raw.runId !== "string" || !/^[a-f0-9]{8,32}$/.test(raw.runId)) return null;
  const checks = parseChecks(raw.checks);
  if (!checks) return null;
  return {
    ok: raw.ok === true,
    phase: expectedPhase,
    project: raw.project,
    runId: raw.runId,
    identity: parseIdentity(raw.identity),
    identitySha256: isHex64(raw.identitySha256) ? raw.identitySha256 : null,
    checks
  };
}

const REPORT_PREFIX = "DRILL_REPORT:";
const REL_PATH_OK = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 256 &&
  !value.includes("..") && !value.startsWith("/");

export type DrillPhase = DrillReport["phase"];
type DrillReportFor<P extends DrillPhase> =
  P extends "create" ? DrillCreateReport :
  P extends "mutate" ? DrillMutateReport : DrillVerifyReport;

/** Strict parser: anything malformed becomes null so callers fail closed.
 *  The returned shape is narrowed by the requested phase. */
export function parseDrillReport<P extends DrillPhase>(
  stdout: string, expectedPhase: P
): DrillReportFor<P> | null {
  const start = stdout.lastIndexOf(REPORT_PREFIX);
  if (start < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start + REPORT_PREFIX.length).split("\n")[0]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const base = parseBase(r, expectedPhase);
  if (!base) return null;
  if (expectedPhase === "create") {
    if (!REL_PATH_OK(r.markerRelPath)) return null;
    if (typeof r.markerContent !== "string" || !r.markerContent ||
        r.markerContent.length > 1024) return null;
    if (typeof r.markerBytes !== "number" || !Number.isSafeInteger(r.markerBytes) ||
        r.markerBytes < 1) return null;
    if (!isHex64(r.markerSha256) || !isHex64(r.manifestSha256)) return null;
    if (typeof r.dir !== "string" || !r.dir.startsWith("/") || r.dir.includes("..")) return null;
    return {
      ...base, phase: "create" as const,
      dir: r.dir,
      markerRelPath: r.markerRelPath,
      markerContent: r.markerContent,
      markerBytes: r.markerBytes,
      markerSha256: r.markerSha256,
      manifestSha256: r.manifestSha256
    } as DrillReportFor<P>;
  }
  if (expectedPhase === "mutate") {
    if (!isHex64(r.mutatedSha256) || !isHex64(r.mutationFileSha256)) return null;
    if (!REL_PATH_OK(r.mutationFileRelPath)) return null;
    return {
      ...base, phase: "mutate" as const,
      mutatedSha256: r.mutatedSha256,
      mutationFileRelPath: r.mutationFileRelPath,
      mutationFileSha256: r.mutationFileSha256
    } as DrillReportFor<P>;
  }
  if (!isHex64(r.markerSha256) && r.markerSha256 !== null) return null;
  if (typeof r.manifestOk !== "boolean" || typeof r.mutationPresent !== "boolean") return null;
  return {
    ...base, phase: "verify" as const,
    markerSha256: r.markerSha256,
    manifestOk: r.manifestOk,
    mutationPresent: r.mutationPresent
  } as DrillReportFor<P>;
}

/** Strict parser for the persisted drill record (cross-DO transport included). */
export function parseDrillRecord(raw: unknown): DrillRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (typeof r.project !== "string" || !r.project.startsWith(DRILL_PROJECT_PREFIX)) return null;
  if (typeof r.runId !== "string" || !/^[a-f0-9]{8,32}$/.test(r.runId)) return null;
  if (!REL_PATH_OK(r.markerPath)) return null;
  if (typeof r.markerContent !== "string" || !r.markerContent || r.markerContent.length > 1024) return null;
  if (!isHex64(r.markerSha256) || !isHex64(r.mutatedSha256) ||
      !isHex64(r.mutationFileSha256) || !isHex64(r.manifestSha256)) return null;
  if (typeof r.snapshotId !== "string" || !SNAPSHOT_ID.test(r.snapshotId)) return null;
  if (typeof r.snapshotSavedAt !== "number" || !Number.isFinite(r.snapshotSavedAt)) return null;
  const image = normalizeImageRef(r.image);
  if (r.image !== null && !image) return null;
  if (typeof r.createdAt !== "string" || !r.createdAt ||
      !Number.isFinite(Date.parse(r.createdAt))) return null;
  return {
    version: 1,
    project: r.project,
    runId: r.runId,
    markerPath: r.markerPath,
    markerContent: r.markerContent,
    markerSha256: r.markerSha256,
    mutatedSha256: r.mutatedSha256,
    mutationFileSha256: r.mutationFileSha256,
    manifestSha256: r.manifestSha256,
    snapshotId: r.snapshotId,
    snapshotSavedAt: r.snapshotSavedAt,
    image: image,
    identitySha256: isHex64(r.identitySha256) ? r.identitySha256 : null,
    createdAt: r.createdAt
  };
}

export function evaluateDrillChecks(checks: readonly DrillCheck[]): boolean {
  return Array.isArray(checks) && checks.length > 0 &&
    checks.every((c) => c.status === "pass");
}

/** Machine-readable outcome of a restore phase (DO storage includes this). */
export type DrillRestoreOutcome = {
  ok: boolean;
  phase: "restore-same-do" | "restore-cross-do";
  project: string;
  runId: string;
  checks: DrillCheck[];
  destroyedInstance: boolean;
  imageBefore: string | null;
  imageAfter: string | null;
  imageIdentityProof?: "exact-reference" | "cloudflare-managed-alias";
  metadataBefore: {
    recordPresent: boolean; snapshotId: string | null; savedAt: number | null;
    handleMatchesRecord: boolean;
  };
  metadataAfter?: {
    recordPresent: boolean; snapshotId: string | null; savedAt: number | null;
    handleMatchesRecord: boolean;
  };
  crossDoRestore?: "verified" | "start-rejected" | "verification-failed";
  error?: string;
};

/**
 * Dependency-free Node program executed with: node --input-type=module -e
 * (the same source runs from the Worker via container.exec and from the unit
 * tests via spawnSync). Phases, selected by DRILL_PHASE:
 *   create  - isolated dir + unique marker (random token) + manifest; anchors
 *             SHA-256 of marker bytes and manifest bytes.
 *   mutate  - appends distinguishable bytes to the marker and drops an extra
 *             post-snapshot file; this is the control negativo that a real
 *             snapshot restore must NOT surface.
 *   verify  - re-reads the marker after a restore and fails unless its SHA-256
 *             equals DRILL_EXPECT_SHA256, the manifest matches, and (when
 *             DRILL_MUTATION_ABSENT=1) the post-snapshot file is absent.
 * The final line is one DRILL_REPORT JSON; exit 0 only if every check passed.
 */
export const DRILL_SOURCE = String.raw`
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";

const PREFIX = "DRILL_REPORT:";
const HEX64_RE = /^[a-f0-9]{64}$/;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const emit = (report) => { process.stdout.write(PREFIX + JSON.stringify(report) + "\n"); };

const project = String(process.env.DRILL_PROJECT || "");
const runId = String(process.env.DRILL_RUN_ID || "");
const root = String(process.env.DRILL_ROOT || "");
const phase = String(process.env.DRILL_PHASE || "");
const expectSha = String(process.env.DRILL_EXPECT_SHA256 || "");
const expectManifestSha = String(process.env.DRILL_EXPECT_MANIFEST_SHA || "");
const mutationAbsent = process.env.DRILL_MUTATION_ABSENT === "1";
const checks = [];
const step = (name, pass, detail) => {
  checks.push({ step: name, status: pass ? "pass" : "fail", detail: detail || "" });
  return pass;
};
const finish = (ok, extra) => {
  emit(Object.assign({}, extra, { ok, phase, project, runId,
    identity: extra.identity || null, identitySha256: extra.identitySha256 || null, checks }));
  process.exit(ok ? 0 : 1);
};
const emptyExtra = () => ({ dir: null, markerRelPath: null, markerContent: null,
  markerBytes: null, markerSha256: null, manifestSha256: null, mutatedSha256: null,
  mutationFileRelPath: null, mutationFileSha256: null, markerSha256Out: null,
  manifestOk: false, mutationPresent: false, identity: null, identitySha256: null });

// The program refuses anything outside disposable drill projects, even if it
// is invoked directly inside a container by mistake.
const slugOk = /^[a-z][a-z0-9-]{0,39}$/.test(project) && project.startsWith("snaprec-");
const runOk = /^[a-f0-9]{8,32}$/.test(runId);
const rootOk = root.startsWith("/") && !root.includes("..") && /^[A-Za-z0-9._/-]+$/.test(root);
const phaseOk = phase === "create" || phase === "mutate" || phase === "verify";
if (!step("preflight", slugOk && runOk && rootOk && phaseOk,
  "project must be a snaprec-* slug; runId 8-32 hex; absolute root; known phase")) {
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
const identity = machineIdentity();
const identitySha256 = sha256([identity.os, identity.kernel, identity.node, identity.arch].join("|"));

const dir = root + "/__drill-" + project + "-" + runId;
const markerRelPath = "__drill-" + project + "-" + runId + "/marker.txt";
const mutationRelPath = "__drill-" + project + "-" + runId + "/post-snapshot.txt";
const markerPath = dir + "/marker.txt";
const manifestPath = dir + "/manifest.json";
const mutationPath = dir + "/post-snapshot.txt";

if (phase === "create") {
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    step("create-dir", false, String((error && error.message) || error).slice(0, 200));
    finish(false, emptyExtra());
  }
  const content = "opencode-snapshot-drill-v1|" + project + "|" + runId + "|" +
    randomBytes(24).toString("hex");
  writeFileSync(markerPath, content, "utf8");
  const markerSha = sha256(readFileSync(markerPath));
  step("marker-created", markerSha === sha256(Buffer.from(content, "utf8")),
    "unique marker anchored by SHA-256 in an isolated directory");
  const manifest = { project: project, runId: runId, createdAt: new Date().toISOString(),
    markerSha256: markerSha, identitySha256: identitySha256 };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const manifestSha = sha256(readFileSync(manifestPath));
  finish(true, {
    dir: dir, markerRelPath: markerRelPath, markerContent: content,
    markerBytes: Buffer.byteLength(content, "utf8"), markerSha256: markerSha,
    manifestSha256: manifestSha, identity: identity, identitySha256: identitySha256
  });
}

if (phase === "mutate") {
  if (!step("mutate-preflight", existsSync(markerPath), "marker must exist before mutation")) {
    finish(false, emptyExtra());
  }
  const before = sha256(readFileSync(markerPath));
  writeFileSync(markerPath,
    Buffer.concat([readFileSync(markerPath),
      Buffer.from("|post-snapshot|" + randomBytes(12).toString("hex"), "utf8")]));
  const mutatedSha = sha256(readFileSync(markerPath));
  writeFileSync(mutationPath, randomBytes(48));
  step("marker-mutated", mutatedSha !== before,
    "live disk changed AFTER the snapshot (control negativo)");
  finish(true, {
    mutatedSha256: mutatedSha, mutationFileRelPath: mutationRelPath,
    mutationFileSha256: sha256(readFileSync(mutationPath)),
    identity: identity, identitySha256: identitySha256
  });
}

if (phase === "verify") {
  if (!step("verify-preflight", HEX64_RE.test(expectSha),
    "expected pre-snapshot marker SHA-256 required")) {
    finish(false, emptyExtra());
  }
  const mutationPresent = existsSync(mutationPath);
  let markerSha = null;
  if (step("marker-readable", existsSync(markerPath), "marker restored from the snapshot handle")) {
    markerSha = sha256(readFileSync(markerPath));
    step("marker-integrity", markerSha === expectSha,
      "SHA-256 after restore equals the pre-snapshot anchor");
  }
  let manifestOk = false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifestOk = manifest.project === project && manifest.runId === runId &&
      manifest.markerSha256 === expectSha && manifest.identitySha256 === identitySha256;
  } catch { manifestOk = false; }
  step("manifest-integrity", manifestOk, "manifest matches run identity and original hashes");
  if (expectManifestSha) {
    let actualManifestSha = null;
    try { actualManifestSha = sha256(readFileSync(manifestPath)); } catch { actualManifestSha = null; }
    step("manifest-hash", actualManifestSha === expectManifestSha,
      "manifest bytes identical to the pre-snapshot copy");
  }
  if (mutationAbsent) {
    step("post-snapshot-mutation-absent", !mutationPresent,
      "changes made after snapshotContainer() must NOT survive the restore");
  }
  finish(checks.every((c) => c.status === "pass"), {
    markerSha256: markerSha, manifestOk: manifestOk, mutationPresent: mutationPresent,
    identity: identity, identitySha256: identitySha256
  });
}

finish(false, emptyExtra());
`;

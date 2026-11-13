/**
 * External backup (R2) and cross-restore drill: verifiable copies OUTSIDE the
 * disposable test Container, restored into a DIFFERENT Durable Object.
 *
 * Position in the recovery ladder (docs/external-backup-r2-drill.md):
 *   - saveBackup/downloadSavedBackup: independent copy in the SAME DO (SQLite).
 *   - snapshot drill (container-recovery*): Container snapshot handle recovery.
 *   - THIS module: backup into the account's private R2 bucket and restore
 *     into a new Container/DO, proving the copy survives losing the whole
 *     DO instance. Only disposable test data is ever backed up.
 *
 * Safety invariants (fail-closed everywhere):
 *   - Only "extbkc-*" disposable slugs are accepted; any other project is
 *     rejected as "operación fuera del proyecto" (never personal data).
 *   - Test task/session metadata is SYNTHETIC ("ses_extbk_*" reference) and
 *     carries an explicit disclaimer; real OpenCode sessions or transcripts
 *     are never read, exported or restored.
 *   - Every R2 key lives under "opencode-extbk-v1/<runId>/..." with an 8-32
 *     hex run id; deletion is limited to the run prefix and every key is
 *     re-validated before removal (a foreign key is never deleted).
 *   - Upload is commit-ordered: archive first (sha256-pinned at put),
 *     manifest LAST. A restore only proceeds when the manifest exists, its
 *     digest matches the run hand-off, the metadata hash matches and the
 *     archive digest matches. Missing or altered data is rejected.
 *   - The R2 binding is optional in the type system: when absent the drill
 *     throws "R2 binding no disponible" instead of simulating success, so
 *     live-bucket proof honestly remains pending-deployment.
 */
import { validateProject } from "./dev-guard";
import { MAX_ARCHIVE_BYTES, sha256Hex } from "./durable-backup";

export const EXTBK_PROJECT_PREFIX = "extbkc-";
export const EXTBK_KEY_PREFIX = "opencode-extbk-v1/";
export const EXTBK_SOURCE_ROOT = "/workspace/projects";
export const EXTBK_REPORT_PREFIX = "EXTBK_REPORT:";
export const EXTBK_META_SCHEMA = "opencode.extbk-task-meta.v1";
export const EXTBK_MANIFEST_SCHEMA = "opencode.external-backup.v1";
export const EXTBK_TASK_LABEL = "external-backup-drill";
export const EXTBK_SESSION_REF_PREFIX = "ses_extbk_";
const HEX64 = /^[a-f0-9]{64}$/;
const NONCE12 = /^[a-f0-9]{12}$/;
const RUN_ID = /^[a-f0-9]{8,32}$/;
const SESSION_REF = /^ses[A-Za-z0-9_]{1,64}$/;
const REL_PATH_OK = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 256 &&
  !value.includes("..") && !value.startsWith("/");

/** Fresh 12-hex nonce for one drill run (scope and R2 run id in one). */
export function newDrillNonce(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Drill methods refuse everything that is not a disposable extbkc-* project. */
export function assertExternalBackupProject(project: unknown): string {
  const id = validateProject(project);
  if (!id.startsWith(EXTBK_PROJECT_PREFIX)) {
    throw new Error("El ensayo de respaldo externo solo opera en proyectos desechables " +
      EXTBK_PROJECT_PREFIX + "* (operación fuera del proyecto)");
  }
  return id;
}

export function externalBackupRunId(runId: unknown): string {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw new Error("Invalid external backup run id: 8-32 hex characters required");
  }
  return runId;
}

/** Two brand-new disposable DOs plus the R2 run id they share. */
export function externalBackupProjectNames(nonce: unknown): {
  creator: string; restorer: string; runId: string;
} {
  if (typeof nonce !== "string" || !NONCE12.test(nonce)) {
    throw new Error("Invalid external backup nonce: 12 hex characters required");
  }
  return {
    creator: EXTBK_PROJECT_PREFIX + "a-" + nonce,
    restorer: EXTBK_PROJECT_PREFIX + "b-" + nonce,
    runId: nonce
  };
}

/** R2 keys for one drill run. The tampered and missing keys are throwaway
 * negative-control slots that cleanup always removes. */
export function externalBackupKeys(runId: unknown): {
  archive: string; manifest: string; tamperedArchive: string; missingArchive: string;
} {
  const id = externalBackupRunId(runId);
  const base = EXTBK_KEY_PREFIX + id + "/";
  return {
    archive: base + "archive.tar.gz",
    manifest: base + "manifest.json",
    tamperedArchive: base + "tampered/archive.tar.gz",
    missingArchive: base + "missing/archive.tar.gz"
  };
}

/** Only keys inside this drill's versioned prefix may ever be listed/deleted. */
export function isOwnedExternalKey(key: unknown): key is string {
  if (typeof key !== "string" || !key.startsWith(EXTBK_KEY_PREFIX)) return false;
  const rest = key.slice(EXTBK_KEY_PREFIX.length);
  const runId = rest.split("/")[0];
  return RUN_ID.test(runId) && !key.includes("..");
}

/**
 * Structural subset of R2Bucket used by the drill. The real binding satisfies
 * it, and bun tests exercise the exact same surface through an in-memory
 * implementation, so the R2 seam is covered without pretending the live
 * bucket was reachable from this container.
 */
export type R2LikeObject = { key: string; size: number };
export type R2LikeObjectBody = R2LikeObject & { arrayBuffer(): Promise<ArrayBuffer> };
export type R2LikeListResult = { objects: R2LikeObject[]; truncated: boolean };
export type R2LikeBucket = {
  put(key: string, value: Uint8Array, options?: { sha256?: string }): Promise<R2LikeObject | null>;
  get(key: string): Promise<R2LikeObjectBody | null>;
  head(key: string): Promise<R2LikeObject | null>;
  list(options: { prefix?: string; limit?: number }): Promise<R2LikeListResult>;
  delete(keys: string | readonly string[]): Promise<void>;
};

/** Fail closed when the binding is absent: never simulate a bucket. */
export function assertR2Bucket(value: unknown, where: string): R2LikeBucket {
  const candidate = value as Partial<R2LikeBucket> | null | undefined;
  if (!candidate || typeof candidate !== "object" ||
      typeof candidate.put !== "function" || typeof candidate.get !== "function" ||
      typeof candidate.head !== "function" || typeof candidate.list !== "function" ||
      typeof candidate.delete !== "function") {
    throw new Error("R2 binding no disponible (" + where + "): el respaldo externo NO se " +
      "simula. El binding RECOVERY_R2 solo existe en wrangler.g1.jsonc (Staging); el " +
      "ensayo requiere el Worker desplegado con ese binding (pendiente de despliegue).");
  }
  return candidate as R2LikeBucket;
}

/** Serializable, versioned TEST task/session metadata. Nothing here points at
 * a real OpenCode session; the note says so in plain language. */
export type ExtBkTaskMeta = {
  schema: typeof EXTBK_META_SCHEMA;
  runId: string;
  taskLabel: typeof EXTBK_TASK_LABEL;
  sessionRef: string;
  createdAt: string;
  note: string;
};

export function buildTestTaskMetadata(runId: unknown, now = new Date()): ExtBkTaskMeta {
  const id = externalBackupRunId(runId);
  const sessionRef = EXTBK_SESSION_REF_PREFIX + id;
  if (!SESSION_REF.test(sessionRef)) {
    throw new Error("La referencia de sesión de prueba no pasó la validación de formato");
  }
  return {
    schema: EXTBK_META_SCHEMA,
    runId: id,
    taskLabel: EXTBK_TASK_LABEL,
    sessionRef,
    createdAt: now.toISOString(),
    note: "Metadatos de tarea/sesión de PRUEBA desechable; no es una sesión real de OpenCode."
  };
}

export type ExtBkCheck = { step: string; status: "pass" | "fail"; detail?: string };

/** The single machine-legible contract of one backup run (R2 manifest). */
export type ExtBkManifest = {
  schema: typeof EXTBK_MANIFEST_SCHEMA;
  project: string;
  runId: string;
  archiveKey: string;
  manifestKey: string;
  archiveSha256: string;
  archiveBytes: number;
  markerRelPath: string;
  markerSha256: string;
  extManifestRelPath: string;
  extManifestSha256: string;
  metadata: ExtBkTaskMeta;
  metadataSha256: string;
  createdAt: string;
};

/** Deterministic serialization so digests survive structured-clone or JSON
 * round trips between the Workflow steps and both Durable Objects. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) out[key] = sortValue(input[key]);
    return out;
  }
  return value;
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256Hex(textBytes(canonicalJson(value)));
}

export async function hashText(content: string): Promise<string> {
  return sha256Hex(textBytes(content));
}

/** Strict parser: anything malformed becomes null so callers fail closed. */
export function parseExtBkManifest(raw: unknown): ExtBkManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== EXTBK_MANIFEST_SCHEMA) return null;
  if (typeof r.project !== "string" || !r.project.startsWith(EXTBK_PROJECT_PREFIX)) return null;
  if (validateProject(r.project) !== r.project) return null;
  const runId = externalBackupRunId(r.runId);
  const keys = externalBackupKeys(runId);
  if (r.archiveKey !== keys.archive || r.manifestKey !== keys.manifest) return null;
  if (!HEX64.test(String(r.archiveSha256)) || !HEX64.test(String(r.markerSha256)) ||
      !HEX64.test(String(r.extManifestSha256)) || !HEX64.test(String(r.metadataSha256))) return null;
  if (typeof r.archiveBytes !== "number" || !Number.isSafeInteger(r.archiveBytes) ||
      r.archiveBytes < 3 || r.archiveBytes > MAX_ARCHIVE_BYTES) return null;
  if (!REL_PATH_OK(r.markerRelPath) || !REL_PATH_OK(r.extManifestRelPath)) return null;
  const metaRaw = r.metadata;
  if (!metaRaw || typeof metaRaw !== "object" || Array.isArray(metaRaw)) return null;
  const meta = metaRaw as Record<string, unknown>;
  if (meta.schema !== EXTBK_META_SCHEMA || meta.taskLabel !== EXTBK_TASK_LABEL ||
      meta.runId !== runId || typeof meta.sessionRef !== "string" ||
      !SESSION_REF.test(meta.sessionRef) || !meta.sessionRef.startsWith(EXTBK_SESSION_REF_PREFIX) ||
      typeof meta.createdAt !== "string" || !Number.isFinite(Date.parse(meta.createdAt)) ||
      typeof meta.note !== "string" || !meta.note) return null;
  if (typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt))) return null;
  const metadata: ExtBkTaskMeta = {
    schema: EXTBK_META_SCHEMA, runId, taskLabel: EXTBK_TASK_LABEL,
    sessionRef: meta.sessionRef, createdAt: meta.createdAt, note: meta.note
  };
  return {
    schema: EXTBK_MANIFEST_SCHEMA, project: r.project, runId,
    archiveKey: keys.archive, manifestKey: keys.manifest,
    archiveSha256: String(r.archiveSha256), archiveBytes: r.archiveBytes,
    markerRelPath: r.markerRelPath, markerSha256: String(r.markerSha256),
    extManifestRelPath: r.extManifestRelPath, extManifestSha256: String(r.extManifestSha256),
    metadata, metadataSha256: String(r.metadataSha256), createdAt: r.createdAt
  };
}

/** The manifest metadata must hash to the recorded digest. */
export async function assertMetadataIntegrity(manifest: ExtBkManifest): Promise<void> {
  const digest = await canonicalDigest(manifest.metadata);
  if (digest !== manifest.metadataSha256) {
    throw new Error("Los metadatos de prueba NO coinciden con su digest SHA-256 (alteración detectada)");
  }
}

/** Byte integrity of a downloaded archive: gzip magic, exact size, digest. */
export async function assertArchiveIntegrity(bytes: Uint8Array, manifest: ExtBkManifest): Promise<void> {
  if (bytes.length < 3 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error("El respaldo externo no es un gzip válido (bytes alterados o corruptos)");
  }
  if (bytes.length !== manifest.archiveBytes) {
    throw new Error("El tamaño del respaldo externo no coincide con el manifiesto (" +
      bytes.length + " != " + manifest.archiveBytes + ")");
  }
  const digest = await sha256Hex(bytes);
  if (digest !== manifest.archiveSha256) {
    throw new Error("El respaldo externo NO coincide con el digest SHA-256 del manifiesto " +
      "(bytes alterados o corruptos; restauración rechazada)");
  }
}

/** Read a streamed archive body with a hard byte cap (mirrors saveBackup). */
export async function readCappedBytes(
  body: ReadableStream<Uint8Array>, cap: number, what: string
): Promise<Uint8Array> {
  const reader = body.getReader();
  const collected: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw new Error(what + " supera el límite de " + cap + " bytes");
      }
      collected.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of collected) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

/**
 * Commit-ordered upload: the archive first, pinned by its digest at put
 * (R2 rejects a put whose bytes do not match the given sha256), then the
 * manifest LAST. Until the manifest exists the backup is not complete and
 * no restore may start, which makes the visible switch atomic.
 */
export async function uploadExternalBackup(
  bucket: R2LikeBucket, manifest: ExtBkManifest, manifestSha256: string, archiveBytes: Uint8Array
): Promise<{ archiveHead: number; manifestHead: number }> {
  const keys = externalBackupKeys(manifest.runId);
  if (keys.archive !== manifest.archiveKey || keys.manifest !== manifest.manifestKey) {
    throw new Error("Las claves del manifiesto no corresponden al runId del ensayo");
  }
  const stored = await bucket.put(keys.archive, archiveBytes, { sha256: manifest.archiveSha256 });
  if (!stored) throw new Error("R2 rechazó la subida del archivo de respaldo (sha256 no coincide o put falló)");
  const archiveHead = await bucket.head(keys.archive);
  if (!archiveHead || archiveHead.size !== archiveBytes.length) {
    throw new Error("R2 no confirma el archivo de respaldo subido");
  }
  const manifestBytes = textBytes(canonicalJson(manifest));
  const storedManifest = await bucket.put(keys.manifest, manifestBytes, { sha256: manifestSha256 });
  if (!storedManifest) throw new Error("R2 rechazó la subida del manifiesto");
  const manifestHead = await bucket.head(keys.manifest);
  if (!manifestHead || manifestHead.size !== manifestBytes.length) {
    throw new Error("R2 no confirma el manifiesto subido");
  }
  return { archiveHead: archiveHead.size, manifestHead: manifestHead.size };
}

export async function downloadManifestBytes(bucket: R2LikeBucket, runId: string): Promise<Uint8Array> {
  const keys = externalBackupKeys(runId);
  const obj = await bucket.get(keys.manifest);
  if (!obj) throw new Error("Respaldo externo AUSENTE: el manifiesto " + keys.manifest +
    " no existe en R2 (fail-closed; no se restaura nada)");
  return new Uint8Array(await obj.arrayBuffer());
}

export async function downloadArchiveBytes(bucket: R2LikeBucket, key: string): Promise<Uint8Array> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error("Respaldo externo AUSENTE: la clave " + key +
    " no existe en R2 (fail-closed; no se restaura nada)");
  return new Uint8Array(await obj.arrayBuffer());
}

/**
 * The full verified download: manifest digest must equal the hand-off value,
 * the manifest must parse strictly, metadata must hash correctly, and the
 * archive must match its recorded digest and size.
 */
export async function downloadVerifiedBackup(
  bucket: R2LikeBucket, runId: string, expectedManifestSha256: string
): Promise<{ manifest: ExtBkManifest; manifestBytes: Uint8Array; archiveBytes: Uint8Array }> {
  if (!HEX64.test(expectedManifestSha256)) {
    throw new Error("Digest esperado del manifiesto inválido (handoff alterado)");
  }
  const manifestBytes = await downloadManifestBytes(bucket, runId);
  const received = await sha256Hex(manifestBytes);
  if (received !== expectedManifestSha256) {
    throw new Error("El manifiesto del respaldo externo NO coincide con el digest esperado " +
      "del ensayo (handoff alterado; restauración rechazada)");
  }
  let manifest: ExtBkManifest | null = null;
  try { manifest = parseExtBkManifest(JSON.parse(new TextDecoder().decode(manifestBytes))); }
  catch { manifest = null; }
  if (!manifest) throw new Error("El manifiesto del respaldo externo no es un contrato válido");
  await assertMetadataIntegrity(manifest);
  const archiveBytes = await downloadArchiveBytes(bucket, manifest.archiveKey);
  await assertArchiveIntegrity(archiveBytes, manifest);
  return { manifest, manifestBytes, archiveBytes };
}

/** Flip one middle byte: a minimal, deterministic corruption for the
 * negative control stored under its own throwaway key. */
export function flipMiddleByte(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[Math.floor(copy.length / 2)] = copy[Math.floor(copy.length / 2)] ^ 0xff;
  return copy;
}

/** Fetch the verified original from R2, corrupt one byte and store it under
 * the run's tampered key (a distinct object; the original is never touched). */
export async function createTamperedProbe(
  bucket: R2LikeBucket, runId: string
): Promise<{ key: string; bytes: number; alteredSha256: string }> {
  const keys = externalBackupKeys(runId);
  const original = await downloadArchiveBytes(bucket, keys.archive);
  const altered = flipMiddleByte(original);
  const alteredSha256 = await sha256Hex(altered);
  const stored = await bucket.put(keys.tamperedArchive, altered);
  if (!stored) throw new Error("R2 rechazó la sonda de alteración");
  const head = await bucket.head(keys.tamperedArchive);
  if (!head || head.size !== altered.length) throw new Error("R2 no confirma la sonda de alteración");
  return { key: keys.tamperedArchive, bytes: altered.length, alteredSha256 };
}

/** Negative control: the tampered bytes must be REJECTED by the digest check
 * while the original object stays byte-identical. */
export async function assertTamperRejected(
  bucket: R2LikeBucket, runId: string, manifest: ExtBkManifest
): Promise<{ rejectedAsExpected: true; reason: string; alteredSha256: string; originalIntact: boolean }> {
  const keys = externalBackupKeys(runId);
  const tampered = await downloadArchiveBytes(bucket, keys.tamperedArchive);
  const alteredSha256 = await sha256Hex(tampered);
  if (alteredSha256 === manifest.archiveSha256) {
    throw new Error("Control negativo inconsistente: los bytes alterados coinciden con el digest original");
  }
  let rejected = false;
  try { await assertArchiveIntegrity(tampered, manifest); }
  catch (error) {
    rejected = /SHA-256|gzip válido|manifiesto/.test(error instanceof Error ? error.message : "");
    if (!rejected) throw error;
  }
  if (!rejected) throw new Error("La sonda alterada NO fue rechazada; el control negativo falló");
  const original = await downloadArchiveBytes(bucket, keys.archive);
  const originalIntact = (await sha256Hex(original)) === manifest.archiveSha256;
  if (!originalIntact) throw new Error("El respaldo original dejó de coincidir tras la sonda");
  return { rejectedAsExpected: true, reason: "digest-mismatch", alteredSha256, originalIntact };
}

/** Negative control: a key that was never written must fail closed. */
export async function assertMissingRejected(
  bucket: R2LikeBucket, runId: string
): Promise<{ rejectedAsExpected: true; reason: string }> {
  const keys = externalBackupKeys(runId);
  const probe = await bucket.get(keys.missingArchive);
  if (probe) throw new Error("Control negativo inconsistente: la clave de sonda ausente tiene contenido");
  const head = await bucket.head(keys.missingArchive);
  if (head) throw new Error("Control negativo inconsistente: la clave de sonda ausente tiene head");
  let rejected = false;
  try { await downloadArchiveBytes(bucket, keys.missingArchive); }
  catch (error) {
    rejected = /AUSENTE/.test(error instanceof Error ? error.message : "");
    if (!rejected) throw error;
  }
  if (!rejected) throw new Error("La sonda de ausencia NO fue rechazada; el control negativo falló");
  return { rejectedAsExpected: true, reason: "absent-key" };
}

/** Delete ONLY the run's own keys. Foreign keys (other run ids or other
 * prefixes) abort the cleanup before anything is removed. */
export async function deleteRunPrefix(
  bucket: R2LikeBucket, runId: string
): Promise<{ deleted: number; keys: string[] }> {
  const id = externalBackupRunId(runId);
  const prefix = EXTBK_KEY_PREFIX + id + "/";
  const listed = await bucket.list({ prefix, limit: 1000 });
  const foreign = listed.objects.filter((o) => !isOwnedExternalKey(o.key));
  if (foreign.length > 0) {
    throw new Error("Se encontraron claves ajenas bajo el prefijo del ensayo; no se borra nada");
  }
  const keys = listed.objects.map((o) => o.key);
  if (keys.length > 0) await bucket.delete(keys);
  const after = await bucket.list({ prefix, limit: 1000 });
  if (after.objects.length > 0) {
    throw new Error("El prefijo del ensayo no quedó vacío tras la limpieza");
  }
  return { deleted: keys.length, keys };
}

export type ExtBkIdentity = { os: string; kernel: string; node: string; arch: string };
export type ExtBkPhase = "create" | "verify";

type ExtBkReportBase = {
  ok: boolean;
  phase: ExtBkPhase;
  project: string;
  runId: string;
  identity: ExtBkIdentity | null;
  identitySha256: string | null;
  checks: ExtBkCheck[];
};

export type ExtBkCreateReport = ExtBkReportBase & {
  dir: string;
  markerRelPath: string;
  markerContent: string;
  markerBytes: number;
  markerSha256: string;
  extManifestRelPath: string;
  extManifestSha256: string;
};

export type ExtBkVerifyReport = ExtBkReportBase & {
  markerSha256: string | null;
  extManifestOk: boolean;
};

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function parseExtChecks(value: unknown): ExtBkCheck[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed: ExtBkCheck[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    if (typeof c.step !== "string" || !c.step ||
        (c.status !== "pass" && c.status !== "fail")) return null;
    parsed.push({
      step: c.step, status: c.status,
      ...(typeof c.detail === "string" ? { detail: c.detail } : {})
    });
  }
  return parsed;
}

function parseExtBase(raw: Record<string, unknown>, expectedPhase: ExtBkPhase): ExtBkReportBase | null {
  if (raw.ok !== true && raw.ok !== false) return null;
  if (raw.phase !== expectedPhase) return null;
  if (typeof raw.project !== "string" || !raw.project.startsWith(EXTBK_PROJECT_PREFIX)) return null;
  if (!RUN_ID.test(String(raw.runId))) return null;
  const checks = parseExtChecks(raw.checks);
  if (!checks) return null;
  const identity = raw.identity && typeof raw.identity === "object" ? raw.identity as Record<string, unknown> : null;
  return {
    ok: raw.ok === true, phase: expectedPhase, project: raw.project, runId: String(raw.runId),
    identity: identity && typeof identity.os === "string" && typeof identity.kernel === "string" &&
      typeof identity.node === "string" && typeof identity.arch === "string"
      ? { os: identity.os, kernel: identity.kernel, node: identity.node, arch: identity.arch } : null,
    identitySha256: isHex64(raw.identitySha256) ? String(raw.identitySha256) : null,
    checks
  };
}

/** Strict report parser (mirror of parseDrillReport). */
export function parseExtBkReport<P extends ExtBkPhase>(
  stdout: string, expectedPhase: P
): (P extends "create" ? ExtBkCreateReport : ExtBkVerifyReport) | null {
  const start = stdout.lastIndexOf(EXTBK_REPORT_PREFIX);
  if (start < 0) return null;
  let raw: unknown;
  try { raw = JSON.parse(stdout.slice(start + EXTBK_REPORT_PREFIX.length).split("\n")[0]); }
  catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const base = parseExtBase(r, expectedPhase);
  if (!base) return null;
  if (expectedPhase === "create") {
    if (typeof r.dir !== "string" || !r.dir.startsWith("/") || r.dir.includes("..")) return null;
    if (!REL_PATH_OK(r.markerRelPath) || !REL_PATH_OK(r.extManifestRelPath)) return null;
    if (typeof r.markerContent !== "string" || !r.markerContent ||
        r.markerContent.length > 512) return null;
    if (typeof r.markerBytes !== "number" || !Number.isSafeInteger(r.markerBytes) ||
        r.markerBytes < 1) return null;
    if (!isHex64(r.markerSha256) || !isHex64(r.extManifestSha256)) return null;
    return {
      ...base, phase: "create", dir: r.dir, markerRelPath: r.markerRelPath,
      markerContent: r.markerContent, markerBytes: r.markerBytes,
      markerSha256: r.markerSha256, extManifestRelPath: r.extManifestRelPath,
      extManifestSha256: r.extManifestSha256
    } as (P extends "create" ? ExtBkCreateReport : ExtBkVerifyReport);
  }
  if (r.markerSha256 !== null && !isHex64(r.markerSha256)) return null;
  if (typeof r.extManifestOk !== "boolean") return null;
  return {
    ...base, phase: "verify",
    markerSha256: r.markerSha256 === null ? null : String(r.markerSha256),
    extManifestOk: r.extManifestOk
  } as (P extends "create" ? ExtBkCreateReport : ExtBkVerifyReport);
}

/** All container-side checks must pass; a missing report is a failure. */
export function evaluateExtChecks(checks: readonly ExtBkCheck[]): boolean {
  return Array.isArray(checks) && checks.length > 0 && checks.every((c) => c.status === "pass");
}

/**
 * Build the versioned manifest from a verified create report and the DO-side
 * archive digest (the double anchor). Returns the canonical bytes and digest.
 */
export async function buildExternalBackupManifest(input: {
  report: ExtBkCreateReport;
  archiveSha256: string;
  archiveBytes: number;
  now?: Date;
}): Promise<{ manifest: ExtBkManifest; manifestSha256: string; manifestBytes: Uint8Array }> {
  const runId = externalBackupRunId(input.report.runId);
  const keys = externalBackupKeys(runId);
  const metadata = buildTestTaskMetadata(runId, input.now);
  const now = (input.now ?? new Date()).toISOString();
  const manifest: ExtBkManifest = {
    schema: EXTBK_MANIFEST_SCHEMA,
    project: input.report.project,
    runId,
    archiveKey: keys.archive,
    manifestKey: keys.manifest,
    archiveSha256: input.archiveSha256,
    archiveBytes: input.archiveBytes,
    markerRelPath: input.report.markerRelPath,
    markerSha256: input.report.markerSha256,
    extManifestRelPath: input.report.extManifestRelPath,
    extManifestSha256: input.report.extManifestSha256,
    metadata,
    metadataSha256: await canonicalDigest(metadata),
    createdAt: now
  };
  const manifestBytes = textBytes(canonicalJson(manifest));
  return { manifest, manifestSha256: await sha256Hex(manifestBytes), manifestBytes };
}

/**
 * Dependency-free Node program executed with: node --input-type=module -e
 * (the same source runs from the Worker via container.exec and from the unit
 * tests via spawnSync). The final line is one EXTBK_REPORT JSON; exit 0 only
 * if every check passed. Layout (inside the disposable project directory so
 * the archive root is "<project>/"):
 *   <root>/<project>/__extbk-<project>-<runId>/marker.txt   unique marker
 *   <root>/<project>/extbk-manifest.json                    in-archive manifest
 *   create - writes both files and anchors their SHA-256.
 *   verify - after a restore, re-reads both files under EXT_SOURCE_PROJECT
 *            and fails unless the SHA-256 equal the expected anchors.
 */
export const EXTBK_SOURCE = String.raw`
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";

const PREFIX = "EXTBK_REPORT:";
const HEX64_RE = /^[a-f0-9]{64}$/;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const emit = (report) => { process.stdout.write(PREFIX + JSON.stringify(report) + "\n"); };

const project = String(process.env.EXT_PROJECT || "");
const sourceProject = String(process.env.EXT_SOURCE_PROJECT || project);
const runId = String(process.env.EXT_RUN_ID || "");
const root = String(process.env.EXT_SOURCE_ROOT || "");
const phase = String(process.env.EXT_PHASE || "");
const expectMarkerSha = String(process.env.EXT_EXPECT_MARKER_SHA256 || "");
const expectManifestSha = String(process.env.EXT_EXPECT_MANIFEST_SHA256 || "");
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
  markerBytes: null, markerSha256: null, extManifestRelPath: null,
  extManifestSha256: null, extManifestOk: false,
  identity: null, identitySha256: null });

// The program refuses anything outside disposable extbkc-* projects, even if
// it is invoked directly inside a container by mistake.
const slugOk = /^[a-z][a-z0-9-]{0,39}$/.test(project) && project.startsWith("extbkc-") &&
  /^[a-z][a-z0-9-]{0,39}$/.test(sourceProject) && sourceProject.startsWith("extbkc-");
const runOk = /^[a-f0-9]{8,32}$/.test(runId);
const rootOk = root.startsWith("/") && !root.includes("..") && /^[A-Za-z0-9._/-]+$/.test(root);
const phaseOk = phase === "create" || phase === "verify";
if (!step("preflight", slugOk && runOk && rootOk && phaseOk,
  "project/source must be extbkc-* slugs; runId 8-32 hex; absolute root; known phase")) {
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

// create: files live under the creator tree. verify: the creator content
// was restored into the restorer tree, so the drill directory keeps the
// creator name but sits under the restorer project directory.
const dir = root + "/" + project + "/__extbk-" + sourceProject + "-" + runId;
const markerRelPath = "__extbk-" + sourceProject + "-" + runId + "/marker.txt";
const markerPath = dir + "/marker.txt";
const extManifestRelPath = "extbk-manifest.json";
const extManifestPath = root + "/" + project + "/" + extManifestRelPath;

if (phase === "create") {
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    step("create-dir", false, String((error && error.message) || error).slice(0, 200));
    finish(false, emptyExtra());
  }
  const content = "opencode-external-backup-v1|" + project + "|" + runId + "|" +
    randomBytes(24).toString("hex");
  writeFileSync(markerPath, content, "utf8");
  const markerSha = sha256(readFileSync(markerPath));
  step("marker-created", markerSha === sha256(Buffer.from(content, "utf8")),
    "unique marker anchored by SHA-256 inside the disposable project");
  const manifest = { schema: "opencode.extbk-container.v1", project: project, runId: runId,
    createdAt: new Date().toISOString(), markerRelPath: markerRelPath, markerSha256: markerSha,
    identitySha256: identitySha256 };
  writeFileSync(extManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const manifestSha = sha256(readFileSync(extManifestPath));
  step("container-manifest-written", manifestSha === sha256(readFileSync(extManifestPath)),
    "in-archive manifest anchored by SHA-256");
  finish(true, {
    dir: dir, markerRelPath: markerRelPath, markerContent: content,
    markerBytes: Buffer.byteLength(content, "utf8"), markerSha256: markerSha,
    extManifestRelPath: extManifestRelPath, extManifestSha256: manifestSha,
    identity: identity, identitySha256: identitySha256
  });
}

if (phase === "verify") {
  if (!step("verify-preflight", HEX64_RE.test(expectMarkerSha) && HEX64_RE.test(expectManifestSha),
    "expected marker and manifest SHA-256 anchors required")) {
    finish(false, emptyExtra());
  }
  let markerSha = null;
  if (step("marker-readable", existsSync(markerPath), "marker restored from the external backup")) {
    markerSha = sha256(readFileSync(markerPath));
    step("marker-integrity", markerSha === expectMarkerSha,
      "SHA-256 after restore equals the pre-upload anchor");
  }
  let extManifestOk = false;
  if (step("manifest-readable", existsSync(extManifestPath), "in-archive manifest restored")) {
    const manifestSha = sha256(readFileSync(extManifestPath));
    extManifestOk = manifestSha === expectManifestSha;
    step("manifest-integrity", extManifestOk,
      "in-archive manifest SHA-256 equals the pre-upload anchor");
  }
  finish(markerSha === expectMarkerSha && extManifestOk, {
    markerSha256: markerSha, extManifestOk: extManifestOk,
    identity: identity, identitySha256: identitySha256
  });
}
finish(false, emptyExtra());
`;

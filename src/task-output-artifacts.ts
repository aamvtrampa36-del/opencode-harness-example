/**
 * F0-C10/R2-T09. Small, immutable per-task text artifacts. This module is pure;
 * the supervisor authenticates first and supplies the server-owned task scope.
 * Never use a language-model pathname or public URL as an attachment URL.
 */
export const TASK_ARTIFACT_SCHEMA = "opencode.task-output.v1";
export const TASK_ARTIFACT_MAX_BYTES = 32 * 1024; // Exact cap of DevContainer.readTaskArtifact
export const TASK_ARTIFACT_MAX_PER_TASK = 8;
export const TASK_ARTIFACT_TTL_MS = 12 * 60 * 60 * 1000;
export const TASK_ARTIFACT_PREFIX = "/api/supervisor/v1/tasks";

const TASK_ID = /^[a-f0-9]{16}$/;
const ARTIFACT_ID = /^[a-f0-9]{32}$/;
const SOURCE_PATH = /^dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:txt|md|json)$/;
const MIMES: Readonly<Record<string, string>> = {
  txt: "text/plain", md: "text/markdown", json: "application/json"
};

export type CaptureRequest = { readonly path: string; readonly name: string; readonly mime: string };
export type ArtifactView = {
  schema: typeof TASK_ARTIFACT_SCHEMA;
  requestId: string;
  artifactId: string;
  name: string;
  mime: string;
  byteSize: number;
  sha256: string;
  createdAt: number;
  delivery: { kind: "authenticated-route"; path: string; expiresAt: number };
};
export type StoredTaskArtifact = Omit<ArtifactView, "schema" | "delivery"> & {
  /** Private relative source path for content-id verification, NEVER in ArtifactView. */
  sourcePath: string;
  ownerProject: string;
  ownerSession: string;
  repository: string;
  expiresAt: number;
  bytes: Uint8Array;
};

function assert(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

export function assertTaskId(id: unknown): asserts id is string {
  assert(typeof id === "string" && TASK_ID.test(id), "INVALID_TASK_ID");
}
export function assertArtifactId(id: unknown): asserts id is string {
  assert(typeof id === "string" && ARTIFACT_ID.test(id), "INVALID_ARTIFACT_ID");
}
export function artifactKey(requestId: string, artifactId: string): string {
  assertTaskId(requestId); assertArtifactId(artifactId);
  return `supervisor:output:v1:${requestId}:${artifactId}`;
}
export function artifactIndexKey(requestId: string): string {
  assertTaskId(requestId);
  return `supervisor:output-index:v1:${requestId}`;
}
export function artifactDownloadPath(requestId: string, artifactId: string, expiresAt?: number): string {
  assertTaskId(requestId); assertArtifactId(artifactId);
  const path = `${TASK_ARTIFACT_PREFIX}/${requestId}/artifacts/${artifactId}`;
  if (expiresAt === undefined) return path;
  assert(Number.isSafeInteger(expiresAt) && expiresAt > 0, "INVALID_ARTIFACT_EXPIRY");
  return path + "?expires=" + expiresAt;
}

/** Only an explicit relative dist/ file can be captured; never arbitrary /bundle. */
export function validateCaptureRequest(raw: unknown): CaptureRequest {
  assert(Boolean(raw) && typeof raw === "object" && !Array.isArray(raw), "INVALID_CAPTURE");
  const input = raw as Record<string, unknown>;
  assert(Object.keys(input).every(k => ["path", "name", "mime"].includes(k)), "UNKNOWN_CAPTURE_PARAMETER");
  const { path, name, mime } = input;
  assert(typeof path === "string" && path.length <= 240 && SOURCE_PATH.test(path) &&
    !path.split("/").some(p => p.startsWith(".") || p.includes("..")), "UNSAFE_SOURCE_PATH");
  assert(typeof name === "string" && name.length > 0 && name.length <= 120 &&
    name === name.trim() && name === name.normalize("NFC") && !name.startsWith(".") &&
    !/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/u.test(name) &&
    !name.endsWith(".") && !name.endsWith(" "), "UNSAFE_FILENAME");
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  assert(typeof mime === "string" && MIMES[ext] === mime, "UNSAFE_OR_MISMATCHED_MIME");
  assert(path.toLowerCase().endsWith("." + ext), "SOURCE_EXTENSION_MISMATCH");
  return { path, name, mime };
}

function containsArtifactSecret(value: string): boolean {
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i.test(value) ||
    /(?:^|[\s,{])["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization)["']?\s*[:=]\s*["']?[^\s,"'}]{4,}/i.test(value);
}

async function shaHex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/** Input must come from DevContainer.inspect, not from an agent/tool JSON claim. */
export async function captureInspectedArtifact(args: {
  requestId: string;
  ownerProject: string;
  ownerSession: string;
  repository: string;
  request: CaptureRequest;
  inspected: unknown;
  now?: number;
}): Promise<StoredTaskArtifact> {
  assertTaskId(args.requestId);
  const req = validateCaptureRequest(args.request);
  const x = args.inspected as { path?: unknown; byteSize?: unknown; base64?: unknown; sha256?: unknown } | null;
  assert(x !== null && typeof x === "object" && x.path === req.path &&
    Number.isSafeInteger(x.byteSize) && (x.byteSize as number) >= 0 &&
    (x.byteSize as number) <= TASK_ARTIFACT_MAX_BYTES &&
    typeof x.base64 === "string" && x.base64.length <= 44_000 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x.base64) &&
    typeof x.sha256 === "string" && /^[a-f0-9]{64}$/.test(x.sha256), "UNVERIFIED_SOURCE_READ");
  // Decode the exact bytes emitted by a trusted, read-only Container process.
  // A UTF-8 text read alone could replace malformed bytes with U+FFFD without
  // changing byte length; that would create a false checksum of invented bytes.
  const bytes = Uint8Array.from(atob(x.base64), c => c.charCodeAt(0));
  assert(bytes.byteLength === x.byteSize && bytes.byteLength <= TASK_ARTIFACT_MAX_BYTES,
    "SOURCE_BYTE_COUNT_MISMATCH");
  assert((await shaHex(bytes)) === x.sha256, "SOURCE_BYTE_HASH_MISMATCH");
  let contents: string;
  try { contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("NON_UTF8_ARTIFACT"); }
  assert(!containsArtifactSecret(contents) && !containsArtifactSecret(req.name), "ARTIFACT_SECRET_PATTERN");
  assert(/^[a-z][a-z0-9-]{0,39}$/.test(args.ownerProject) &&
    /^ses[A-Za-z0-9_]{1,64}$/.test(args.ownerSession) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository), "INVALID_OWNER_SCOPE");
  if (req.mime === "application/json") {
    try { JSON.parse(contents); } catch { throw new Error("INVALID_JSON_ARTIFACT"); }
  }
  const sha256 = await shaHex(bytes);
  const fingerprint = new TextEncoder().encode([args.requestId, req.path, req.name, req.mime, sha256].join("\n"));
  const artifactId = (await shaHex(fingerprint)).slice(0, 32);
  const now = args.now ?? Date.now();
  assert(Number.isSafeInteger(now) && now >= 0, "INVALID_CAPTURE_TIME");
  return {
    requestId: args.requestId, artifactId, sourcePath: req.path,
    ownerProject: args.ownerProject, ownerSession: args.ownerSession, repository: args.repository,
    name: req.name, mime: req.mime, byteSize: bytes.byteLength, sha256,
    createdAt: now, expiresAt: now + TASK_ARTIFACT_TTL_MS, bytes
  };
}

export function artifactView(artifact: StoredTaskArtifact): ArtifactView {
  assertTaskId(artifact.requestId); assertArtifactId(artifact.artifactId);
  return {
    schema: TASK_ARTIFACT_SCHEMA,
    requestId: artifact.requestId, artifactId: artifact.artifactId,
    name: artifact.name, mime: artifact.mime, byteSize: artifact.byteSize,
    sha256: artifact.sha256, createdAt: artifact.createdAt,
    delivery: {
      kind: "authenticated-route", path: artifactDownloadPath(artifact.requestId, artifact.artifactId, artifact.expiresAt),
      expiresAt: artifact.expiresAt
    }
  };
}

export function artifactMatchesScope(artifact: StoredTaskArtifact | undefined, task: {
  id: string; project: string; session: string; repository: string;
}): boolean {
  return Boolean(artifact && artifact.requestId === task.id && artifact.ownerProject === task.project &&
    artifact.ownerSession === task.session && typeof artifact.repository === "string" &&
    typeof task.repository === "string" && artifact.repository.toLowerCase() === task.repository.toLowerCase());
}

export function artifactIsOwnedBy(artifact: StoredTaskArtifact | undefined, task: ArtifactTaskScope, now = Date.now()): boolean {
  return Boolean(artifactMatchesScope(artifact, task) && artifact && Number.isSafeInteger(artifact.expiresAt) && now < artifact.expiresAt);
}

export function artifactErrorResponse(code: string, status: number): Response {
  return Response.json({ error: code }, { status, headers: {
    "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  } });
}

function contentDisposition(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const fallback = "archivo." + ext;
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Independently re-hash the STORED bytes immediately before HTTP delivery. */
export async function verifiedArtifactDownload(artifact: StoredTaskArtifact, now = Date.now()): Promise<Response> {
  if (now >= artifact.expiresAt) return artifactErrorResponse("ARTIFACT_EXPIRED", 410);
  if (!(artifact.bytes instanceof Uint8Array) || artifact.byteSize !== artifact.bytes.byteLength ||
      artifact.byteSize > TASK_ARTIFACT_MAX_BYTES ||
      (await shaHex(artifact.bytes)) !== artifact.sha256) {
    return artifactErrorResponse("ARTIFACT_INTEGRITY_FAILURE", 502);
  }
  // A stored hash that matches stored bytes is insufficient: the bytes AND
  // checksum could be rewritten under the original artifactId. Recompute
  // the task-scoped content ID from the private captured source path.
  try {
    assertTaskId(artifact.requestId);
    assertArtifactId(artifact.artifactId);
    const identity = validateCaptureRequest({
      path: artifact.sourcePath, name: artifact.name, mime: artifact.mime
    });
    const decoded = new TextDecoder("utf-8",{fatal:true}).decode(artifact.bytes);
    if (containsArtifactSecret(decoded) || containsArtifactSecret(identity.name)) return artifactErrorResponse("ARTIFACT_SECRET_PATTERN", 502);
    if (identity.mime === "application/json") JSON.parse(decoded);
    if (!Number.isSafeInteger(artifact.createdAt) ||
        !Number.isSafeInteger(artifact.expiresAt) ||
        artifact.createdAt < 0 || artifact.createdAt > now ||
        artifact.expiresAt - artifact.createdAt !== TASK_ARTIFACT_TTL_MS) {
      return artifactErrorResponse("ARTIFACT_IDENTITY_FAILURE", 502);
    }
    const fingerprint = new TextEncoder().encode([
      artifact.requestId, identity.path, identity.name, identity.mime, artifact.sha256
    ].join("\n"));
    if ((await shaHex(fingerprint)).slice(0, 32) !== artifact.artifactId) {
      return artifactErrorResponse("ARTIFACT_IDENTITY_FAILURE", 502);
    }
  } catch {
    return artifactErrorResponse("INVALID_ARTIFACT_METADATA", 502);
  }
  return new Response(new Uint8Array(artifact.bytes), { status: 200, headers: {
    "Content-Type": artifact.mime + "; charset=utf-8",
    "Content-Length": String(artifact.byteSize),
    "Content-Disposition": contentDisposition(artifact.name),
    "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store, private",
    "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Accept-Ranges": "none", "X-Artifact-SHA256": artifact.sha256
  } });
}

/** Existing DO storage contract; callers must authenticate and resolve scope first. */
export type ArtifactTaskScope = { id: string; project: string; session: string; repository: string };
export type ArtifactReadStorage = { get<T>(key: string): Promise<T | undefined> };
export type ArtifactTransaction = ArtifactReadStorage & {
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
};

async function readArtifactIndex(storage: ArtifactReadStorage, id: string): Promise<string[]> {
  const raw = await storage.get<unknown>(artifactIndexKey(id));
  if (raw === undefined) return [];
  assert(Array.isArray(raw) && raw.length <= TASK_ARTIFACT_MAX_PER_TASK, "ARTIFACT_INDEX_INVALID");
  const ids: string[] = [];
  for (const key of raw) { assertArtifactId(key); ids.push(key); }
  assert(new Set(ids).size === ids.length, "ARTIFACT_INDEX_INVALID");
  return ids;
}

async function verifyScopedStored(record: StoredTaskArtifact | undefined, scope: ArtifactTaskScope,
                                  id: string, now: number): Promise<StoredTaskArtifact> {
  assert(record && record.artifactId === id && artifactIsOwnedBy(record, scope, now), "ARTIFACT_SCOPE_OR_EXPIRY");
  assert((await verifiedArtifactDownload(record, now)).status === 200, "ARTIFACT_INTEGRITY_FAILURE");
  return record;
}

/** Use inside the existing DO transaction, never as two independent writes.
 * Active idempotent replay keeps the original timestamp and bytes. Corrupt/missing
 * index records fail closed; no opportunistic deletion of another scope's data.
 * Expiry cleanup is limited to verified expired records of this exact scope.
 */
export async function persistTaskArtifact(tx: ArtifactTransaction, scope: ArtifactTaskScope,
                                          prepared: StoredTaskArtifact, now = Date.now()): Promise<StoredTaskArtifact> {
  assertTaskId(scope.id);
  await verifyScopedStored(prepared, scope, prepared.artifactId, now);
  const index = await readArtifactIndex(tx, scope.id);
  const key = artifactKey(scope.id, prepared.artifactId);
  const existing = await tx.get<StoredTaskArtifact>(key);
  if (existing !== undefined || index.includes(prepared.artifactId)) {
    assert(index.includes(prepared.artifactId), "ARTIFACT_INDEX_INVALID");
    assert(existing && Number.isSafeInteger(existing.expiresAt), "ARTIFACT_INDEX_INVALID");
    if (now < existing.expiresAt) return verifyScopedStored(existing, scope, prepared.artifactId, now);
    // Explicit recapture of the same immutable content may renew its delivery
    // generation after expiry. Verify old bytes/scope first; never renew an
    // orphan or a stale preparation. Old URLs remain expired.
    await verifyScopedStored(existing, scope, prepared.artifactId, existing.expiresAt - 1);
    assert(prepared.createdAt >= existing.expiresAt && prepared.sha256 === existing.sha256 &&
      prepared.byteSize === existing.byteSize, "ARTIFACT_STALE_RECAPTURE");
    await tx.put(key, prepared);
    return prepared;
  }
  const live: string[] = [];
  const expired: string[] = [];
  for (const id of index) {
    const priorKey = artifactKey(scope.id, id);
    const prior = await tx.get<StoredTaskArtifact>(priorKey);
    assert(prior && Number.isSafeInteger(prior.expiresAt), "ARTIFACT_INDEX_INVALID");
    if (now >= prior.expiresAt) {
      await verifyScopedStored(prior, scope, id, prior.expiresAt - 1);
      expired.push(priorKey);
    } else {
      await verifyScopedStored(prior, scope, id, now);
      live.push(id);
    }
  }
  assert(live.length < TASK_ARTIFACT_MAX_PER_TASK, "ARTIFACT_TASK_LIMIT");
  for (const oldKey of expired) await tx.delete(oldKey);
  await tx.put(key, prepared);
  await tx.put(artifactIndexKey(scope.id), [...live, prepared.artifactId]);
  return prepared;
}

/** Bounded read-only projection: scan at most limit records, never a transcript,
 * never list all storage. Cursor is scoped to task + current index and is internal
 * to Artifact v1; P20 will handle the public HTTP cursor contract.
 */
export async function readTaskArtifactPage(storage: ArtifactReadStorage, scope: ArtifactTaskScope,
                                           after: string | undefined, limit = 2, now = Date.now()): Promise<{
  artifacts: ArtifactView[]; nextAfter: string | null; scanned: number;
}> {
  assertTaskId(scope.id);
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= TASK_ARTIFACT_MAX_PER_TASK, "ARTIFACT_PAGE_LIMIT");
  const index = await readArtifactIndex(storage, scope.id);
  let start = 0;
  if (after !== undefined) {
    assert(typeof after === "string" && after.startsWith(scope.id + ":"), "ARTIFACT_CURSOR_INVALID");
    const prior = after.slice(scope.id.length + 1);
    assertArtifactId(prior);
    const position = index.indexOf(prior);
    assert(position >= 0, "ARTIFACT_CURSOR_INVALID");
    start = position + 1;
  }
  const selected = index.slice(start, start + limit);
  const artifacts: ArtifactView[] = [];
  for (const id of selected) {
    const record = await storage.get<StoredTaskArtifact>(artifactKey(scope.id, id));
    // A valid, scoped expired record is omitted; a foreign or malformed row fails closed.
    if (record && Number.isSafeInteger(record.expiresAt) && now >= record.expiresAt) {
      await verifyScopedStored(record, scope, id, record.expiresAt - 1);
      continue;
    }
    artifacts.push(artifactView(await verifyScopedStored(record, scope, id, now)));
  }
  return { artifacts, scanned: selected.length,
    nextAfter: start + selected.length < index.length ? scope.id + ":" + selected[selected.length - 1] : null };
}

/** M08 offline repair primitive for an explicitly inventoried task. Must run
 * within the existing authorized DO transaction; it is not a public route.
 * No scan, delete, expiry refresh or guessing of missing bytes. Validate all
 * known records and existing index entries before a single index write. */
export async function reconcileTaskArtifactIndex(tx: ArtifactTransaction, scope: ArtifactTaskScope,
    knownArtifactIds: readonly string[], now=Date.now()): Promise<{added:string[];index:string[]}> {
  assertTaskId(scope.id);
  assert(Number.isSafeInteger(now)&&now>=0&&Array.isArray(knownArtifactIds)&&
    knownArtifactIds.length<=TASK_ARTIFACT_MAX_PER_TASK,"ARTIFACT_REPAIR_SCOPE");
  for(const id of knownArtifactIds)assertArtifactId(id);
  assert(new Set(knownArtifactIds).size===knownArtifactIds.length,"ARTIFACT_REPAIR_SCOPE");
  const prior=await readArtifactIndex(tx,scope.id);
  const added=knownArtifactIds.filter(id=>!prior.includes(id));
  const index=[...prior,...added];
  assert(index.length<=TASK_ARTIFACT_MAX_PER_TASK,"ARTIFACT_TASK_LIMIT");
  for(const id of index){
    const record=await tx.get<StoredTaskArtifact>(artifactKey(scope.id,id));
    assert(record&&Number.isSafeInteger(record.expiresAt),"ARTIFACT_INDEX_INVALID");
    await verifyScopedStored(record,scope,id,Math.min(now,record.expiresAt-1));
  }
  if(added.length)await tx.put(artifactIndexKey(scope.id),index);
  return {added,index};
}

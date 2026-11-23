/**
 * F0-C10/R2-T09. Small, immutable per-task text artifacts. This module is pure;
 * the supervisor authenticates first and supplies the server-owned task scope.
 * Never use a language-model pathname or public URL as an attachment URL.
 */
export const TASK_ARTIFACT_SCHEMA = "opencode.task-output.v1";
export const TASK_ARTIFACT_MAX_BYTES = 32 * 1024; // Exact cap of DevContainer.inspect(read)
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
export function artifactDownloadPath(requestId: string, artifactId: string): string {
  assertTaskId(requestId); assertArtifactId(artifactId);
  return `${TASK_ARTIFACT_PREFIX}/${requestId}/artifacts/${artifactId}`;
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
    requestId: args.requestId, artifactId,
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
      kind: "authenticated-route", path: artifactDownloadPath(artifact.requestId, artifact.artifactId),
      expiresAt: artifact.expiresAt
    }
  };
}

export function artifactIsOwnedBy(artifact: StoredTaskArtifact | undefined, task: {
  id: string; project: string; session: string; repository: string;
}, now = Date.now()): boolean {
  return Boolean(artifact && artifact.requestId === task.id && artifact.ownerProject === task.project &&
    artifact.ownerSession === task.session && artifact.repository.toLowerCase() === task.repository.toLowerCase() &&
    Number.isSafeInteger(artifact.expiresAt) && now < artifact.expiresAt);
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
  // Validate metadata again: never trust storage corruption or a forged MIME/name.
  try { validateCaptureRequest({ path: "dist/archivo." + artifact.name.slice(artifact.name.lastIndexOf(".") + 1), name: artifact.name, mime: artifact.mime }); }
  catch { return artifactErrorResponse("INVALID_ARTIFACT_METADATA", 502); }
  return new Response(new Uint8Array(artifact.bytes), { status: 200, headers: {
    "Content-Type": artifact.mime + "; charset=utf-8",
    "Content-Length": String(artifact.byteSize),
    "Content-Disposition": contentDisposition(artifact.name),
    "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store, private",
    "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin"
  } });
}
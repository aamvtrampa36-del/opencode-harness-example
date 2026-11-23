/** F0-C10/T09 offline reference contract; NOT wired into the deployed Worker. */
import { createHash } from 'node:crypto';

const TASK_ID = /^[a-f0-9]{16}$/;
const ARTIFACT_ID = /^[a-z0-9_-]{8,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MIME_EXTENSION = new Map([
  ['text/plain', new Set(['.txt'])],
  ['text/markdown', new Set(['.md'])],
  ['application/json', new Set(['.json'])],
  ['application/octet-stream', new Set(['.bin'])]
]);
const STATUSES = new Set(['preparing', 'running', 'finished', 'failed', 'cancelled', 'unknown']);
function demand(ok, code) { if (!ok) throw new Error(code); }
function isSafeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 120 &&
    name === name.normalize('NFC') && name === name.trim() &&
    !name.startsWith('.') && !/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/u.test(name) &&
    !name.endsWith('.') && !name.endsWith(' ');
}
export function artifactPath(requestId, artifactId) {
  demand(TASK_ID.test(requestId) && ARTIFACT_ID.test(artifactId), 'INVALID_ARTIFACT_ID');
  return `/api/tasks/${requestId}/artifacts/${artifactId}`;
}
export function validateManifest(manifest, now = Date.now()) {
  demand(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'INVALID_MANIFEST');
  demand(manifest.schema === 'opencode.task-output.v1', 'UNSUPPORTED_SCHEMA');
  demand(TASK_ID.test(manifest.requestId), 'INVALID_TASK_ID');
  demand(STATUSES.has(manifest.status), 'INVALID_TASK_STATUS');
  demand(typeof manifest.passed === 'boolean' && typeof manifest.verified === 'boolean' && typeof manifest.reviewRequired === 'boolean', 'UNVERIFIED_TASK_FLAGS');
  demand(!(manifest.verified && !manifest.passed), 'IMPOSSIBLE_VERIFICATION');
  demand(typeof manifest.summary?.text === 'string' && manifest.summary.text.length <= 8000, 'INVALID_SUMMARY');
  demand(typeof manifest.summary.truncated === 'boolean', 'SUMMARY_TRUNCATION_UNKNOWN');
  if (manifest.summary.truncated) demand(Number.isSafeInteger(manifest.summary.omittedChars) && manifest.summary.omittedChars > 0, 'TRUNCATION_UNDECLARED');
  demand(Array.isArray(manifest.artifacts) && manifest.artifacts.length <= 32, 'INVALID_ARTIFACT_LIST');
  demand(Array.isArray(manifest.errors) && manifest.errors.length <= 32, 'INVALID_ERRORS');
  const ids = new Set();
  for (const f of manifest.artifacts) {
    demand(f?.requestId === manifest.requestId, 'ARTIFACT_WRONG_TASK');
    demand(ARTIFACT_ID.test(f.artifactId) && !ids.has(f.artifactId), 'DUPLICATE_OR_INVALID_ARTIFACT');
    ids.add(f.artifactId);
    demand(isSafeName(f.name), 'UNSAFE_FILENAME');
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    demand(MIME_EXTENSION.get(f.mime)?.has(ext) === true, 'UNSAFE_OR_MISMATCHED_MIME');
    demand(Number.isSafeInteger(f.byteSize) && f.byteSize >= 0 && f.byteSize <= MAX_ARTIFACT_BYTES, 'INVALID_ARTIFACT_SIZE');
    demand(SHA256.test(f.sha256), 'INVALID_ARTIFACT_HASH');
    demand(f.delivery?.kind === 'authenticated-route', 'UNVERIFIED_DELIVERY_KIND');
    demand(f.delivery.path === artifactPath(manifest.requestId, f.artifactId), 'UNTRUSTED_DELIVERY_PATH');
    demand(Number.isSafeInteger(f.delivery.expiresAt) && f.delivery.expiresAt > now && f.delivery.expiresAt <= now + 86400000, 'EXPIRED_OR_UNBOUNDED_LINK');
  }
  return manifest;
}

/** Verify actual GET bytes; no HEAD-only or 200-only acceptance. No redirects. */
export async function verifyDownload({ manifest, artifact, baseURL, trustedOrigin, authorization, now = Date.now(), fetcher = fetch, allowLocalTestOrigin = false }) {
  validateManifest(manifest, now);
  demand(manifest.artifacts.includes(artifact), 'ARTIFACT_NOT_IN_MANIFEST');
  const origin = new URL(baseURL);
  demand(origin.username === '' && origin.password === '' && origin.search === '' && origin.hash === '', 'UNSAFE_BASE_URL');
  demand(typeof trustedOrigin === 'string' && origin.origin === new URL(trustedOrigin).origin, 'UNTRUSTED_DOWNLOAD_ORIGIN');
  demand(origin.protocol === 'https:' || (allowLocalTestOrigin && origin.protocol === 'http:' && origin.hostname === '127.0.0.1'), 'UNSAFE_ORIGIN');
  demand(typeof authorization === 'string' && authorization.startsWith('Bearer ') && authorization.length > 8, 'UNAUTHENTICATED');
  const url = new URL(artifact.delivery.path, origin);
  demand(url.origin === origin.origin && url.pathname === artifactPath(manifest.requestId, artifact.artifactId) && !url.search && !url.hash, 'CROSS_ORIGIN_OR_ROUTE');
  const response = await fetcher(url, { headers: { Authorization: authorization }, redirect: 'manual', cache: 'no-store' });
  demand(response.status === 200 && response.body, 'NOT_DOWNLOADABLE_HTTP_' + response.status);
  demand(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === artifact.mime, 'RESPONSE_MIME_MISMATCH');
  demand(response.headers.get('x-content-type-options')?.toLowerCase() === 'nosniff', 'MISSING_NOSNIFF');
  const disposition = response.headers.get('content-disposition') || '';
  demand(/^attachment(?:;|$)/i.test(disposition), 'NOT_ATTACHMENT');
  const filenameMatch = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(disposition);
  let responseName = '';
  try { responseName = decodeURIComponent(filenameMatch?.[1] || ''); } catch { /* fail closed */ }
  demand(responseName === artifact.name, 'DOWNLOAD_FILENAME_MISMATCH');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) demand(Number(declaredLength) === artifact.byteSize, 'CONTENT_LENGTH_MISMATCH');
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      demand(bytes <= MAX_ARTIFACT_BYTES && bytes <= artifact.byteSize, 'STREAM_EXCEEDED_DECLARED_SIZE');
      hash.update(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  demand(bytes === artifact.byteSize, 'BYTE_COUNT_MISMATCH');
  demand(hash.digest('hex') === artifact.sha256, 'BYTE_HASH_MISMATCH');
  return { requestId: manifest.requestId, artifactId: artifact.artifactId, bytesVerified: bytes, sha256: artifact.sha256 };
}

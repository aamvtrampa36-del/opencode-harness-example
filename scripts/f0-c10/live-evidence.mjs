import { createHash, createPublicKey, verify } from 'node:crypto';

// No producer/model supplied key is trusted. Trusted keys come from an independently
// provisioned operator file. This verifier never calls Remote or Cloudflare.
export const LIVE_EVIDENCE_SCHEMA = 'f0-c10-live-evidence-v1';
export const EVIDENCE_ROLES = Object.freeze(['runtime', 'artifact', 'telemetry', 'budget']);
export const REQUIRED_COST_COMPONENTS = Object.freeze([
  'inference', 'workers', 'durableObjects', 'containers', 'observability', 'ci', 'egress',
]);

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite value in attestation');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new Error('undefined field in attestation: ' + key);
      return JSON.stringify(key) + ':' + canonicalJson(value[key]);
    }).join(',') + '}';
  }
  throw new Error('unsupported attestation value');
}
export const digest = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

export function attestationPayload(trace, role) {
  if (!EVIDENCE_ROLES.includes(role)) throw new Error('unknown attestation role');
  const meta = trace.metadata || {};
  const context = {
    schema: LIVE_EVIDENCE_SCHEMA,
    experimentId: meta.experimentId,
    sourceSha: meta.sourceSha,
    gitBaseSha: meta.gitBaseSha,
    workerVersion: meta.workerVersion,
    mcpVersion: meta.mcpVersion,
    limitsSha256: meta.limitsSha256,
  };
  if (role === 'runtime') return { context, metadata: meta, tasks: trace.tasks, events: trace.events.filter((e) => e.type !== 'artifact_readback') };
  if (role === 'artifact') return { context, readbacks: trace.events.filter((e) => e.type === 'artifact_readback') };
  if (role === 'telemetry') return { context, telemetry: trace.telemetry };
  return { context, budget: trace.budget };
}

export function signingBytes(trace, role) {
  return Buffer.from('OPEN-CODE/F0-C10/LIVE-EVIDENCE/V1/' + role + '\0' + canonicalJson(attestationPayload(trace, role)), 'utf8');
}
const looksSha = (value, n) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + n + '}$').test(value);
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
const strictBase64 = (b64) => typeof b64 === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64) &&
  Buffer.from(b64, 'base64').toString('base64') === b64;

// A signature verifies custody of a private key, NOT whether a collector used
// authenticated APIs. That independent collector deployment must be audited in T09/T01.
export function verifyLiveEvidence(trace, trustedKeys, limits) {
  const failures = [];
  const fail = (code, reason) => failures.push({ code, detail: reason });
  if (!trace || trace.mode !== 'live' || !Array.isArray(trace.tasks) || !Array.isArray(trace.events) ||
      !Array.isArray(trace.telemetry) || !trace.metadata || !trace.budget) {
    return { pass: false, failures: [{ code: 'LIVE_EVIDENCE_FORMAT', detail: 'invalid live bundle' }] };
  }
  const meta = trace.metadata;
  if (!nonblank(meta.experimentId) || !looksSha(meta.sourceSha, 40) || !looksSha(meta.gitBaseSha, 40) ||
      !looksSha(meta.limitsSha256, 64) || digest(limits) !== meta.limitsSha256) {
    fail('LIVE_EVIDENCE_SCOPE', 'experiment, source SHA, base SHA or predeclared limits do not match');
  }
  if (!nonblank(meta.workerVersion) || !nonblank(meta.mcpVersion) || !nonblank(meta.leaseId) ||
      !nonblank(meta.fencingToken)) fail('LIVE_EVIDENCE_SCOPE', 'version/lease/fencing token missing');
  for (const t of trace.tasks) {
    if (t.experimentId !== meta.experimentId || t.sourceSha !== meta.sourceSha) fail('TASK_EVIDENCE_SCOPE', t.requestId);
  }
  for (const e of trace.events) {
    if (e.experimentId !== meta.experimentId || e.sourceSha !== meta.sourceSha) fail('EVENT_EVIDENCE_SCOPE', e.requestId);
    if (e.type === 'artifact_readback') {
      if (e.source !== 'artifact-collector') fail('ARTIFACT_PROVENANCE', e.requestId);
      const a = e.artifact;
      const b64 = a?.bytesBase64;
      if (!strictBase64(b64)) { fail('ARTIFACT_BYTES_UNVERIFIABLE', e.requestId); continue; }
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > limits.maxResponseBytes || bytes.length !== a.byteLength ||
          createHash('sha256').update(bytes).digest('hex') !== a.sha256 ||
          Buffer.from(a.content || '', 'utf8').compare(bytes) !== 0) fail('ARTIFACT_BYTES_MISMATCH', e.requestId);
      const p = e.retrievalReceipt;
      if (!p || p.method !== 'GET' || p.status !== 200 || p.authenticated !== true ||
          !nonblank(p.retrievalId) || p.sha256 !== a.sha256 || p.byteLength !== bytes.length) {
        fail('ARTIFACT_RETRIEVAL_UNVERIFIED', e.requestId);
      }
    } else if (e.source !== 'runtime') fail('RUNTIME_PROVENANCE', e.requestId);
  }
  if (trace.telemetry.some((s) => s.source !== 'cloudflare' || s.workerVersion !== meta.workerVersion ||
      s.queryId !== meta.observabilityQueryId || !nonblank(s.queryId))) {
    fail('TELEMETRY_SCOPE', 'service/version/query mismatch');
  }
  const b = trace.budget;
  if (typeof limits.maxCostUsd !== 'number' || !Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0 ||
      b.capUsd !== limits.maxCostUsd || b.stop?.enforced !== true || !nonblank(b.stop?.controlId) ||
      b.stop?.scope !== 'full-experiment' || !nonblank(b.meterReceiptId) ||
      b.experimentId !== meta.experimentId) fail('BUDGET_CONTROL_UNVERIFIED', 'unknown or unenforced cost cap');
  if (!b.components || REQUIRED_COST_COMPONENTS.some((key) => !Number.isFinite(b.components[key]) || b.components[key] < 0) ||
      !Number.isFinite(b.totalUsd) || b.totalUsd < 0 ||
      Math.abs(REQUIRED_COST_COMPONENTS.reduce((v, k) => v + (b.components?.[k] || 0), 0) - b.totalUsd) > 0.000001 ||
      b.totalUsd !== meta.measuredTotalUsd || b.totalUsd > limits.maxCostUsd) {
    fail('BUDGET_ACCOUNTING_INVALID', 'cost components/total missing, mismatched or over cap');
  }
  const keysSeen = new Set();
  for (const role of EVIDENCE_ROLES) {
    const signed = trace.attestations?.[role];
    const pem = trustedKeys?.[role];
    if (!nonblank(pem) || !strictBase64(signed?.signature)) { fail('ATTESTATION_MISSING', role); continue; }
    try {
      const publicKey = createPublicKey(pem);
      if (publicKey.asymmetricKeyType !== 'ed25519') { fail('ATTESTATION_KEY_TYPE', role); continue; }
      const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      if (keysSeen.has(fingerprint)) fail('ATTESTATION_KEY_REUSE', role);
      keysSeen.add(fingerprint);
      if (!verify(null, signingBytes(trace, role), publicKey, Buffer.from(signed.signature, 'base64'))) {
        fail('ATTESTATION_INVALID', role);
      }
    } catch (error) { fail('ATTESTATION_INVALID', role + ': ' + String(error?.message || error).slice(0, 120)); }
  }
  return { pass: failures.length === 0, failures };
}

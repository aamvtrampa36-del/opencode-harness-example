import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from './live-evidence.mjs';

// Pure OFFLINE consumer of source-signed observations. No collectors are
// installed, no trusted keys are generated, and no Cloudflare calls are made.
// T11 must audit that the 3 independently provisioned signers actually observe
// DO state, Container process receipts and provider request lifecycle.
export const OBSERVED_JOURNAL_SCHEMA = 'f0-c10-observed-journal-v1';
export const OBSERVER_ORIGINS = Object.freeze(['do', 'container', 'provider']);
const ZERO = '0'.repeat(64);
const observationBytes = (claim) => Buffer.from(
  'OPEN-CODE/F0-C10/OBSERVED-JOURNAL/V1\0' + canonicalJson(claim), 'utf8');
export const operatorApprovalBytes = (claim) => Buffer.from(
  'OPEN-CODE/F0-C10/OBSERVER-APPROVAL/V1\\0' + canonicalJson(claim), 'utf8');
const hex40 = (s) => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const nonempty = (s) => typeof s === 'string' && s.length > 0;
const sha = (v) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const roleFor = (type) => {
  if (type === 'tool_start' || type === 'tool_end' || type === 'test_result') return 'container';
  if (type === 'inference_start' || type === 'inference_end') return 'provider';
  return 'do';
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

// Signed claim format:
// {origin,collectorId,deploymentId,clockProofId,sourceSha,workerVersion,
//  experimentId,fencingToken,seq,epoch,prevHash,observedAtMs,event}
// A source restart emits a signed 'observer_resume' at the next epoch and
// continues from the previous event hash. Lost suffixes or mixed generations
// are never silently reconstructed by the evaluator.
export function verifyObservedJournal(trace, trustedKeys, limits) {
  const errors = [];
  const fail = (code, detail) => errors.push({ code, detail });
  const journal = trace?.observedJournal;
  const meta = trace?.metadata || {};
  if (journal?.schema !== OBSERVED_JOURNAL_SCHEMA || !Array.isArray(journal.records) ||
      journal.records.length === 0) {
    return { pass: false, errors: [{ code: 'OBSERVED_JOURNAL_MISSING', detail: 'no source-signed observations' }] };
  }
  if (meta.simulated === true || meta.fixture === true || meta.synthetic === true ||
      trace.evidenceClass === 'fixture') {
    fail('SYNTHETIC_TRACE_REJECTED', 'fixture provenance is never admissible as real E2E');
  }
  const observerTrust = trustedKeys?.observers;
  // An explicit operator-signed, independently supplied approval of the collector
  // key fingerprints and deployments is required. Event signatures alone are not
  // authority: a model may sign its own fabrications with ephemeral keys.
  const approval = trustedKeys?.approval;
  const operatorPem = trustedKeys?.operatorPublicKeyPem;
  const approvalClaim = approval?.claim;
  try {
    const root = createPublicKey(operatorPem);
    if (root.asymmetricKeyType !== 'ed25519' ||
        !verify(null, operatorApprovalBytes(approvalClaim), root, Buffer.from(approval?.signature || '', 'base64')))
      fail('OPERATOR_APPROVAL_INVALID', 'approval does not verify against external operator root');
  } catch { fail('OPERATOR_APPROVAL_MISSING', 'operator-signed collector approval must be supplied externally'); }
  if (!approvalClaim || approvalClaim.environment !== 'staging' ||
      approvalClaim.experimentId !== meta.experimentId ||
      approvalClaim.sourceSha !== meta.sourceSha ||
      approvalClaim.workerVersion !== meta.workerVersion ||
      approvalClaim.workerDeploymentId !== meta.workerDeploymentId ||
      approvalClaim.mcpDeploymentId !== meta.mcpDeploymentId ||
      approvalClaim.leaseId !== meta.leaseId ||
      approvalClaim.fencingToken !== meta.fencingToken ||
      approvalClaim.clockSyncMaxSkewMs !== meta.clockSyncMaxSkewMs ||
      !nonempty(approvalClaim.clockSyncReceiptId)) {
    fail('OPERATOR_APPROVAL_SCOPE_MISMATCH', 'approval not bound to worker, clocks, lease and experiment');
  }
  const stream = new Map();
  const witnessed = new Map();
  const calls = new Map();
  const fingerprints = new Set();
  const usedRoles = ['runtime', 'artifact', 'telemetry', 'budget'];
  for (const role of usedRoles) {
    const pem = trustedKeys?.[role];
    if (typeof pem === 'string') {
      try { fingerprints.add(createHash('sha256').update(createPublicKey(pem).export({ type:'spki',format:'der' })).digest('hex')); }
      catch { fail('OBSERVER_TRUST_INVALID', role); }
    }
  }
  for (const origin of OBSERVER_ORIGINS) {
    const t = observerTrust?.[origin];
    if (!t || !nonempty(t.publicKeyPem) || !nonempty(t.collectorId) ||
        !nonempty(t.deploymentId) || !nonempty(t.clockProofId) ||
        !hex40(t.sourceSha) || t.sourceSha !== meta.sourceSha ||
        t.environment !== 'staging') {
      fail('OBSERVER_TRUST_MISSING', origin);
      continue;
    }
    try {
      const pub = createPublicKey(t.publicKeyPem);
      if (pub.asymmetricKeyType !== 'ed25519') fail('OBSERVER_KEY_INVALID', origin);
      const fingerprint = createHash('sha256').update(pub.export({ type:'spki', format:'der' })).digest('hex');
      const approved = approvalClaim?.observers?.[origin];
      if (!approved || approved.publicKeySha256 !== fingerprint ||
          approved.collectorId !== t.collectorId || approved.deploymentId !== t.deploymentId ||
          approved.clockProofId !== t.clockProofId) {
        fail('COLLECTOR_NOT_APPROVED', origin);
      }
      if (fingerprints.has(fingerprint)) fail('OBSERVER_KEY_REUSE', origin);
      fingerprints.add(fingerprint);
    } catch { fail('OBSERVER_TRUST_INVALID', origin); }
  }
  if (!nonempty(meta.workerDeploymentId) || observerTrust?.do?.deploymentId !== meta.workerDeploymentId ||
      !nonempty(meta.mcpDeploymentId) || !hex40(meta.sourceSha)) {
    fail('DEPLOYMENT_SCOPE_UNVERIFIED', 'worker/mcp deployment or SHA missing');
  }
  if (!Number.isFinite(meta.clockSyncMaxSkewMs) || meta.clockSyncMaxSkewMs < 0 ||
      meta.clockSyncMaxSkewMs > 250) fail('OBSERVER_CLOCK_UNVERIFIED', 'independent bound <=250ms required');
  const maxSkew = Number.isFinite(meta.clockSyncMaxSkewMs) ? meta.clockSyncMaxSkewMs : Infinity;
  for (const item of journal.records) {
    const claim = item?.claim;
    const origin = claim?.origin;
    if (!OBSERVER_ORIGINS.includes(origin)) { fail('OBSERVER_ORIGIN_UNKNOWN', origin); continue; }
    const config = observerTrust?.[origin];
    if (!config) { fail('OBSERVER_TRUST_MISSING', origin); continue; }
    if (claim.collectorId !== config.collectorId || claim.deploymentId !== config.deploymentId ||
        claim.clockProofId !== config.clockProofId || claim.sourceSha !== meta.sourceSha ||
        claim.workerVersion !== meta.workerVersion || claim.experimentId !== meta.experimentId ||
        claim.fencingToken !== meta.fencingToken) {
      fail('OBSERVER_SCOPE_MISMATCH', origin);
    }
    try {
      const pub = createPublicKey(config.publicKeyPem);
      if (pub.asymmetricKeyType !== 'ed25519' ||
          !verify(null, observationBytes(claim), pub, Buffer.from(item.signature || '', 'base64'))) {
        fail('OBSERVER_SIGNATURE_INVALID', origin);
      }
    } catch { fail('OBSERVER_SIGNATURE_INVALID', origin); }
    const previous = stream.get(origin);
    const expectedSeq = (previous?.seq || 0) + 1;
    if (!Number.isSafeInteger(claim.seq) || claim.seq !== expectedSeq ||
        !Number.isSafeInteger(claim.epoch) || claim.epoch < 1 ||
        claim.prevHash !== (previous?.hash || ZERO)) {
      fail('JOURNAL_GAP_OR_REPLAY', origin);
    }
    const event = claim.event;
    const restarting = event?.type === 'observer_resume';
    if (!previous && (claim.epoch !== 1 || restarting)) fail('JOURNAL_INVALID_FIRST_EPOCH', origin);
    if (previous) {
      if (restarting && claim.epoch !== previous.epoch + 1) fail('JOURNAL_INVALID_RECOVERY', origin);
      if (!restarting && claim.epoch !== previous.epoch) fail('JOURNAL_UNACKNOWLEDGED_RESTART', origin);
      if (claim.observedAtMs < previous.atMs) fail('JOURNAL_NONMONOTONIC_CLOCK', origin);
    }
    if (!Number.isSafeInteger(claim.observedAtMs)) fail('JOURNAL_INVALID_CLOCK', origin);
    if (restarting) {
      if (!previous || event.lastVerifiedHash !== previous.hash ||
          [...calls.values()].some((c) => c.origin === origin)) {
        fail('JOURNAL_RESTART_WITH_INFLIGHT_EFFECT', origin);
      }
    } else {
      if (!event || roleFor(event.type) !== origin || event.type === 'artifact_readback') {
        fail('OBSERVER_EVENT_WRONG_SOURCE', event?.type);
      } else {
        if (event.experimentId !== meta.experimentId || event.sourceSha !== meta.sourceSha ||
            event.fencingToken !== meta.fencingToken || event.source !== 'runtime' ||
            !Number.isSafeInteger(event.atMs) ||
            !Number.isFinite(maxSkew) || Math.abs(event.atMs - claim.observedAtMs) > maxSkew) {
          fail('OBSERVER_EVENT_SCOPE_OR_CLOCK', event?.type);
        }
        if (origin === 'container' && ['tool_start','tool_end'].includes(event.type) &&
            (!nonempty(event.containerId) || !nonempty(event.commandSha256) ||
             !/^[a-f0-9]{64}$/.test(event.commandSha256))) fail('CONTAINER_RECEIPT_MISSING', event?.requestId);
        if (origin === 'provider' && ['inference_start','inference_end'].includes(event.type) &&
            (!nonempty(event.providerRequestId) || !nonempty(event.model))) fail('INFERENCE_RECEIPT_MISSING', event?.requestId);
        const identity = String(event.requestId) + ':' + String(event.seq);
        if (witnessed.has(identity)) fail('DUPLICATE_OBSERVATION', identity);
        witnessed.set(identity, event);
        const activityType = event.type === 'tool_start' || event.type === 'tool_end' ? 'tool' :
          event.type === 'inference_start' || event.type === 'inference_end' ? 'inference' : null;
        if (activityType) {
          const key = origin + '/' + event.requestId + '/' + event.callId;
          if (event.type.endsWith('_start')) {
            if (calls.has(key)) fail('DUPLICATE_OBSERVED_START', key);
            else calls.set(key, { origin, epoch: claim.epoch, containerId:event.containerId, commandSha256:event.commandSha256,
              providerRequestId:event.providerRequestId, atMs:event.atMs });
          } else {
            const started = calls.get(key);
            if (!started || started.epoch !== claim.epoch || event.atMs <= started.atMs ||
                (origin === 'container' && (started.containerId !== event.containerId ||
                 started.commandSha256 !== event.commandSha256)) ||
                (origin === 'provider' && started.providerRequestId !== event.providerRequestId)) {
              fail('UNMATCHED_OBSERVED_END', key);
            }
            calls.delete(key);
          }
        }
      }
    }
    stream.set(origin, { seq: claim.seq, epoch: claim.epoch, hash: sha(claim), atMs: claim.observedAtMs });
  }
  if (calls.size) fail('UNFINISHED_OBSERVED_ACTIVITY', [...calls.keys()].slice(0,4));
  const expected = (trace.events || []).filter((e) => e.type !== 'artifact_readback');
  if (expected.length !== witnessed.size) fail('OBSERVED_EVENT_COUNT_MISMATCH', { expected:expected.length, witnessed:witnessed.size });
  for (const event of expected) {
    const id = String(event.requestId) + ':' + String(event.seq);
    const observed = witnessed.get(id);
    if (!observed || !same(event, observed)) fail('OBSERVED_EVENT_MISMATCH', id);
  }
  for (const origin of OBSERVER_ORIGINS) {
    const required = origin === 'do' || (trace.events || []).some((e) => roleFor(e.type) === origin);
    if (required && !stream.has(origin)) fail('OBSERVER_SOURCE_UNOBSERVED', origin);
  }
  // A time window remains valid only after subtracting worst-case clock drift.
  return { pass: errors.length === 0, errors, witnessedCount:witnessed.size,
    clockUncertaintyMs: Number.isFinite(maxSkew) ? maxSkew * 2 : null };
}

export const observedClaimBytes = observationBytes; // fixture signing only; not a production collector
export const observedClaimHash = sha;

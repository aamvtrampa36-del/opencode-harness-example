import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runMock } from './mock.mjs';
import { evaluateCampaign, evaluateTrace, LIVE_LIMITS } from './evaluate.mjs';
import { EVIDENCE_ROLES, digest, signingBytes, verifyLiveEvidence } from './live-evidence.mjs';
import { observedClaimBytes, observedClaimHash, OBSERVED_JOURNAL_SCHEMA } from './observed-journal.mjs';

// Test-only ephemeral signing keys. Never ship private keys to Staging or model tools.
const keys = Object.fromEntries(EVIDENCE_ROLES.map((role) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return [role, {
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }];
}));
const trust = Object.fromEntries(EVIDENCE_ROLES.map((role) => [role, keys[role].publicKey]));
const limits = { ...LIVE_LIMITS, maxCostUsd: 1, maxCampaignCostUsd: 3 };
const observerKeys = Object.fromEntries(['do','container','provider'].map((origin) => {
  const pair = generateKeyPairSync('ed25519');
  return [origin, pair];
}));
trust.observers = Object.fromEntries(Object.entries(observerKeys).map(([origin,pair]) => [origin, {
  publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  collectorId: 'offline-observer-' + origin, deploymentId: origin === 'do' ? 'offline-worker-deployment' : 'offline-' + origin + '-deployment',
  clockProofId: 'offline-clock-proof-' + origin, sourceSha: 'f'.repeat(40),
  environment: 'staging',
}]));
function buildJournal(trace, { restartDoAfter = null } = {}) {
  const state = new Map(), records = [];
  let doCount = 0, restarted = false;
  const append = (origin, event, overrideEpoch = null) => {
    const previous = state.get(origin);
    const config = trust.observers[origin];
    const claim = {
      origin, collectorId:config.collectorId, deploymentId:config.deploymentId,
      clockProofId: config.clockProofId, sourceSha:trace.metadata.sourceSha,
      workerVersion:trace.metadata.workerVersion, experimentId:trace.metadata.experimentId,
      fencingToken: trace.metadata.fencingToken, seq:(previous?.seq ?? 0) + 1,
      epoch:overrideEpoch ?? previous?.epoch ?? 1,
      prevHash:previous?.hash ?? '0'.repeat(64), observedAtMs:event.atMs ?? previous?.atMs, event,
    };
    records.push({ claim, signature:sign(null, observedClaimBytes(claim), observerKeys[origin].privateKey).toString('base64') });
    state.set(origin, { seq:claim.seq, epoch:claim.epoch, hash:observedClaimHash(claim), atMs:claim.observedAtMs });
  };
  for (const event of trace.events) {
    if (event.type === 'artifact_readback') continue;
    const origin = ['tool_start','tool_end','test_result'].includes(event.type) ? 'container' :
      ['inference_start','inference_end'].includes(event.type) ? 'provider' : 'do';
    if (origin === 'do' && restartDoAfter !== null && !restarted && doCount >= restartDoAfter) {
      const prev = state.get('do');
      append('do', {type:'observer_resume',lastVerifiedHash:prev.hash,atMs:event.atMs}, prev.epoch + 1);
      restarted = true;
    }
    append(origin,event);
    if (origin === 'do') doCount++;
  }
  trace.observedJournal = { schema:OBSERVED_JOURNAL_SCHEMA, records };
  return trace;
}

function reseal(trace) {
  trace.attestations = Object.fromEntries(EVIDENCE_ROLES.map((role) =>
    [role, { signature: sign(null, signingBytes(trace, role), keys[role].privateKey).toString('base64') }]));
  return trace;
}

async function attestedFixture({ round = 1, size = 10, fault = null } = {}) {
  const trace = await runMock({ size, fault });
  trace.mode = 'live';
  trace.metadata.experimentId = 'r2-synthetic-signed-' + round;
  trace.metadata.gitBaseSha = 'a'.repeat(40);
  delete trace.metadata.simulated;
  trace.metadata.workerDeploymentId = 'offline-worker-deployment';
  trace.metadata.mcpDeploymentId = 'offline-mcp-deployment';
  trace.metadata.workerVersion = 'fixture-worker-only';
  trace.metadata.mcpVersion = 'fixture-mcp-only';
  trace.metadata.environment = 'staging';
  trace.metadata.leaseId = 'fixture-lock';
  trace.metadata.fencingToken = 'fixture-fence';
  trace.metadata.clockSyncMaxSkewMs = 0;
  trace.metadata.limitsSha256 = digest(limits);
  trace.metadata.sourceClock = 'server';
  trace.metadata.evidenceOrigin = 'independent_runtime';
  trace.metadata.spendStopVerified = true;
  trace.metadata.measuredTotalUsd = 0.002;
  trace.metadata.observabilityQueryId = 'fixture-cloudflare-query';
  trace.metadata.exclusiveLeaseAtomicVerified = true;
  const original = Math.min(...trace.events.map((e) => e.atMs));
  const mapping = new Map();
  for (const task of trace.tasks) {
    const old = task.requestId;
    const next = (0xf0c1000000000000n + BigInt(round * 100 + Number.parseInt(task.requestId.slice(-2), 16))).toString(16);
    mapping.set(old, next);
    task.requestId = next;
    task.sessionId = 'ses_mock_' + next;
    task.operationId = 'op_mock_' + next;
    task.projectId = 'synthetic-' + next;
    task.executorId = 'mock-' + next;
    task.experimentId = trace.metadata.experimentId;
  }
  for (const event of trace.events) {
    const requestId = mapping.get(event.requestId);
    const task = trace.tasks.find((t) => t.requestId === requestId);
    event.requestId = requestId;
    event.sessionId = task.sessionId;
    event.operationId = task.operationId;
    event.projectId = task.projectId;
    event.executorId = task.executorId;
    event.experimentId = trace.metadata.experimentId;
    event.atMs = original + (event.atMs - original) * 20;
    event.source = event.type === 'artifact_readback' ? 'artifact-collector' : 'runtime';
    event.fencingToken = trace.metadata.fencingToken;
    if (event.type === 'tool_start' || event.type === 'tool_end') {
      event.containerId = 'offline-container-' + task.requestId;
      event.commandSha256 = 'b'.repeat(64);
    }
    if (event.artifact) {
      event.artifact.projectId = task.projectId;
      event.artifact.path = 'tmp/f0-c10/' + requestId + '/' + task.kind + '.json';
    }
    if (event.type === 'artifact_readback') {
      const bytes = Buffer.from(event.artifact.content, 'utf8');
      event.artifact.bytesBase64 = bytes.toString('base64');
      event.artifact.byteLength = bytes.length;
      event.artifact.retrievedAtMs = event.atMs;
      event.retrieval = 'authenticated-byte-read';
      event.retrievalReceipt = {
        method: 'GET', status: 200, authenticated: true,
        retrievalId: 'fixture-retrieval-' + requestId,
        sha256: event.artifact.sha256, byteLength: bytes.length,
      };
    }
  }
  const activityStarts = trace.events.filter((e) => e.type === 'tool_start').map((e) => e.atMs);
  const activityEnds = trace.events.filter((e) => e.type === 'tool_end').map((e) => e.atMs);
  trace.telemetry = [{ source: 'cloudflare', service: 'opencode-g1-staging',
    workerVersion: trace.metadata.workerVersion, queryId: trace.metadata.observabilityQueryId,
    atMs: (Math.max(...activityStarts) + Math.min(...activityEnds)) / 2, isolateMiB: 67 }];
  trace.budget = {
    experimentId: trace.metadata.experimentId,
    capUsd: 1, totalUsd: 0.002,
    components: { inference: 0.002, workers: 0, durableObjects: 0, containers: 0, observability: 0, ci: 0, egress: 0 },
    stop: { enforced: true, controlId: 'fixture-spend-stop', scope: 'full-experiment' },
    meterReceiptId: 'fixture-cost-meter',
  };
  buildJournal(trace);
  return reseal(trace);
}

test('GREEN signed live-format fixture validates receipt roles and 10 overlapping activities', async () => {
  const trace = await attestedFixture();
  const report = evaluateTrace(trace, { mode: 'live', trustedKeys: trust, limits });
  assert.equal(report.pass, true, JSON.stringify(report.failures));
  assert.equal(report.metrics.maxActive, 10);
  assert.ok(report.metrics.longestFullMs >= 1000);
});
test('RED tampered runtime timestamp invalidates independent signature', async () => {
  const trace = await attestedFixture();
  trace.events.find((e) => e.type === 'tool_start').atMs += 300;
  assert.ok(evaluateTrace(trace, { mode: 'live', trustedKeys: trust, limits }).failures.some((f) => f.code === 'ATTESTATION_INVALID'));
});
test('RED forged Cloudflare isolate reading invalidates telemetry signature', async () => {
  const trace = await attestedFixture();
  trace.telemetry[0].isolateMiB = 2;
  assert.ok(verifyLiveEvidence(trace, trust, limits).failures.some((f) => f.code === 'ATTESTATION_INVALID' && f.detail === 'telemetry'));
});
test('RED trace-provided keys cannot authenticate itself', async () => {
  const trace = await attestedFixture();
  trace.trustedKeys = trust;
  const report = evaluateTrace(trace, { mode: 'live', limits });
  assert.ok(report.failures.some((f) => f.code === 'ATTESTATION_MISSING'));
});
test('RED one signer reused for all collectors is rejected', async () => {
  const trace = await attestedFixture();
  const reused = Object.fromEntries(EVIDENCE_ROLES.map((role) => [role, trust.runtime]));
  assert.ok(verifyLiveEvidence(trace, reused, limits).failures.some((f) => f.code === 'ATTESTATION_KEY_REUSE'));
});
test('RED wrong SHA cannot be legalized even if signer reseals the bundle', async () => {
  const trace = await attestedFixture();
  trace.events[0].sourceSha = '0'.repeat(40);
  reseal(trace);
  assert.ok(evaluateTrace(trace, { mode: 'live', limits, trustedKeys: trust }).failures.some((f) => f.code === 'EVENT_EVIDENCE_SCOPE'));
});
test('RED missing artifact after completion is not PASS', async () => {
  const trace = await attestedFixture();
  const eventIndex = trace.events.findIndex((e) => e.type === 'artifact_readback');
  trace.events.splice(eventIndex, 1);
  reseal(trace);
  assert.ok(evaluateTrace(trace, { mode: 'live', limits, trustedKeys: trust }).failures.some((f) => f.code === 'ARTIFACT_READBACK_MISSING'));
});
test('RED corrupted independently retrieved bytes are rejected', async () => {
  const trace = await attestedFixture();
  trace.events.find((e) => e.type === 'artifact_readback').artifact.bytesBase64 = Buffer.from('forged').toString('base64');
  reseal(trace);
  assert.ok(evaluateTrace(trace, { mode: 'live', limits, trustedKeys: trust }).failures.some((f) => f.code === 'ARTIFACT_BYTES_MISMATCH'));
});
test('RED unsigned or unknown cost fails closed', async () => {
  const trace = await attestedFixture();
  trace.budget.components.inference = null;
  trace.budget.meterReceiptId = '';
  reseal(trace);
  assert.ok(evaluateTrace(trace, { mode: 'live', limits, trustedKeys: trust }).failures.some((f) => f.code === 'BUDGET_ACCOUNTING_INVALID'));
});
test('RED provider stop self-claim does not pass without effective signed budget', async () => {
  const trace = await attestedFixture();
  trace.budget.stop.enforced = false;
  reseal(trace);
  assert.ok(evaluateTrace(trace, { mode: 'live', limits, trustedKeys: trust }).failures.some((f) => f.code === 'BUDGET_CONTROL_UNVERIFIED'));
});
test('RED historical #90 remains rejected under the signed-fixture format', async () => {
  const trace = await attestedFixture({ fault: 'historical-red' });
  const report = evaluateTrace(trace, { mode: 'live', limits, trustedKeys: trust });
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((f) => f.code === 'OOM'));
});
test('RED forged ten-HTTP scenario without ten intervals', async () => {
  const trace = await attestedFixture();
  const retired = new Set(trace.tasks.slice(4).map((t) => t.requestId));
  trace.events = trace.events.filter((e) => !retired.has(e.requestId) || !['tool_start', 'tool_end'].includes(e.type));
  reseal(trace);
  const report = evaluateTrace(trace, { mode: 'live', limits, trustedKeys: trust });
  assert.ok(report.failures.some((f) => f.code === 'INSUFFICIENT_REAL_OVERLAP'));
});
test('GREEN signed-format campaign with 3 synthetic independent rounds', async () => {
  const rounds = await Promise.all([1, 2, 3].map((round) => attestedFixture({ round })));
  const report = evaluateCampaign(rounds, limits, { trustedKeys: trust });
  assert.equal(report.pass, true, JSON.stringify(report));
});
test('RED reused requestId between rounds blocks acceptance', async () => {
  const trace = await attestedFixture();
  const other = await attestedFixture({ round: 2 });
  other.tasks[0].requestId = trace.tasks[0].requestId;
  const report = evaluateCampaign([trace, other, await attestedFixture({ round: 3 })], limits, { trustedKeys: trust });
  assert.equal(report.code, 'REUSED_REQUEST_BETWEEN_ROUNDS');
});
test('CLI without externally supplied trust and limits exits 2 without Remote calls', () => {
  const probe = spawnSync(process.execPath, ['scripts/f0-c10/verify-live.mjs'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(probe.status, 2);
  assert.match(probe.stderr, /FAIL-CLOSED/);
});

test('RED Cloudflare OOM observation rejects signed trace even if agent reports success', async () => {
  const trace = await attestedFixture();
  trace.telemetry[0].outcome = 'exceededMemory';
  reseal(trace);
  const report = evaluateTrace(trace, { mode: 'live', trustedKeys: trust, limits });
  assert.ok(report.failures.some((f) => f.code === 'CLOUDFLARE_OOM_OR_RESET'));
});
test('RED status reads outside ten-way overlap are not enough', async () => {
  const trace = await attestedFixture();
  const lastToolEnd = Math.max(...trace.events.filter((e) => e.type === 'tool_end').map((e) => e.atMs));
  // Deterministically put every status read after the entire ten-way window.
  for (const event of trace.events) {
    if (event.type === 'status_probe') event.atMs = lastToolEnd + 1000;
  }
  reseal(trace);
  const report = evaluateTrace(trace, { mode: 'live', trustedKeys: trust, limits });
  assert.ok(report.failures.some((f) => f.code === 'NO_TEN_WAY_STATUS_PROBE'));
});
test('RED three individually affordable rounds cannot exceed a predeclared campaign cap', async () => {
  const strict = { ...limits, maxCampaignCostUsd: 0.003 };
  const rounds = await Promise.all([1, 2, 3].map((round) => attestedFixture({ round })));
  for (const trace of rounds) {
    trace.metadata.limitsSha256 = digest(strict);
    reseal(trace);
  }
  const report = evaluateCampaign(rounds, strict, { trustedKeys: trust });
  assert.equal(report.pass, false);
  assert.equal(report.code, 'CAMPAIGN_COST_UNKNOWN_OR_OVER_CAP');
});

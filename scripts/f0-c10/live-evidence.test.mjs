import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runMock } from './mock.mjs';
import { evaluateCampaign, evaluateTrace, LIVE_LIMITS } from './evaluate.mjs';
import { EVIDENCE_ROLES, digest, signingBytes, verifyLiveEvidence } from './live-evidence.mjs';
import { observedClaimBytes, observedClaimHash, operatorApprovalBytes, OBSERVED_JOURNAL_SCHEMA } from './observed-journal.mjs';

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
const operatorKeyPair = generateKeyPairSync('ed25519');
trust.operatorPublicKeyPem=operatorKeyPair.publicKey.export({format:'pem',type:'spki'});
trust.approvals={};
function approveCollectorScope(trace) {
  const metadata=trace.metadata;
  const observers=Object.fromEntries(Object.entries(trust.observers).map(([origin,info])=> {
    const key=observerKeys[origin].publicKey.export({type:'spki',format:'der'});
    return [origin,{collectorId:info.collectorId,deploymentId:info.deploymentId,clockProofId:info.clockProofId,
      publicKeySha256:createHash('sha256').update(key).digest('hex')}];
  }));
  const claim={environment:'staging',experimentId:metadata.experimentId,sourceSha:metadata.sourceSha,
    workerVersion:metadata.workerVersion,workerDeploymentId:metadata.workerDeploymentId,
    mcpDeploymentId:metadata.mcpDeploymentId,leaseId:metadata.leaseId,
    fencingToken:metadata.fencingToken,clockSyncMaxSkewMs:metadata.clockSyncMaxSkewMs,
    clockSyncReceiptId:'offline-clock-sync-only',observers};
  trust.approvals[metadata.experimentId]={
    claim,signature:sign(null,operatorApprovalBytes(claim),operatorKeyPair.privateKey).toString('base64'),
  };
}
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
      prevHash:previous?.hash ?? '0'.repeat(64), observedAtMs:event.atMs ?? previous?.atMs, event:structuredClone(event),
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
  approveCollectorScope(trace);
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


test('R3 RED: R2-style signed live JSON without observed source journal is rejected', async () => {
  const trace = await attestedFixture();
  delete trace.observedJournal;
  reseal(trace);
  const report = evaluateTrace(trace, {mode:'live',trustedKeys:trust,limits});
  assert.equal(report.pass,false);
  assert.ok(report.failures.some((f)=>f.code==='OBSERVED_JOURNAL_MISSING'));
});
test('R3 RED: mock labelled runtime and signed by fixtures is NEVER live evidence', async () => {
  const trace = await attestedFixture();
  trace.metadata.simulated = true;
  reseal(trace);
  const result = evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(result.failures.some((f)=>f.code==='SYNTHETIC_TRACE_REJECTED'));
});
test('R3 RED: model-generated source signature cannot replace externally pinned observer key', async () => {
  const trace = await attestedFixture();
  const attacker = generateKeyPairSync('ed25519');
  const claim = trace.observedJournal.records.find((r)=>r.claim.origin==='container').claim;
  const receipt = trace.observedJournal.records.find((r)=>r.claim===claim);
  receipt.signature=sign(null,observedClaimBytes(claim),attacker.privateKey).toString('base64');
  trace.modelProvidedPublicKey=attacker.publicKey.export({format:'pem',type:'spki'});
  const result=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(result.failures.some((f)=>f.code==='OBSERVER_SIGNATURE_INVALID'));
});
test('R3 RED: ten HTTP/admission starts without tool or inference receipts cannot PASS', async () => {
  const trace=await attestedFixture();
  trace.events=trace.events.filter((e)=>!['tool_start','tool_end'].includes(e.type));
  buildJournal(trace);
  reseal(trace);
  const report=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.equal(report.metrics.maxActive,0);
  assert.ok(report.failures.some((f)=>f.code==='INSUFFICIENT_REAL_OVERLAP'));
});
test('R3 RED: source says busy even with signed success claim but lacks tool intervals', async () => {
  const trace=await attestedFixture();
  trace.events=trace.events.filter((e)=>!['tool_start','tool_end'].includes(e.type));
  for (const event of trace.events) if (event.type==='execution_start') event.busy=true;
  buildJournal(trace);
  reseal(trace);
  assert.ok(evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits}).failures.some((f)=>f.code==='NO_EXECUTION_EVIDENCE'));
});
test('R3 RED: model fabricates interval in trace after collector signs raw events', async () => {
  const trace=await attestedFixture();
  const forged=trace.events.find((e)=>e.type==='tool_end');
  forged.atMs+=50000;
  reseal(trace); // re-sign only legacy runtime bundle, NOT the observer receipts
  const result=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(result.failures.some((f)=>f.code==='OBSERVED_EVENT_MISMATCH'));
});
test('R3 RED: lost response after tool completion is not success', async () => {
  const trace=await attestedFixture();
  trace.events=trace.events.filter((e)=>e.type!=='completed' || e.requestId!==trace.tasks[0].requestId);
  buildJournal(trace);
  reseal(trace);
  assert.ok(evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits}).failures.some((f)=>f.code==='MISSING_OR_DUPLICATE_COMPLETED'));
});
test('R3 RED: byte-readback from another request does not prove output', async () => {
  const trace=await attestedFixture();
  const reads=trace.events.filter((e)=>e.type==='artifact_readback');
  reads[0].artifact={...reads[1].artifact};
  reseal(trace);
  assert.ok(evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits}).failures.some((f)=>f.code==='OUTPUT_ISOLATION'||f.code==='ARTIFACT_READBACK_MISMATCH'));
});
test('R3 RED: clock source skew cannot be hidden by re-signing runtime JSON', async () => {
  const trace=await attestedFixture();
  trace.events.find((e)=>e.type==='tool_start').atMs+=1500;
  reseal(trace);
  const report=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(report.failures.some((f)=>f.code==='OBSERVED_EVENT_MISMATCH'));
});
test('R3 RED: falsified signed observer clock diverges from event clock', async () => {
  const trace=await attestedFixture();
  const first=trace.observedJournal.records[0];
  first.claim.observedAtMs+=1000;
  first.signature=sign(null,observedClaimBytes(first.claim),observerKeys[first.claim.origin].privateKey).toString('base64');
  const report=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(report.failures.some((f)=>f.code==='OBSERVER_EVENT_SCOPE_OR_CLOCK'));
});
test('R3 RED: interrupted journal after restart has no contiguous seq/hash', async () => {
  const trace=await attestedFixture();
  buildJournal(trace,{restartDoAfter:7});
  const records=trace.observedJournal.records;
  records.splice(records.findIndex((r)=>r.claim.event.type==='observer_resume'),1);
  const result=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(result.failures.some((f)=>f.code==='JOURNAL_GAP_OR_REPLAY'||f.code==='JOURNAL_UNACKNOWLEDGED_RESTART'));
});
test('R3 GREEN: durable DO observer restarts while Container events interleave', async () => {
  const trace=await attestedFixture();
  buildJournal(trace,{restartDoAfter:7});
  const report=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.equal(report.pass,true,JSON.stringify(report.failures));
  assert.ok(trace.observedJournal.records.some((r)=>r.claim.event.type==='observer_resume'));
});
test('R3 RED: incomplete tool receipt cannot span container observer epoch', async () => {
  const trace=await attestedFixture();
  const firstContainer=trace.observedJournal.records.find((r)=>r.claim.origin==='container');
  const lastContainer=trace.observedJournal.records.findLast((r)=>r.claim.origin==='container');
  lastContainer.claim.epoch=firstContainer.claim.epoch+1;
  lastContainer.signature=sign(null,observedClaimBytes(lastContainer.claim),observerKeys.container.privateKey).toString('base64');
  const report=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(report.failures.some((f)=>f.code==='JOURNAL_UNACKNOWLEDGED_RESTART'||f.code==='UNMATCHED_OBSERVED_END'));
});
test('R3 RED: independent signed worker origin cannot be replaced by shared mock key', async () => {
  const trace=await attestedFixture();
  const wrong={...trust,observers:{...trust.observers,container:{...trust.observers.container,publicKeyPem:trust.observers.do.publicKeyPem}}};
  const report=evaluateTrace(trace,{mode:'live',trustedKeys:wrong,limits});
  assert.ok(report.failures.some((f)=>f.code==='OBSERVER_KEY_REUSE'||f.code==='OBSERVER_SIGNATURE_INVALID'));
});
test('R3 RED: unexpected cancellation and OOM remain rejected with observer journal', async () => {
  for (const fault of ['cancelled','oom']) {
    const trace=await attestedFixture({fault});
    const result=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
    assert.equal(result.pass,false);
    assert.ok(result.failures.some((f)=>f.code=== (fault==='oom'?'OOM':'UNEXPECTED_FAILURES')));
  }
});
test('R3 RED: unknown total cost remains blocked even with ten observed tool receipts', async () => {
  const trace=await attestedFixture();
  trace.budget.components.inference=null;
  reseal(trace);
  assert.ok(evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits}).failures.some((f)=>f.code==='BUDGET_ACCOUNTING_INVALID'));
});
test('R3 RED: provider inference without independently signed provider journal is rejected', async () => {
  const trace=await attestedFixture({size:1});
  const start=trace.events.find((e)=>e.type==='tool_start');
  const base={...start,callId:'inference-1',providerRequestId:'provider-request-1',model:'fixture-model'};
  const extras=[
    {...base,type:'inference_start',atMs:start.atMs+1},
    {...base,type:'inference_end',atMs:start.atMs+2,outcome:'success'},
  ];
  trace.events.push(...extras);
  const events=trace.events.filter((e)=>e.requestId===trace.tasks[0].requestId).sort((a,b)=>a.atMs-b.atMs);
  events.forEach((e,i)=>e.seq=i+1);
  buildJournal(trace);
  reseal(trace);
  // Source-matched provider receipts are present and signed; removing them must fail.
  trace.observedJournal.records=trace.observedJournal.records.filter((r)=>r.claim.origin!=='provider');
  const report=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(report.failures.some((f)=>f.code==='OBSERVER_SOURCE_UNOBSERVED'||f.code==='OBSERVED_EVENT_COUNT_MISMATCH'));
});

test('R3 RED: a model-provided collector approval cannot replace operator trust', async () => {
  const trace=await attestedFixture();
  const modelRoot=generateKeyPairSync('ed25519');
  const bad={...trust,operatorPublicKeyPem:modelRoot.publicKey.export({type:'spki',format:'pem'})};
  trace.modelApprovalSignature=sign(null,operatorApprovalBytes(trust.approvals[trace.metadata.experimentId].claim),modelRoot.privateKey).toString('base64');
  const result=evaluateTrace(trace,{mode:'live',trustedKeys:bad,limits});
  assert.ok(result.failures.some((f)=>f.code==='OPERATOR_APPROVAL_INVALID'));
});
test('R3 RED: independently signed approval for a different SHA or deployment is not valid', async () => {
  const trace=await attestedFixture();
  trace.metadata.workerDeploymentId='unpublished-deployment';
  reseal(trace);
  const result=evaluateTrace(trace,{mode:'live',trustedKeys:trust,limits});
  assert.ok(result.failures.some((f)=>f.code==='DEPLOYMENT_SCOPE_UNVERIFIED'||f.code==='OPERATOR_APPROVAL_SCOPE_MISMATCH'));
});

/** M07 integrated positive fixture: real crypto + T10 + exact M06 layout +
 * signed GitHub and physical/logical closure, no real task or network. */
import {assessLiveCandidate} from './metralla-m07/evaluator.mjs';
import {artifactExpectation,roundApprovalBytes,supplementalBytes,journalSealBytes,collectObserverPages,collectRoundReadbacks} from './metralla-m07/integrated-round.mjs';
import {canonicalOutput} from './tasks.mjs';
const extraPairs=Object.fromEntries(['github','physical','logical'].map(k=>[k,generateKeyPairSync('ed25519')]));
const extraTrust=Object.fromEntries(Object.entries(extraPairs).map(([k,v])=>[k,v.publicKey.export({format:'pem',type:'spki'})]));
const keyFp=pem=>createHash('sha256').update(createPublicKey(pem).export({format:'der',type:'spki'})).digest('hex');
async function integratedFixture(size=10){
 const trace=await attestedFixture({size,round:500+size});
 const t=structuredClone(trace),m=t.metadata;m.artifactLayout='m06-dist-v1';
 for(const task of t.tasks){
  task.sessionId='ses_r2_'+task.requestId;task.operationId='rc-start-'+task.requestId;task.projectId='supervised-'+task.requestId;
  for(const e of t.events.filter(e=>e.requestId===task.requestId)){
   e.sessionId=task.sessionId;e.operationId=task.operationId;e.projectId=task.projectId;
   if(e.artifact){e.artifact.projectId=task.projectId;e.artifact.path='dist/'+task.kind+'.json';}
  }
 }
 buildJournal(t);approveCollectorScope(t);reseal(t);
 const keys={...trust,supplemental:extraTrust};
 const identity=x=>Object.fromEntries(['requestId','sessionId','operationId','projectId','executorId','kind'].map(k=>[k,x[k]]));
 const fields=['experimentId','sourceSha','gitBaseSha','workerVersion','mcpVersion','workerDeploymentId','mcpDeploymentId','leaseId','fencingToken','limitsSha256'];
 const tasks=t.tasks.map((task,i)=>({...identity(task),artifact:artifactExpectation(task),github:i===size-1?{repo:'aamvtrampa36-del/opencode-harness-example',base:'fixture-base',baseSha:m.gitBaseSha,branch:'opencode/staging-'+task.requestId,path:'docs/opencode-agent-lab/fixture-report.json'}:null}));
 const last=Math.max(...t.events.map(e=>e.atMs)),plan={schema:'metralla.m07.integrated-round.v1',mode:'fixture',environment:'staging',context:Object.fromEntries(fields.map(k=>[k,m[k]])),
  notBefore:Math.min(...t.events.map(e=>e.atMs))-1,expiresAt:last+10000,approvalRef:'offline-test-only',tasks,
  keyPins:Object.fromEntries([...EVIDENCE_ROLES.map(k=>[k,keyFp(keys[k])]),...['do','container','provider'].map(k=>['observer:'+k,keyFp(keys.observers[k].publicKeyPem)]),...Object.keys(extraTrust).map(k=>[k,keyFp(extraTrust[k])])])};
 const approval={plan,signature:sign(null,roundApprovalBytes(plan),operatorKeyPair.privateKey).toString('base64')};
 const pub=tasks.at(-1),g=pub.github,content=canonicalOutput(pub.kind);
 const intent={repo:g.repo,requestId:pub.requestId,sessionId:pub.sessionId,operationId:pub.operationId,projectId:pub.projectId,sourceSha:m.sourceSha,base:g.base,baseSha:g.baseSha,branch:g.branch,headSha:'b'.repeat(40),headTree:'c'.repeat(40),pr:1,files:[{path:g.path,sha:createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0').update(content).digest('hex'),status:'added'}]};
 const rows={github:[{...identity(pub),observedAtMs:last+1,observation:{schema:'metralla.m08.github-readback.v1',evidenceClass:'unsigned-authenticated-http-observation',livePass:false,verified:true,intent,intentSha256:digest(intent)}}],
 physical:tasks.map(task=>({...identity(task),observedAtMs:last+2,containerId:'offline-container-'+task.requestId,bootId:'offline-boot',closeOperation:'offline-close',snapshotDigest:'a'.repeat(64),taskDigest:'b'.repeat(64),nativeReceiptDigest:'c'.repeat(64),vmTerminated:true,descendants:0,nativeOperations:0,nativeSource:'independent-native'})),logical:[]};
 rows.logical=rows.physical.map(a=>({...identity(a),observedAtMs:last+3,taskDigest:a.taskDigest,physicalReceiptSha256:digest(a),generation:1,slotReleased:true,reservedMicroUsd:0,unknownMicroUsd:0,outstandingEffects:0,releaseReceiptDigest:'d'.repeat(64)}));
 const sealRole=(role,rows)=>({rows,signature:sign(null,supplementalBytes(role,plan,rows),extraPairs[role].privateKey).toString('base64')});
 const supplement=Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,sealRole(k,v)]));
 const journalSeals=Object.fromEntries(['do','container','provider'].map(origin=>{
  const records=t.observedJournal.records.filter(x=>x.claim.origin===origin),tail=records.at(-1)?.claim,seal={origin,count:records.length,head:tail?observedClaimHash(tail):'0'.repeat(64),complete:true,observedAtMs:last+4,collectorId:keys.observers[origin].collectorId,deploymentId:keys.observers[origin].deploymentId};
  return [origin,{seal,signature:sign(null,journalSealBytes(plan,seal),observerKeys[origin].privateKey).toString('base64')}];
 }));
 return {t,options:{limits,trustedKeys:keys,approval,supplement,journalSeals},sealRole};
}
for(const n of [1,2,4,10])test('M07 integrated signed-format fixture '+n+'; no live PASS',async()=>{
 const {t,options}=await integratedFixture(n),r=assessLiveCandidate(t,options);
 assert.equal(r.contractPass,true,JSON.stringify(r));assert.equal(r.livePass,false);assert.equal(r.pass,false);assert.equal(r.t10.metrics.maxActive,n);
});
test('M07 rejects missing closure, tampered signature, fake physical release and foreign GitHub even if resealed',async()=>{
 const {t,options,sealRole}=await integratedFixture(2);
 const original=structuredClone(options.supplement);
 for(const [role,mutate] of [['physical',v=>{v[0].descendants=1;}],['logical',v=>{v[0].unknownMicroUsd=1;}],['logical',v=>{v[0].physicalReceiptSha256='0'.repeat(64);}],['github',v=>{v[0].observation.intent.files[0].path='outside.json';v[0].observation.intentSha256=digest(v[0].observation.intent);}]]){
  const rows=structuredClone(original[role].rows);mutate(rows);
  assert.equal(assessLiveCandidate(t,{...options,supplement:{...original,[role]:sealRole(role,rows)}}).contractPass,false);
 }
 assert.equal(assessLiveCandidate(t,{...options,supplement:{...original,physical:undefined}}).contractPass,false);
 const tampered=structuredClone(original);tampered.logical.rows[0].generation++;
 assert.equal(assessLiveCandidate(t,{...options,supplement:tampered}).contractPass,false);
});
test('M07 denies changed signed plan, reused signer, source seal truncation, legacy artifact and fixture collection',async()=>{
 const {t,options}=await integratedFixture(1);
 const altered=structuredClone(options.approval);altered.plan.mode='live';
 assert.equal(assessLiveCandidate(t,{...options,approval:altered}).livePass,false);
 const other={...options.trustedKeys,supplemental:{...extraTrust,physical:trust.runtime}};
 assert.equal(assessLiveCandidate(t,{...options,trustedKeys:other}).contractPass,false);
 const seals=structuredClone(options.journalSeals);seals.do.seal.count--;
 assert.equal(assessLiveCandidate(t,{...options,journalSeals:seals}).contractPass,false);
 const changed=structuredClone(t);changed.metadata.artifactLayout='legacy-t10';buildJournal(changed);reseal(changed);
 assert.equal(assessLiveCandidate(changed,options).contractPass,false);
 await assert.rejects(collectRoundReadbacks({approval:options.approval,limits,trustedKeys:options.trustedKeys}),/NOT_AUTHORIZED/);
});
test('M07 bounded native journal page collection authenticates original records and terminal seals',async()=>{
 const {t,options}=await integratedFixture(10);
 const port=async({origin,planDigest,after,limit})=>{
  const rows=t.observedJournal.records.filter(x=>x.claim.origin===origin),records=rows.slice(after,after+limit),complete=after+records.length===rows.length;
  return {origin,planDigest,after,records,complete,...(complete?{seal:options.journalSeals[origin]}:{})};
 };
 const x=await collectObserverPages({approval:options.approval,limits,trustedKeys:options.trustedKeys,readPage:port});
 const result=assessLiveCandidate({...t,observedJournal:x.observedJournal},{...options,journalSeals:x.journalSeals});
 assert.equal(result.contractPass,true,JSON.stringify(result));assert.equal(result.livePass,false);
 await assert.rejects(collectObserverPages({approval:options.approval,limits,trustedKeys:options.trustedKeys,readPage:async req=>({...await port(req),after:req.after+1})}),/PAGE_SCOPE/);
});

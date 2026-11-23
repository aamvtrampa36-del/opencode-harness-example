import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrace, evaluateCampaign, LIVE_LIMITS, measureOverlap } from './evaluate.mjs';
import { runMock } from './mock.mjs';

for (const size of [1, 2, 4, 10]) {
  test('GREEN offline: ' + size + ' independent executor(s) and outputs', async () => {
    const result = evaluateTrace(await runMock({ size }));
    assert.equal(result.pass, true, JSON.stringify(result.failures));
    assert.equal(result.metrics.maxActive, size);
    assert.equal(result.metrics.orphans, 0);
    assert.ok(result.metrics.longestFullMs >= 50);
  });
}
for (const [fault, reason] of [
  ['oom', 'OOM'], ['partial', 'MISSING_OR_DUPLICATE_PERSISTED'],
  ['orphan', 'ORPHAN_OPERATION'], ['false-pass', 'FALSE_PASS_OUTPUT'],
  ['queued-only', 'INSUFFICIENT_REAL_OVERLAP'], ['cross-project', 'OUTPUT_ISOLATION'],
  ['duplicate-request', 'DUPLICATE_OR_MISSING_REQUEST_ID'],
  ['client-only', 'UNTRUSTED_ACTIVITY'], ['cancelled', 'UNEXPECTED_FAILURES'],
]) {
  test('RED offline: injected ' + fault + ' is rejected as ' + reason, async () => {
    const result = evaluateTrace(await runMock({ size: 10, fault }));
    assert.equal(result.pass, false);
    assert.ok(result.failures.some((f) => f.code === reason), JSON.stringify(result.failures));
  });
}
test('429 recovered once with SAME requestId passes offline', async () => {
  const result = evaluateTrace(await runMock({ size: 10, fault: 'retry' }));
  assert.equal(result.pass, true, JSON.stringify(result.failures));
});
test('HTTP-started / busy-only observations cannot impersonate a tool', async () => {
  const trace = await runMock({ size: 10 });
  for (const e of trace.events) {
    if (e.type === 'tool_start' || e.type === 'tool_end') e.type = 'busy';
  }
  const result = evaluateTrace(trace);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.code === 'NO_EXECUTION_EVIDENCE'));
});
test('flag verified=true cannot override absent artifact', async () => {
  const trace = await runMock({ size: 10 });
  trace.events.find((e) => e.type === 'output').artifact = null;
  const result = evaluateTrace(trace);
  assert.ok(result.failures.some((f) => f.code === 'OUTPUT_ISOLATION'));
});
test('producer output cannot pass without separate artifact retrieval', async () => {
  const trace = await runMock({ size: 10, fault: 'missing-readback' });
  const report = evaluateTrace(trace);
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((f) => f.code === 'ARTIFACT_READBACK_MISSING'));
});
test('valid producer output with corrupted readback must fail', async () => {
  const trace = await runMock({ size: 10, fault: 'corrupt-readback' });
  const report = evaluateTrace(trace);
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((f) => f.code === 'ARTIFACT_READBACK_MISMATCH'));
});
test('invalid TDD tool evidence is rejected', async () => {
  const trace = await runMock({ size: 10 });
  trace.events.find((e) => e.type === 'test_result' && e.phase === 'red').exitCode = 0;
  assert.ok(evaluateTrace(trace).failures.some((f) => f.code === 'TDD_RECEIPT_MISSING'));
});
test('false positive: forged live provenance on mock events cannot pass', async () => {
  const trace = await runMock({ size: 10 });
  trace.mode = 'live';
  trace.metadata = { workerVersion: 'fake', mcpVersion: 'fake', sourceSha: 'fake', gitBaseSha: 'fake',
    environment: 'staging', leaseId: 'fake', clockSyncMaxSkewMs: 0,
    sourceClock: 'server', evidenceOrigin: 'independent_runtime', spendStopVerified: true,
    measuredTotalUsd: 0 };
  const result = evaluateTrace(trace, { mode: 'live', limits: { ...LIVE_LIMITS, maxCostUsd: 1 } });
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.code === 'UNTRUSTED_LIVE_EVENT'));
  assert.ok(result.failures.some((f) => f.code === 'INSUFFICIENT_REAL_OVERLAP'));
});
test('cannot accept live campaign without 3 independent, attributable rounds', async () => {
  assert.equal(evaluateCampaign([]).code, 'TOO_FEW_ROUNDS');
  const same = await runMock({ size: 10 });
  const result = evaluateCampaign([same, same, same]);
  assert.equal(result.pass, false);
  assert.equal(result.code, 'DUPLICATE_EXPERIMENT');
});
test('interval measurement: ten starts but only four running means maxActive=4', () => {
  const intervals = [0, 1, 2, 3].map((i) => ({ requestId: 'r' + i, start: 100, end: 400 }));
  assert.equal(measureOverlap(intervals, 10).maxActive, 4);
});
test('restart with same ids and durable reconciliation can recover in offline model', async () => {
  const trace = await runMock({ size: 10, fault: 'restart-recovered' });
  const report = evaluateTrace(trace);
  assert.equal(report.pass, true, JSON.stringify(report.failures));
  assert.ok(trace.events.some((e) => e.type === 'reconciled'));
});
test('a status sample taken AFTER tools stop is not a read under load', async () => {
  const trace = await runMock({ size: 10 });
  for (const e of trace.events) if (e.type === 'status_probe') e.atMs += 2000;
  const report = evaluateTrace(trace);
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((f) => f.code === 'NO_UNDER_LOAD_STATUS_READ'));
});
test('missing Cloudflare isolate sample rejects a live trace even with other claims', async () => {
  const trace = await runMock({ size: 10 });
  trace.mode = 'live';
  trace.metadata = { workerVersion: 'v1', mcpVersion: 'v1', sourceSha: 'sha', gitBaseSha: 'base',
    environment: 'staging', leaseId: 'lock', clockSyncMaxSkewMs: 0,
    sourceClock: 'server', evidenceOrigin: 'independent_runtime', spendStopVerified: true,
    measuredTotalUsd: 0, observabilityQueryId: 'query', exclusiveLeaseAtomicVerified: true };
  const report = evaluateTrace(trace, { mode: 'live', limits: { ...LIVE_LIMITS, maxCostUsd: 1 } });
  assert.ok(report.failures.some((f) => f.code === 'MISSING_MEMORY_TELEMETRY'));
});
test('historical #90 RED profile (abstract, not raw trace): 6 OOM, 2 not_found and 4 cancelled does NOT pass', async () => {
  const trace = await runMock({ size: 10, fault: 'historical-red' });
  const report = evaluateTrace(trace);
  assert.equal(report.pass, false);
  for (const code of ['OOM', 'ORPHAN_OPERATION', 'UNEXPECTED_FAILURES', 'MISSING_OR_DUPLICATE_COMPLETED']) {
    assert.ok(report.failures.some((f) => f.code === code), code);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT, simulate, FakeProvider, cost } from './inference-sim.mjs';

test('10 distinct tasks eventually finish with fake readback; peaks and simulated costs are bounded', () => {
  const r = simulate();
  assert.equal(r.taskCount, 10);
  assert.equal(r.counts.done, 10);
  assert.equal(new Set(r.tasks.map(t => t.id)).size, 10);
  assert.ok(r.stats.maxInFlight <= DEFAULT.concurrency);
  assert.ok(r.stats.maxEffectiveActive >= 8);
  assert.ok(r.stats.actualFakeChargesUSD <= DEFAULT.budgetUSD);
  assert.ok(Math.abs(r.stats.unspentReservationsUSD) < 1e-12);
  assert.equal(r.stats.reconciled, 2);
  assert.equal(r.stats.rejected, 2);
  assert.equal(r.generated.length, 30);
  assert.equal(r.stats.toolActionsSimulated, 20);
});

test('20 RPM rolling 60 seconds and 2 in-flight enforced across all 10 tasks', () => {
  const r = simulate();
  for (const call of r.calls) {
    assert.ok(r.calls.filter(x => x.at > call.at - 60_000 && x.at <= call.at).length <= 20);
  }
  assert.ok(r.calls.length > 20);
  assert.ok(r.durationMs > 60_000);
});

test('lost/timeout response without provider readback remains UNKNOWN and is never reissued', () => {
  const r = simulate({ reconcileAmbiguous: false });
  assert.equal(r.counts.unknown, 2);
  assert.equal(r.counts.done, 8);
  for (const key of ['task-05:turn-1', 'task-08:turn-2']) {
    assert.equal(r.calls.filter(c => c.key === key).length, 1);
    assert.equal(r.generated.filter(k => k === key).length, 1);
  }
  assert.ok(r.events.some(e => e.type === 'ambiguous_held_no_retry'));
});

test('429 and 3040 mean no fake generation and trigger bounded retries, not duplicate billing', () => {
  const r = simulate();
  for (const key of ['task-02:turn-2', 'task-07:turn-3']) {
    assert.deepEqual(r.calls.filter(c => c.key === key).map(c => c.attempt), [1, 2]);
    assert.equal(r.generated.filter(k => k === key).length, 1);
  }
  const notGenerated = r.calls.filter(c => ['429', '3040'].includes(c.kind));
  assert.equal(notGenerated.length, 2);
});

test('maxRetries=0 fails definite rejects without an unbounded retry loop', () => {
  const r = simulate({ maxRetries: 0 });
  assert.equal(r.counts.failed, 2);
  assert.equal(r.counts.done, 8);
  assert.equal(r.calls.filter(c => c.key === 'task-02:turn-2').length, 1);
});

test('small synthetic budget blocks admissions before any unreserved model call', () => {
  const r = simulate({ budgetUSD: 0.004 });
  assert.ok(r.stats.stoppedByBudget > 0);
  assert.ok(r.stats.actualFakeChargesUSD <= 0.004 + 1e-9);
  assert.ok(r.calls.length < 30);
});

test('all output deterministic and no real provider endpoint referenced', () => {
  const a = simulate(), b = simulate();
  assert.deepEqual(a, b);
  assert.equal(typeof FakeProvider.prototype.start, 'function');
  assert.equal(cost({ input: 500_000, output: 200_000 }), 0.39);
});

test('invalid configs fail closed', () => {
  assert.throws(() => simulate({ rpm: 0 }), /INVALID_CONFIG/);
  assert.throws(() => simulate({ concurrency: -1 }), /INVALID_CONFIG/);
  assert.throws(() => simulate({ budgetUSD: Number.NaN }), /INVALID_CONFIG/);
});

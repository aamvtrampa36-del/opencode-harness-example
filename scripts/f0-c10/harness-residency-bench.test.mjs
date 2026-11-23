import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, MODES, simulate } from './harness-residency-bench.mjs';

test('1,2,4,10: deterministic counts and strong-reference buffer caps', () => {
  for (const sessions of LEVELS) for (const mode of MODES) {
    const result = simulate({ sessions, mode, messagesPerSession: 23, bytesPerMessage: 128 });
    assert.equal(result.generated, sessions * 23);
    assert.equal(result.bufferedBeforeIdleClose, result.expectedBufferCap);
    assert.equal(result.settledStatuses.length, sessions);
    assert.ok(result.settledStatuses.every(status => status === 'finished'));
    assert.equal(result.ledgerIntegrity, true);
  }
});
test('all modes: one cancellation and remaining completions preserve ledger', () => {
  for (const mode of MODES) {
    const result = simulate({ sessions: 10, mode, messagesPerSession: 17,
      bytesPerMessage: 96, cancelIndex: 5 });
    assert.equal(result.settledStatuses.filter(s => s === 'cancelled').length, 1);
    assert.equal(result.settledStatuses.filter(s => s === 'finished').length, 9);
    assert.ok(result.ledgerIntegrity);
  }
});
test('reject invalid work and invalid buffer sizes', () => {
  for (const bad of [0, 3, 11]) assert.throws(() => simulate({ sessions: bad, mode: 'bounded-tail' }), /INVALID_FIXTURE/);
  assert.throws(() => simulate({ sessions: 2, mode: 'not-real' }), /INVALID_FIXTURE/);
  assert.throws(() => simulate({ sessions: 2, mode: 'full-history', messagesPerSession: 100000 }), /INVALID_FIXTURE/);
});

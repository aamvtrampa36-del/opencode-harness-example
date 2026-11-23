/** F0-C10/T03 — explicitly RED synthetic reproductions of source risk windows.
 * These are source-shaped simulations, NOT execution of the deployed Durable Object.
 * Run separately: node --test scripts/f0-c10-t03/known-red.red.mjs
 * A failing exit code is expected until the actual supervisor can reconcile effects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('RED: crash after session create but before durable binding must not create two sessions', async () => {
  const job = { status: 'preparing' };
  const effects = { sessionsCreated: 0 };
  async function sourceShapedAdvance({ crashAfterCreate = false } = {}) {
    if (!job.session) {
      const created = { id: `ses_fixture_${++effects.sessionsCreated}` };
      if (crashAfterCreate) throw new Error('SYNTHETIC_OOM_AFTER_CREATE');
      job.session = created.id; // analogous to writing task.session after SDK side effect
    }
  }
  await assert.rejects(sourceShapedAdvance({ crashAfterCreate: true }), /SYNTHETIC_OOM/);
  await sourceShapedAdvance();
  // Current unjournaled session create window violates this contract.
  assert.equal(effects.sessionsCreated, 1);
});

test('RED: expired per-request lock must never allow overlapping external starts', async () => {
  let activeExternalStarts = 0, peak = 0;
  const durableLock = { token: null, expiresAt: 0 };
  async function sourceShapedAcquire(token, now) {
    if (durableLock.token && durableLock.expiresAt > now) return false;
    durableLock.token = token;
    durableLock.expiresAt = now + 60_000;
    return true;
  }
  assert.equal(await sourceShapedAcquire('first', 0), true);
  activeExternalStarts++;
  peak = Math.max(peak, activeExternalStarts);
  // First RPC is still awaiting a slow external effect when the TTL elapses.
  assert.equal(await sourceShapedAcquire('second', 60_001), true);
  activeExternalStarts++;
  peak = Math.max(peak, activeExternalStarts);
  assert.equal(peak, 1); // expected single-flight, actual peak=2
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionLedger } from './admission.mjs';
const id = n => n.toString(16).padStart(16, '0');
const input = (n, fingerprint = 'a'.repeat(64)) => ({ requestId: id(n), fingerprint });

const begin = async (ledger, n) => {
  await Promise.all(Array.from({ length: n }, (_, i) => ledger.admit(input(i + 1))));
  const claimed = await ledger.claim(n);
  await Promise.all(claimed.map(x => ledger.confirmStarted(x.requestId, x.lease, `rc-start-${x.requestId}`)));
  return claimed;
};

test('10 concurrent independent admissions are durable model entries, FIFO, no duplicate IDs', async () => {
  const l = new AdmissionLedger();
  const receipts = await Promise.all(Array.from({ length: 10 }, (_, i) => l.admit(input(i + 1))));
  assert.equal(new Set(receipts.map(r => r.requestId)).size, 10);
  assert.equal(l.counts().queued, 10);
  assert.deepEqual((await l.claim(10)).map(x => x.sequence), [1,2,3,4,5,6,7,8,9,10]);
});

test('100 simultaneous retries of one requestId reserve exactly once', async () => {
  const l = new AdmissionLedger();
  const replies = await Promise.all(Array.from({ length: 100 }, () => l.admit(input(1))));
  assert.equal(l.counts().admitted, 1);
  assert.equal(replies.filter(x => x.reused).length, 99);
});

test('same requestId with different fingerprint is rejected before effects', async () => {
  const l = new AdmissionLedger(); await l.admit(input(1));
  await assert.rejects(l.admit(input(1, 'b'.repeat(64))), /IDEMPOTENCY_CONFLICT/);
  assert.equal(l.counts().admitted, 1);
});

test('bounded backpressure rejects only before reservation and allows same ID later', async () => {
  const l = new AdmissionLedger({ maxOutstanding: 10 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => l.admit(input(i + 1))));
  const blocked = await l.admit(input(11));
  assert.deepEqual({ accepted: blocked.accepted, reason: blocked.reason },
    { accepted: false, reason: 'BACKPRESSURE' });
  assert.equal(l.snapshot().some(x => x.requestId === id(11)), false);
  const active = await l.claim(10);
  for (const row of active) {
    await l.confirmStarted(row.requestId, row.lease, `rc-start-${row.requestId}`);
    await l.evidence(row.requestId, row.lease, 1);
    await l.finish(row.requestId, row.lease, { verified: true });
  }
  assert.equal((await l.admit(input(11))).accepted, true);
});

test('capacity 2 is a temporary test setting; capacity 10 permits all ten claims', async () => {
  const two = new AdmissionLedger({ runningCapacity: 2 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => two.admit(input(i + 1))));
  assert.equal((await two.claim(2)).length, 2);
  const ten = new AdmissionLedger({ runningCapacity: 10 });
  const claimed = await begin(ten, 10);
  assert.equal(claimed.length, 10);
  assert.equal(ten.counts().running, 10);
  assert.equal(ten.counts().withProgress, 0); // running receipts are NOT activity proof
});

test('lost HTTP response is idempotently recoverable without new claim', async () => {
  const l = new AdmissionLedger(); const [one] = await begin(l, 1);
  await l.loseResponseOrRestart(one.requestId);
  const again = await l.admit(input(1));
  assert.equal(again.state, 'unknown'); assert.equal(again.reused, true);
  assert.equal((await l.claim()).length, 0);
  const recovered = await l.reconcile(one.requestId, { operationId: `rc-start-${one.requestId}` });
  assert.equal(recovered.state, 'running');
});

test('OOM between claim and submit yields UNKNOWN, not blind duplicate execution', async () => {
  const l = new AdmissionLedger();
  await l.admit(input(1)); const [one] = await l.claim();
  await l.loseResponseOrRestart(one.requestId);
  assert.equal((await l.claim()).length, 0);
  await assert.rejects(l.reconcile(one.requestId, { operationId: `rc-start-${one.requestId}` }),
    /AUTHORITATIVE_RECEIPT_REQUIRED/);
});

test('native not_found is not authoritative success and unknown does not auto-expire', async () => {
  const l = new AdmissionLedger(); const [one] = await begin(l, 1);
  await l.loseResponseOrRestart(one.requestId);
  await assert.rejects(l.reconcile(one.requestId, { operationId: 'not_found' }),
    /AUTHORITATIVE_RECEIPT_REQUIRED/);
  assert.equal(l.counts().occupied, 1);
});

test('claim lease and operation ID are fenced against wrong owners', async () => {
  const l = new AdmissionLedger(); await l.admit(input(1)); const [one] = await l.claim();
  await assert.rejects(l.confirmStarted(one.requestId, 'other', `rc-start-${one.requestId}`), /START_PROOF_REQUIRED/);
  await assert.rejects(l.confirmStarted(one.requestId, one.lease, 'other-operation'), /START_PROOF_REQUIRED/);
  await l.confirmStarted(one.requestId, one.lease, `rc-start-${one.requestId}`);
  await assert.rejects(l.confirmStarted(one.requestId, one.lease, `rc-start-${one.requestId}`), /START_PROOF_REQUIRED/);
});

test('progress must be ordered and a verified finish requires activity', async () => {
  const l = new AdmissionLedger(); const [one] = await begin(l, 1);
  await assert.rejects(l.finish(one.requestId, one.lease, { verified: true }), /VERIFICATION_REQUIRED/);
  await l.evidence(one.requestId, one.lease, 9);
  await assert.rejects(l.evidence(one.requestId, one.lease, 9), /INVALID_PROGRESS_EVIDENCE/);
  await assert.rejects(l.finish(one.requestId, one.lease, { verified: false }), /VERIFICATION_REQUIRED/);
  await l.finish(one.requestId, one.lease, { verified: true });
  assert.equal(l.counts().finished, 1);
});

test('1→2→4→10 fully claimed and evidence-reported; no live-runtime claim', async () => {
  for (const size of [1,2,4,10]) {
    const l = new AdmissionLedger({ runningCapacity: 10 });
    const claims = await begin(l, size);
    assert.equal(l.counts().running, size);
    assert.equal(l.counts().withProgress, 0);
    await Promise.all(claims.map(x => l.evidence(x.requestId, x.lease, 1)));
    assert.equal(l.counts().withProgress, size);
    await Promise.all(claims.map(x => l.finish(x.requestId, x.lease, { verified: true })));
    assert.equal(l.counts().finished, size);
  }
});

test('bad IDs and capacity inputs fail closed', async () => {
  const l = new AdmissionLedger();
  await assert.rejects(l.admit({requestId:'bad',fingerprint:'a'.repeat(64)}), /INVALID_REQUEST/);
  await assert.rejects(l.claim(11), /INVALID_CLAIM_LIMIT/);
  assert.throws(() => new AdmissionLedger({runningCapacity:0}), /INVALID_CAPACITY/);
});

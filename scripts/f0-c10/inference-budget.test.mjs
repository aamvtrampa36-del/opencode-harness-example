import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceBudgetReference } from './inference-budget.mjs';

const model = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const pricePolicy = { ['cloudflare|' + model]: { inputMicroUsdPerMillion: 300_000, outputMicroUsdPerMillion: 1_200_000, revision: 'fixture-nov-2026' } };
const id = n => n.toString(16).padStart(16, '0');
const req = (n = 1, overrides = {}) => ({ requestId: id(n), operationId: 'rc-start-' + id(n), callId: 'step-1', attemptId: 'attempt-1', provider: 'cloudflare', model, inputTokenCap: 1000, outputTokenCap: 1000, ...overrides });
const gate = (params = {}) => new InferenceBudgetReference({ budgetMicroUsd: 50_000, taskBudgetMicroUsd: 10_000, prices: pricePolicy, verifyT03Claim: ({ proof }) => proof === 'lease-verified', ...params });
const claim = { proof: 'lease-verified' };
async function send(g, r) {
  await g.reserve(r, claim);
  return g.dispatch(r.requestId, r.callId, r.attemptId, claim);
}

 test('RED: identical requestId/call/attempt is idempotent across reserve, send and receipt', async () => {
  const g = gate(), r = req();
  const [a, b] = await Promise.all([g.reserve(r, claim), g.reserve(r, claim)]);
  assert.equal(Number(a.created) + Number(b.created), 1);
  assert.equal((await g.dispatch(r.requestId, r.callId, r.attemptId, claim)).proceed, true);
  assert.equal((await g.dispatch(r.requestId, r.callId, r.attemptId, claim)).proceed, false);
  const usage = { inputTokens: 800, outputTokens: 300 };
  const first = await g.settle(r.requestId, r.callId, r.attemptId, { receiptId: 'receipt-1', usage });
  const repeated = await g.settle(r.requestId, r.callId, r.attemptId, { receiptId: 'receipt-1', usage });
  assert.equal(first.chargeMicroUsd, repeated.chargeMicroUsd);
  assert.equal(g.summary().confirmedMicroUsd, 600);
  assert.equal(g.summary().reservedMicroUsd, 0);
});

 test('RED: immutable provider/model/prompt identity, no unauthorized fallback', async () => {
  const g = gate(), r = req();
  await g.reserve(r, claim);
  await assert.rejects(g.reserve(req(1, { model: 'openrouter/free' }), claim), /MODEL_NOT_AUTHORIZED/);
  await assert.rejects(g.reserve(req(1, { inputTokenCap: 3000 }), claim), /FINGERPRINT_CONFLICT/);
  await assert.rejects(g.reserve(req(2, { provider: 'openrouter', model: 'openrouter/free' }), claim), /MODEL_NOT_AUTHORIZED/);
});

 test('RED: 10 concurrent requests cannot over-reserve shared batch cap', async () => {
  const g = gate({ budgetMicroUsd: 6_000, taskBudgetMicroUsd: 6_000 });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => g.reserve(req(i + 1), claim)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 4);
  assert.equal(results.filter(r => r.status === 'rejected' && /BUDGET_EXHAUSTED/.test(r.reason.message)).length, 6);
  assert.ok(g.summary().reservedMicroUsd <= 6000);
  assert.equal(g.summary().confirmedMicroUsd, 0);
});

 test('RED: definite upstream 429 releases reservation, permits one separately named retry', async () => {
  const g = gate(), r = req();
  assert.equal((await send(g, r)).proceed, true);
  await g.rejectBeforeGeneration(r.requestId, r.callId, r.attemptId, { reason: '429', proof: 'provider-pre-generation' });
  assert.equal(g.summary().reservedMicroUsd, 0);
  const r2 = { ...r, attemptId: 'attempt-2' };
  const x = await g.reserve(r2, claim);
  assert.equal(x.created, true);
  assert.equal((await g.dispatch(r2.requestId, r2.callId, r2.attemptId, claim)).proceed, true);
  await g.settle(r2.requestId, r2.callId, r2.attemptId, { receiptId: 'r2', usage: { inputTokens: 50, outputTokens: 20 } });
  assert.equal(g.summary().attempts, 2);
  assert.equal(g.summary().completed, 1);
});

 test('RED: ambiguous timeout holds liability and blocks retry, including after persisted snapshot restore', async () => {
  const g = gate(), r = req();
  await send(g, r);
  await g.markUnknown(r.requestId, r.callId, r.attemptId, { reason: 'timeout_after_dispatch' });
  assert.equal(g.summary().unknownMicroUsd, 1500);
  await assert.rejects(g.reserve({ ...r, attemptId: 'attempt-2' }, claim), /AMBIGUOUS_UPSTREAM_EFFECT/);
  const restored = gate({ snapshot: g.snapshot() });
  assert.equal((await restored.dispatch(r.requestId, r.callId, r.attemptId, claim)).proceed, false);
  assert.equal(restored.summary().unknownMicroUsd, 1500);
  await restored.settle(r.requestId, r.callId, r.attemptId, { receiptId: 'late-receipt', usage: { inputTokens: 300, outputTokens: 100 } });
  assert.equal(restored.summary().unknownMicroUsd, 0);
  assert.equal(restored.summary().confirmedMicroUsd, 210);
});

 test('RED: cost guard denies model-usage above reserved envelope without freeing liability', async () => {
  const g = gate(), r = req();
  await send(g, r);
  await assert.rejects(g.settle(r.requestId, r.callId, r.attemptId, { receiptId: 'too-large', usage: { inputTokens: 2000, outputTokens: 1500 } }), /USAGE_EXCEEDS_CAP/);
  assert.equal(g.summary().reservedMicroUsd, 1500);
  assert.equal((await g.dispatch(r.requestId, r.callId, r.attemptId, claim)).proceed, false);
});

 test('RED: 402 is hard stop, not an automatic retry, even with no-generation receipt', async () => {
  const g = gate(), r = req();
  await send(g, r);
  await g.rejectBeforeGeneration(r.requestId, r.callId, r.attemptId, { reason: '402', proof: 'provider-pre-generation' });
  await assert.rejects(g.reserve({ ...r, attemptId: 'attempt-2' }, claim), /PAYMENT_BLOCKED/);
});

 test('RED: untrusted release, settlement without dispatch and lease invalidation are fail-closed', async () => {
  const g = gate(), r = req();
  await assert.rejects(g.reserve(r, { proof: 'not-verified' }), /T03_CLAIM_REQUIRED/);
  await g.reserve(r, claim);
  await assert.rejects(g.dispatch(r.requestId, r.callId, r.attemptId, { proof: 'expired' }), /T03_CLAIM_REQUIRED/);
  await assert.rejects(g.settle(r.requestId, r.callId, r.attemptId, { receiptId: 'fake', usage: { inputTokens: 10, outputTokens: 10 } }), /NOT_DISPATCHED/);
  await assert.rejects(g.rejectBeforeGeneration(r.requestId, r.callId, r.attemptId, { reason: '429', proof: 'client-text' }), /PROVIDER_PROOF_REQUIRED/);
});

 test('RED: conflicting duplicate receipt cannot silently overwrite billed token counts', async () => {
  const g = gate(), r = req();
  await send(g, r);
  await g.settle(r.requestId, r.callId, r.attemptId, { receiptId: 'r', usage: { inputTokens: 100, outputTokens: 100 } });
  await assert.rejects(g.settle(r.requestId, r.callId, r.attemptId, { receiptId: 'r', usage: { inputTokens: 200, outputTokens: 100 } }), /RECEIPT_CONFLICT/);
  await assert.rejects(g.reserve({ ...r, attemptId: 'attempt-2' }, claim), /ALREADY_COMPLETED/);
});

 test('RED: release only on proven pre-generation 3040 and bounded retry attempts', async () => {
  const g = gate({ maxAttempts: 2 }), r = req();
  await send(g, r);
  await g.rejectBeforeGeneration(r.requestId, r.callId, r.attemptId, { reason: '3040', proof: 'provider-pre-generation' });
  const r2 = { ...r, attemptId: 'attempt-2' };
  await send(g, r2);
  await g.rejectBeforeGeneration(r2.requestId, r2.callId, r2.attemptId, { reason: '3040', proof: 'provider-pre-generation' });
  await assert.rejects(g.reserve({ ...r, attemptId: 'attempt-3' }, claim), /RETRY_LIMIT/);
});

 test('RED: per-task budget denies extra calls, independent of batch reserve', async () => {
  const g = gate({ taskBudgetMicroUsd: 2000 }), r = req();
  await g.reserve(r, claim);
  await assert.rejects(g.reserve({ ...r, callId: 'step-2' }, claim), /BUDGET_EXHAUSTED/);
});

 test('RED: authorized model catalogue cannot silently switch provider/model mid-task', async () => {
  const r = req(), secondary = 'openrouter/example';
  const g = gate({ prices: { ...pricePolicy, ['openrouter|' + secondary]: { inputMicroUsdPerMillion: 100, outputMicroUsdPerMillion: 100, revision: 'sample' } } });
  await g.reserve(r, claim);
  await assert.rejects(g.reserve({ ...r, callId: 'step-2', provider: 'openrouter', model: secondary }, claim), /UNAUTHORIZED_FALLBACK/);
});

 test('RED: price revision is pinned for already sent request, not silently re-priced after restart', async () => {
  const g = gate(), r = req();
  await send(g, r);
  const prices = { ['cloudflare|' + model]: { inputMicroUsdPerMillion: 900_000, outputMicroUsdPerMillion: 1_800_000, revision: 'future' } };
  const restarted = gate({ prices, snapshot: g.snapshot() });
  const x = await restarted.settle(r.requestId, r.callId, r.attemptId, { receiptId: 'old-price', usage: { inputTokens: 100, outputTokens: 100 } });
  assert.equal(x.chargeMicroUsd, 150);
});

/**
 * INTENTIONAL RED source-shaped negative controls. NOT part of standard CI.
 * This models two unsafe patterns, NOT the deployed SDK/provider.
 * Run: node --test scripts/f0-c10/inference-known-red.red.mjs (exit 1 expected).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('KNOWN RED: retrying after lost upstream response causes two charged generations', () => {
  let billed = 0;
  function naiveSend() { billed++; return { generated: true, billable: true }; }
  naiveSend(); // Upstream generated; client lost its response.
  naiveSend(); // Blind retry with same logical call.
  assert.equal(billed, 1, 'One logical inference must never silently bill twice');
});

test('KNOWN RED: ten concurrent admissions that check only confirmed spend overbook budget', async () => {
  const budget = 4, confirmed = 0;
  const admits = await Promise.all(Array.from({ length: 10 }, async () => confirmed < budget));
  assert.ok(admits.filter(Boolean).length <= budget,
    'Reservations must be serialized and counted before provider dispatch');
});

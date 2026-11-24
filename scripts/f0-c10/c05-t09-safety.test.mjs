import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateUsd2ApprovalReceipt } from "./preflight-03-usd2.mjs";

// Offline receipt invariants, NOT runtime authorization or SDK interception tests.
const paths = ["PREFLIGHT_03_USD2_AUTHORIZATION.json", "PREFLIGHT_03_USD2_AUTHORIZATION_REVALIDATED.json"];
function receipt(path) {
  return JSON.parse(readFileSync(new URL(`../../docs/f0-c10/${path}`, import.meta.url), "utf8"));
}
function assertStop(result) {
  assert.equal(result.totalCapMicroUsd, 2_000_000);
  assert.equal(result.decision, "STOP");
  assert.equal(result.liveDispatchAuthorized, false);
  assert.equal(result.providerHardCutoffVerified, false);
  assert.equal(result.allCostsMeasured, false);
  assert.notEqual(result.providerDispatchAuthorized, true);
}
for (const path of paths) {
  test(`${path}: read_only and claimed offline PASS cannot authorize provider dispatch`, () => {
    const r = receipt(path);
    assertStop(evaluateUsd2ApprovalReceipt(r));
    Object.assign(r, { mode: "read_only", providerDispatchAuthorized: true, offlinePass: true, completePass: true });
    assertStop(evaluateUsd2ApprovalReceipt(r));
  });
  test(`${path}: explicit GO and every claimed implementation/guarantee flag fail closed`, () => {
    const r = receipt(path);
    for (const key of Object.keys(r.implementation).filter(k => r.implementation[k] === false)) {
      const forged = structuredClone(r);
      forged.implementation[key] = true;
      assert.throws(() => evaluateUsd2ApprovalReceipt(forged), /USD2_UNTRUSTED_JSON_CANNOT_PROVE_GO/);
    }
    for (const key of Object.keys(r.guarantees)) {
      const forged = structuredClone(r);
      forged.guarantees[key] = true;
      assert.throws(() => evaluateUsd2ApprovalReceipt(forged), /USD2_UNTRUSTED_JSON_CANNOT_PROVE_GO/);
    }
    assert.throws(() => evaluateUsd2ApprovalReceipt({ ...r, gate: "GO" }), /USD2_FORGED_GO/);
  });
  test(`${path}: unknown costs cannot become zero or disappear`, () => {
    const r = receipt(path);
    for (const key of Object.keys(r.costInventory)) {
      const zeroed = structuredClone(r);
      zeroed.costInventory[key] = 0;
      assert.throws(() => evaluateUsd2ApprovalReceipt(zeroed), /USD2_COST_DATA_NOT_YET_VERIFIABLE/);
      const missing = structuredClone(r);
      delete missing.costInventory[key];
      assert.throws(() => evaluateUsd2ApprovalReceipt(missing), /USD2_COST_DATA_NOT_YET_VERIFIABLE/);
    }
  });
  test(`${path}: global cap cannot be increased or converted to per-task/per-provider`, () => {
    const r = receipt(path);
    for (const patch of [{ microUsd: 2_000_001 }, { amount: "2.01" }, { notPerTask: false }, { notPerProvider: false }]) {
      assert.throws(() => evaluateUsd2ApprovalReceipt({ ...r, ownerDecision: { ...r.ownerDecision, ...patch } }), /USD2_APPROVAL_CHANGED_OR_INVALID/);
    }
  });
}

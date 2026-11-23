/** Deliberately failing historical budget assumptions, NEVER a live payment. */
import {test} from "node:test";
import assert from "node:assert/strict";
test("KNOWN RED: giving US$2 independently to AI and Container spends US$4 globally",()=>{
  const userTotalMicroUsd=2_000_000;
  const naive=2_000_000+2_000_000;
  assert.ok(naive<=userTotalMicroUsd,
    "one global USD2 cap must not be duplicated per service");
});
test("KNOWN RED: treating an unpriced infrastructure charge as zero is unsafe",()=>{
  const unknownOverheadMicroUsd=null;
  const naiveKnownTotalMicroUsd=1_999_999;
  const unsafeDefault=unknownOverheadMicroUsd??0;
  assert.equal(naiveKnownTotalMicroUsd+unsafeDefault,2_000_000,
    "unknown charge must not be treated as free under a strict USD2 ceiling");
});

/* Known-RED historical design regressions. Intentionally fails. No real SDK/API. */
import test from "node:test";
import assert from "node:assert/strict";

test("KNOWN RED: simple lease TTL reclaims while old sender may still invoke provider",()=>{
  let attempts=0;
  const old={owner:"A",expiresAt:1000,nativeEffect:"in_flight"};
  const now=1200;
  const naiveNewOwner=now>=old.expiresAt?"B":null;
  if(naiveNewOwner) attempts++; // new sender may emit a second operation
  if(old.nativeEffect==="in_flight") attempts++; // old sender may still complete
  assert.equal(attempts,1,"expired lease must NOT transfer before native quiescence proof");
});
test("KNOWN RED: ten separate DO-local ledgers overspend one shared USD budget",()=>{
  const totalMax=5000;
  const isolatedOwners=Array.from({length:10},()=>({reserved:0}));
  let charged=0;
  for(const actor of isolatedOwners){
    if(actor.reserved+1500<=totalMax){actor.reserved+=1500;charged+=1500;}
  }
  assert.ok(charged<=totalMax,"global spending cannot be partitioned by per-agent DO local ledgers");
});

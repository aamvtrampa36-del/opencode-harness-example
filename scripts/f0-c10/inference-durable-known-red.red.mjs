/* Deliberately failing controls. Run separately. NOT included by bun test. */
import test from 'node:test';
import assert from 'node:assert/strict';

test('KNOWN RED: R2-local per-isolate reservations do not enforce one shared budget', () => {
  const fixedBudget=5_000;
  const isolates=Array.from({length:10},()=>({spent:0,reserved:0}));
  let combined=0;
  for (const local of isolates){
    if(local.spent+local.reserved+1_500<=fixedBudget) {local.reserved+=1_500;combined+=1_500;}
  }
  assert.ok(combined<=fixedBudget,'Budget must be global across isolates');
});
test('KNOWN RED: a GO label cannot substitute missing measured Container and CI hard stops', () => {
  const naive={selectedModel:'economy',gatewayEstimatedCost:0,leaseStatus:'running'};
  const go=Boolean(naive.selectedModel&&naive.leaseStatus&&naive.gatewayEstimatedCost===0);
  assert.equal(go,false,'Hard STOP requires all active services');
});
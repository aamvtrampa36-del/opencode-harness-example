import test from 'node:test';
import assert from 'node:assert/strict';
import {METERS,estimateCampaign} from './estimate.mjs';
import {estimateFixture} from './estimate-fixture.mjs';
test('reproducible 1/2/4/10 estimates include every meter and explicit residual',()=>{
  const now=Date.now(),p=estimateFixture(now),a=estimateCampaign(p,now);
  assert.deepEqual(a,estimateCampaign(structuredClone(p),now));assert.deepEqual(a.rounds.map(r=>r.tasks),[1,2,4,10]);
  assert.equal(a.decision,'OFFLINE_ESTIMATE_WITHIN_CAPS');assert.equal(a.liveDispatchAuthorized,false);assert.equal(a.accountHardStopVerified,false);
  assert.equal(a.rounds[3].roundCostMicroUsd,10*a.rounds[3].taskCostMicroUsd+a.rounds[3].sharedCostMicroUsd+p.rounds[3].residualMicroUsd);
  assert.equal(a.totalUpperMicroUsd,p.residualMicroUsd+a.rounds.reduce((s,r)=>s+r.roundCostMicroUsd,0));
  assert.deepEqual(Object.keys(a.rounds[0].taskCostByMeter),Object.keys(METERS));
});
test('task, round, and cumulative caps stop before live',()=>{
  const now=Date.now(),p=estimateFixture(now);
  p.rounds[0].taskCapMicroUsd=1;p.rounds[1].roundCapMicroUsd=1;
  p.totalCapMicroUsd=100000;p.residualMicroUsd=99999;
  const x=estimateCampaign(p,now);assert.equal(x.decision,'STOP');
  assert.ok(x.rounds[0].blockers.includes('TASK_CAP'));assert.ok(x.rounds[1].blockers.includes('ROUND_CAP'));assert.ok(x.rounds[0].blockers.includes('LOT_CAP'));
});
test('unknown/stale rate, missing quantity, missing rounding, free quota guess and unbounded calls stop',()=>{
  const now=Date.now();
  for(const mutate of [p=>delete p.tariffs.egressBytes,p=>p.tariffs.logBytes.validUntil=now,
    p=>delete p.rounds[0].perTask.cacheReadTokens,p=>delete p.rounds[0].sharedRoundingEvents.ciSeconds,
    p=>p.tariffs.workerRequests.microUsd=0,p=>p.rounds[0].perTask.providerCalls=1,
    p=>p.rounds[0].perTask.outputTokens=0,p=>p.rounds[0].maxConcurrent=2]){
    const p=estimateFixture(now);mutate(p);assert.throws(()=>estimateCampaign(p,now));
  }
});
test('block rounding conservatively covers separate charge events; disabled routes cannot be used',()=>{
  const now=Date.now(),p=estimateFixture(now);p.tariffs.ciSeconds={...p.tariffs.ciSeconds,microUsd:10,unitsPerCharge:60,rounding:'block'};
  p.rounds[0].perTaskRoundingEvents.ciSeconds=10;const x=estimateCampaign(p,now);
  assert.equal(x.rounds[0].taskCostByMeter.ciSeconds,100);
  p.tariffs.ciSeconds.microUsd=0;p.tariffs.ciSeconds.zeroBasis='verified-disabled-route';assert.throws(()=>estimateCampaign(p,now),/DISABLED_METER_USED/);
});

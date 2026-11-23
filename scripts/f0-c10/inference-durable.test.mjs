import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reserveInference, beginInferenceDispatch, markInferenceUnknown,
  settleInference, rejectInferenceBeforeGeneration, inferenceBudgetTotals, paidPreflight
} from '../../src/supervisor-inference-budget.ts';

// Offline fake: one atomic T03 Durable Object transaction, with rollback on failure.
class DOFake {
  constructor(rows = []) { this.rows = new Map(structuredClone(rows)); this.tail = Promise.resolve(); this.failNextPut = false; }
  async get(key) { return structuredClone(this.rows.get(key)); }
  async put(key, value) { if (this.failNextPut) { this.failNextPut = false; throw Error('SIMULATED_COMMIT_FAILURE'); } this.rows.set(key,structuredClone(value)); }
  async transaction(fn) {
    let release; const next = new Promise(resolve => { release = resolve; });
    const prev = this.tail; this.tail = next; await prev;
    const staged = new DOFake([...this.rows]);
    if (this.failNextPut) { staged.failNextPut = true; this.failNextPut = false; }
    try {const result = await fn(staged); this.rows = staged.rows; return result;}
    finally {release();}
  }
  snapshot() { return structuredClone([...this.rows]); }
  set(key,v) { this.rows.set(key,structuredClone(v)); }
}
const id = n => n.toString(16).padStart(16,'0');
const grant = n => ({id:id(n),token:'b9f18fee-91ab-4b32-97d2-061c73d834a0',generation:1});
const policy = changes => ({ experimentId:id(980),totalMicroUsd:5_000,taskMicroUsd:3_000,maxAttempts:2,
  selections:{economy:{providerID:'cloudflare',modelID:'@cf/deepseek-ai/deepseek-v4.1-flash-1017',price:{inputMicroUsdPerMillion:300_000,outputMicroUsdPerMillion:1_200_000,revision:'2026-11-23-test'}}}, ...changes });
const intent = (n, changed={}) => ({requestId:id(n),operationId:'rc-start-'+id(n),callId:'step_1',attemptId:'attempt_1',selection:'economy',inputTokenCeiling:1000,outputTokenCeiling:1000,...changed});
const proof = (override={}) => { const now=Date.now(); return ({now,exclusiveLeaseVerified:true,actualSdkInterceptorVerified:true,noUncontrolledRoutesVerified:true,disposabilityVerified:true,
  services:Object.fromEntries(['workers_ai','openrouter','workers','durable_objects','containers','github_actions'].map(s=>[s,s==='openrouter'?
  {active:false,disabledRouteVerified:true} : {active:true,routeBound:true,hardStopProven:true,exclusiveAccount:true,measuredAt:now-50,validUntil:now+500_000,remainingMicroUsd:100_000,worstInFlightMicroUsd:10_000}])), ...override}); };
const receipt = (n, changed={}) => ({origin:'trusted-provider-adapter',receiptId:'receipt_'+n,inputTokens:500,outputTokens:200,...changed});
const before = code => ({origin:'trusted-provider-adapter',beforeGeneration:true,code});
function setup(n=10) {
  const s=new DOFake(); const slots={};
  for(let i=1;i<=n;i++){
    const g=grant(i);
    slots[id(i)]={token:g.token,generation:g.generation,phase:'running',expiresAt:999_999};
    s.set('supervisor:task:'+id(i),{model:'economy',status:'running',sessionIdPolicy:'deterministic-v1',operationId:'rc-start-'+id(i)});
  }
  s.set('supervisor:admission:v1',{version:1,slots});
  return s;
}
async function reserveAndSend(s,n,p=policy(),pflight=proof(),changed={}){
  const v=intent(n,changed);await reserveInference(s,grant(n),v,p);
  return beginInferenceDispatch(s,grant(n),v,p,pflight);
}

test('RED⇒GREEN: 10 simultaneous independent requests cannot over-reserve one durable account budget',async()=>{
  const s=setup(),p=policy();
  const results=await Promise.allSettled(Array.from({length:10},(_,i)=>reserveInference(s,grant(i+1),intent(i+1),p)));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,3);
  assert.equal(results.filter(x=>x.status==='rejected'&&/INFERENCE_BUDGET_EXHAUSTED/.test(x.reason.message)).length,7);
  assert.deepEqual(await inferenceBudgetTotals(s),{confirmed:0,reserved:4500,unknown:0,exposureMicroUsd:4500,paymentBlocked:false});
});
test('100 simultaneous same IDs reserve once; one dispatch, no duplicate upstream permission',async()=>{
  const s=setup(1),p=policy();const r=await Promise.all(Array.from({length:100},()=>reserveInference(s,grant(1),intent(1),p)));
  assert.equal(r.filter(x=>x.kind==='reserved').length,1);
  const d=await Promise.all(Array.from({length:100},()=>beginInferenceDispatch(s,grant(1),intent(1),p,proof())));
  assert.equal(d.filter(x=>x.proceed).length,1);
  assert.equal((await inferenceBudgetTotals(s)).reserved,1500);
});
test('a forged/stale T03 grant, legacy session or changed operation is denied in the same transaction',async()=>{
  const s=setup(1),p=policy();
  await assert.rejects(reserveInference(s,{...grant(1),generation:2},intent(1),p),/T03_FENCE_OR_MODEL_INVALID/);
  await assert.rejects(reserveInference(s,{...grant(1),token:'other'},intent(1),p),/T03_FENCE_OR_MODEL_INVALID/);
  await assert.rejects(reserveInference(s,grant(1),intent(1,{operationId:'rc-start-'+id(2)}),p),/T03_FENCE_OR_MODEL_INVALID/);
  s.set('supervisor:task:'+id(1),{model:'economy',status:'running',operationId:'rc-start-'+id(1)});
  await assert.rejects(reserveInference(s,grant(1),intent(1),p),/T03_FENCE_OR_MODEL_INVALID/);
  assert.equal(await inferenceBudgetTotals(s),null);
});
test('STOP: unknown worker, container, DO, CI, provider, account or SDK cutoff forbids PAID dispatch',async()=>{
  const s=setup(1),p=policy(),v=intent(1);
  await reserveInference(s,grant(1),v,p);
  const checks=[
    proof({actualSdkInterceptorVerified:false}), proof({exclusiveLeaseVerified:false}),
    proof({noUncontrolledRoutesVerified:false}),proof({disposabilityVerified:false}),
    proof({services:{...proof().services,containers:{active:true}}}),
    proof({services:{...proof().services,workers:{active:true,hardStopProven:false}}}),
    proof({services:{...proof().services,github_actions:undefined}}),
    proof({services:{...proof().services,openrouter:{active:false,disabledRouteVerified:false}}})
  ];
  for(const bad of checks){assert.equal(paidPreflight(bad).decision,'STOP');
    await assert.rejects(beginInferenceDispatch(s,grant(1),v,p,bad),/PAID_PREFLIGHT_STOP/);}
  assert.deepEqual(await inferenceBudgetTotals(s),{confirmed:0,reserved:1500,unknown:0,exposureMicroUsd:1500,paymentBlocked:false});
  assert.equal((await beginInferenceDispatch(s,grant(1),v,p,proof())).proceed,true); // synthetic contract only
});
test('429 and 3040 require verified pre-generation receipt; finite retries without automatic scheduler',async()=>{
  const s=setup(1),p=policy(),v=intent(1);
  await reserveAndSend(s,1,p);
  await assert.rejects(rejectInferenceBeforeGeneration(s,v,{origin:'trusted-provider-adapter',beforeGeneration:false,code:'429'}),/PREGEN_PROOF_REQUIRED/);
  await rejectInferenceBeforeGeneration(s,v,before('429'));
  assert.equal((await inferenceBudgetTotals(s)).reserved,0);
  const v2=intent(1,{attemptId:'attempt_2'});
  assert.equal((await reserveInference(s,grant(1),v2,p)).kind,'reserved');
  assert.equal((await beginInferenceDispatch(s,grant(1),v2,p,proof())).proceed,true);
  await rejectInferenceBeforeGeneration(s,v2,before('3040'));
  await assert.rejects(reserveInference(s,grant(1),intent(1,{attemptId:'attempt_3'}),p),/INFERENCE_RETRY_DENIED/);
  assert.equal((await inferenceBudgetTotals(s)).exposureMicroUsd,0);
});
test('ambiguous post-effect timeout retains liability on durable restart, cannot retry even past TTL',async()=>{
  const old=setup(1),p=policy(),v=intent(1);
  await reserveAndSend(old,1,p);await markInferenceUnknown(old,v,'response_lost_after_generation');
  const restored=new DOFake(old.snapshot());
  await assert.rejects(reserveInference(restored,grant(1),intent(1,{attemptId:'attempt_2'}),p),/UPSTREAM_EFFECT_UNCERTAIN/);
  assert.equal((await beginInferenceDispatch(restored,grant(1),v,p,proof())).proceed,false);
  assert.equal((await inferenceBudgetTotals(restored)).unknown,1500);
  const settled=await settleInference(restored,v,receipt(1));
  assert.deepEqual(settled,{reused:false,chargedMicroUsd:390});
  assert.equal((await inferenceBudgetTotals(restored)).unknown,0);
});
test('duplicate rated settlement is idempotent, conflicting tokens and provider receipt reuse blocked',async()=>{
  const s=setup(2),p=policy();await reserveAndSend(s,1,p);await reserveAndSend(s,2,p);
  assert.equal((await settleInference(s,intent(1),receipt('x'))).chargedMicroUsd,390);
  assert.deepEqual(await settleInference(s,intent(1),receipt('x')),{reused:true,chargedMicroUsd:390});
  await assert.rejects(settleInference(s,intent(1),receipt('x',{outputTokens:201})),/DUPLICATE_SETTLEMENT_CONFLICT/);
  await assert.rejects(settleInference(s,intent(2),receipt('x')),/PROVIDER_RECEIPT_REUSED_OTHER_CALL/);
  assert.equal((await inferenceBudgetTotals(s)).confirmed,390);
});
test('402 pregen rejection freezes the global experiment for new paid calls',async()=>{
  const s=setup(2),p=policy();await reserveAndSend(s,1,p);
  await rejectInferenceBeforeGeneration(s,intent(1),before('402'));
  await assert.rejects(reserveInference(s,grant(2),intent(2),p),/PAYMENT_BLOCKED/);
  assert.equal((await inferenceBudgetTotals(s)).paymentBlocked,true);
});
test('unknown model price and changed model selection never silently fallback to OpenRouter',async()=>{
  const s=setup(1),p=policy({selections:{...policy().selections,reasoning:{providerID:'openrouter',modelID:'example/metered',price:{inputMicroUsdPerMillion:900000,outputMicroUsdPerMillion:1200000,revision:'fixture'}}}});
  await assert.rejects(reserveInference(s,grant(1),intent(1,{selection:'reasoning'}),p),/T03_FENCE_OR_MODEL_INVALID/);
  await assert.rejects(reserveInference(s,grant(1),intent(1,{selection:'unpriced'}),p),/MODEL_NOT_ALLOWED/);
  assert.equal(await inferenceBudgetTotals(s),null);
});
test('unbounded tokens, stale cost policy and over-cap upstream usage fail closed',async()=>{
  const s=setup(1),p=policy();
  await assert.rejects(reserveInference(s,grant(1),intent(1,{outputTokenCeiling:0}),p),/TOKEN_CEILING_MISSING/);
  await reserveAndSend(s,1,p);
  await assert.rejects(settleInference(s,intent(1),receipt('bad',{inputTokens:2000})),/UPSTREAM_USAGE_OVER_CEILING/);
  await assert.rejects(reserveInference(s,grant(1),intent(1,{callId:'step_2'}),policy({totalMicroUsd:10_000})),/BUDGET_POLICY_CHANGED_OR_CORRUPT/);
  assert.equal((await inferenceBudgetTotals(s)).reserved,1500);
});
test('separate per-task cap and no-cost estimation from unknown balance fails closed',async()=>{
  const s=setup(1),p=policy({totalMicroUsd:10000,taskMicroUsd:2000});
  await reserveInference(s,grant(1),intent(1),p);
  await assert.rejects(reserveInference(s,grant(1),intent(1,{callId:'step_2'}),p),/INFERENCE_BUDGET_EXHAUSTED/);
  const withoutProvider=proof({services:{...proof().services,workers_ai:{active:true,routeBound:true,hardStopProven:true,exclusiveAccount:true,measuredAt:Date.now()-50,validUntil:Date.now()+500_000}}});
  assert.equal(paidPreflight(withoutProvider).decision,'STOP');
});
test('DO rollback on failed staged put does not over-reserve; 2nd commit succeeds',async()=>{
  const s=setup(1),p=policy();s.failNextPut=true;
  await assert.rejects(reserveInference(s,grant(1),intent(1),p),/SIMULATED_COMMIT_FAILURE/);
  assert.equal(await inferenceBudgetTotals(s),null);
  const x=await reserveInference(s,grant(1),intent(1),p);assert.equal(x.kind,'reserved');
  assert.equal((await inferenceBudgetTotals(s)).reserved,1500);
});
test('inactive service route only skipped with attested disable; CI and Containers never counted as inference tokens',()=>{
  const p=proof();assert.equal(paidPreflight(p).decision,'GO');
  const bad=proof({services:{...p.services,containers:undefined,github_actions:undefined}});
  assert.deepEqual(paidPreflight(bad).blockers,['containers:UNKNOWN','github_actions:UNKNOWN']);
});
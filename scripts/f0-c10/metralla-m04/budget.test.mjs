import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveInference,beginInferenceDispatch,markInferenceUnknown,settleInference,rejectInferenceBeforeGeneration,cancelReservedNormalInference,normalInferenceStatus} from '../../../src/supervisor-inference-budget.ts';
class Storage {
  constructor(rows=[]){this.rows=new Map(structuredClone(rows));this.tail=Promise.resolve();}
  async get(k){return structuredClone(this.rows.get(k));}
  async put(k,v){this.rows.set(k,structuredClone(v));}
  async transaction(f){let release;const prev=this.tail;this.tail=new Promise(r=>release=r);await prev;
    try{const tx=new Storage([...this.rows]);const result=await f(tx);this.rows=tx.rows;return result;}finally{release();}}
}
const id=n=>n.toString(16).padStart(16,'0');
const grant=n=>({id:id(n),token:'token-'+n,generation:1});
const intent=(n,extra={})=>({requestId:id(n),operationId:'rc-start-'+id(n),callId:'call_1',attemptId:'a1',selection:'economy',inputTokenCeiling:1000,outputTokenCeiling:1000,wireBytes:200,...extra});
const setup=async(n,overrides={},roundOverrides={})=>{
  const s=new Storage(),slots={};for(let i=1;i<=n;i++){slots[id(i)]={...grant(i),phase:'running',expiresAt:Date.now()+600000};await s.put('supervisor:task:'+id(i),{model:'economy',status:'running',sessionIdPolicy:'deterministic-v1',operationId:'rc-start-'+id(i)});}
  await s.put('supervisor:admission:v1',{version:1,slots});
  const now=Date.now(),p={experimentId:id(999),totalMicroUsd:10000,taskMicroUsd:1000,maxAttempts:2,
    selections:{economy:{providerID:'cloudflare',modelID:'fixture/model',price:{inputMicroUsdPerMillion:100000,outputMicroUsdPerMillion:100000,revision:'synthetic'}}},
    normal:{validUntil:now+600000,maxCalls:30,maxCallsPerTask:3,maxInflight:n,
      rounds:{r1:{taskIds:Array.from({length:n},(_,i)=>id(i+1)),maxMicroUsd:10000,maxCalls:30,maxInflight:n,...roundOverrides}},
      routes:{economy:{providerID:'cloudflare',modelID:'fixture/model',tools:true,registered:true,evidenceId:'a'.repeat(64),validUntil:now+600000,maxInputTokens:1000,maxOutputTokens:1000,maxWireBytes:1000,requestsPerMinute:30}},...overrides}};
  return {s,p};
};
const proof=()=>{const now=Date.now();return {now,exclusiveLeaseVerified:true,actualSdkInterceptorVerified:true,noUncontrolledRoutesVerified:true,disposabilityVerified:true,
  services:Object.fromEntries(['workers_ai','openrouter','workers','durable_objects','containers','github_actions'].map(k=>[k,{active:true,routeBound:true,hardStopProven:true,exclusiveAccount:true,measuredAt:now-100,validUntil:now+60000,remainingMicroUsd:10000,worstInFlightMicroUsd:1000}]))};};
const reserve=(s,p,n,v=intent(n))=>reserveInference(s,grant(n),v,p);
const send=(s,p,n,v=intent(n))=>beginInferenceDispatch(s,grant(n),v,p,proof());
const receipt=n=>({origin:'trusted-provider-adapter',receiptId:'receipt_'+n,inputTokens:500,outputTokens:500});
for(const n of [1,2,4,10])test('atomic scale '+n,async()=>{const {s,p}=await setup(n);await Promise.all(Array.from({length:n},(_,i)=>reserve(s,p,i+1)));assert.equal((await normalInferenceStatus(s)).reserved,n*200);
  await Promise.all(Array.from({length:n},(_,i)=>send(s,p,i+1)));await Promise.all(Array.from({length:n},(_,i)=>settleInference(s,intent(i+1),receipt(i+1))));
  assert.equal((await normalInferenceStatus(s)).confirmed,n*100);assert.equal((await normalInferenceStatus(s)).canCloseAccounting,true);});
test('round cap under ten races, no duplicate reservation, no stale dispatch',async()=>{const {s,p}=await setup(10,{}, {maxMicroUsd:800});const res=await Promise.allSettled(Array.from({length:10},(_,i)=>reserve(s,p,i+1)));
  assert.equal(res.filter(x=>x.status==='fulfilled').length,4);assert.equal((await normalInferenceStatus(s)).active,4);
  const i=res.findIndex(x=>x.status==='fulfilled')+1;assert.equal((await reserve(s,p,i)).kind,'existing');
  await assert.rejects(send(s,p,i,intent(i,{wireBytes:201})),/RESERVATION_MISSING/);
  await assert.rejects(beginInferenceDispatch(s,{...grant(i),generation:2},intent(i),p,proof()),/FENCE/);
});
test('unknown stays after restart, no cancellation or retry; exact late settlement closes',async()=>{const {s,p}=await setup(1);await reserve(s,p,1);await send(s,p,1);await markInferenceUnknown(s,intent(1),'timeout');
  const restored=new Storage([...s.rows]);assert.equal((await normalInferenceStatus(restored)).unknown,200);
  await assert.rejects(cancelReservedNormalInference(restored,grant(1),intent(1),p),/UNKNOWN_EFFECT/);
  await assert.rejects(reserve(restored,p,1,intent(1,{attemptId:'a2'})),/UPSTREAM_EFFECT_UNCERTAIN/);
  assert.equal((await normalInferenceStatus(restored)).canCloseAccounting,false);
  await settleInference(restored,intent(1),receipt(1));assert.equal((await normalInferenceStatus(restored)).canCloseAccounting,true);
  assert.equal((await settleInference(restored,intent(1),receipt(1))).reused,true);
});
test('cancellation before dispatch only; quota and lifetime counts never replenished',async()=>{const {s,p}=await setup(1,{maxCallsPerTask:2});p.normal.routes.economy.requestsPerMinute=1;
  await reserve(s,p,1);await send(s,p,1);await rejectInferenceBeforeGeneration(s,intent(1),{origin:'trusted-provider-adapter',beforeGeneration:true,code:'429'});
  const v=intent(1,{attemptId:'a2'});await reserve(s,p,1,v);await assert.rejects(send(s,p,1,v),/NORMAL_QUOTA_STOP/);
  await cancelReservedNormalInference(s,grant(1),v,p);assert.equal((await normalInferenceStatus(s)).canCloseAccounting,true);
  await assert.rejects(reserve(s,p,1,intent(1,{callId:'call_2'})),/NORMAL_CALL_LIMIT/);
});
test('wire/token, task scope, unknown capability, backpressure and deadline fail closed',async()=>{const {s,p}=await setup(2,{maxInflight:1},{maxInflight:1});
  await assert.rejects(reserve(s,p,1,intent(1,{wireBytes:1001})),/WIRE_OR_TOKEN/);
  await assert.rejects(reserve(s,p,1,intent(1,{inputTokenCeiling:1001})),/WIRE_OR_TOKEN/);
  await reserve(s,p,1);await assert.rejects(reserve(s,p,2),/BACKPRESSURE/);
  const b=await setup(1);b.p.normal.routes.economy.registered=false;await assert.rejects(reserve(b.s,b.p,1),/ROUTE_UNVERIFIED/);
  const c=await setup(1);c.p.normal.validUntil=Date.now()-1;c.p.normal.routes.economy.validUntil=c.p.normal.validUntil;await assert.rejects(reserve(c.s,c.p,1),/DEADLINE_STOP/);
  const d=await setup(2);d.p.normal.rounds.r1.taskIds=[id(1)];await assert.rejects(reserve(d.s,d.p,2),/OUTSIDE_ROUND/);
});

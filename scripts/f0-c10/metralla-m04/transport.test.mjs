import test from 'node:test';
import assert from 'node:assert/strict';
import {pilotFetchNoRedirect,readBoundedJson,abortable} from '../../../src/pilot-http.ts';
import {normalHttpSender,dispatchNormalInference} from '../../../src/metralla-m04-adapter.ts';
import {resolveAuthorizedMeteredSelection} from '../../../src/model-presets.ts';
import {normalInferenceStatus,normalFallbackAllowed} from '../../../src/supervisor-inference-budget.ts';
// Local isolated fake transaction; no real HTTP or model binding.
class Store{constructor(rows=[]){this.rows=new Map(rows);this.tail=Promise.resolve();}async get(k){return structuredClone(this.rows.get(k));}async put(k,v){this.rows.set(k,structuredClone(v));}async transaction(f){let release;const old=this.tail;this.tail=new Promise(r=>release=r);await old;try{const tx=new Store(structuredClone([...this.rows]));const res=await f(tx);this.rows=tx.rows;return res;}finally{release();}}}
const id='0000000000000001',grant={id,token:'offline',generation:1};
const v={requestId:id,operationId:'rc-start-'+id,callId:'call_1',attemptId:'a1',selection:'economy',inputTokenCeiling:1000,outputTokenCeiling:1000};
const msg=[{role:'user',content:'offline'}];
const done=()=>Response.json({id:'receipt-id',model:'fixture/model',choices:[{finish_reason:'stop'}],usage:{prompt_tokens:500,completion_tokens:100,total_tokens:600}});
async function setup(send,override={}){const now=Date.now(),storage=new Store();
  await storage.put('supervisor:admission:v1',{version:1,slots:{[id]:{...grant,phase:'running'}}});
  await storage.put('supervisor:task:'+id,{model:'economy',status:'running',operationId:v.operationId,sessionIdPolicy:'deterministic-v1'});
  const route={providerID:'cloudflare',modelID:'fixture/model',registered:true,tools:true,evidenceId:'a'.repeat(64),validUntil:now+60000,maxInputTokens:1000,maxOutputTokens:1000,maxWireBytes:2000,maxResponseBytes:3000,timeoutMs:1000,requestsPerMinute:10};
  const price={inputMicroUsdPerMillion:100000,outputMicroUsdPerMillion:100000,revision:'synthetic'};
  const policy={experimentId:id,totalMicroUsd:1000,taskMicroUsd:1000,maxAttempts:2,selections:{economy:{providerID:route.providerID,modelID:route.modelID,price}},
    normal:{validUntil:now+60000,maxCalls:3,maxCallsPerTask:3,maxInflight:1,rounds:{r1:{taskIds:[id],maxMicroUsd:1000,maxCalls:3,maxInflight:1}},routes:{economy:route}}};
  const preflight={now,exclusiveLeaseVerified:true,actualSdkInterceptorVerified:true,noUncontrolledRoutesVerified:true,disposabilityVerified:true,
    services:Object.fromEntries(['workers_ai','openrouter','workers','durable_objects','containers','github_actions'].map(k=>[k,{active:true,routeBound:true,hardStopProven:true,exclusiveAccount:true,measuredAt:now-100,validUntil:now+60000,remainingMicroUsd:10000,worstInFlightMicroUsd:1000}]))};
  return {storage,grant,policy,preflight,boundInputTokens:()=>500,send,...override};
}
test('complete response settles exactly once, duplicate never sends',async()=>{let calls=0;const c=await setup(async()=>{calls++;return done();});
  const result=await dispatchNormalInference(c,v,msg);assert.equal(result.kind,'settled');assert.equal(result.chargedMicroUsd,60);
  assert.equal((await dispatchNormalInference(c,v,msg)).kind,'duplicate');assert.equal(calls,1);
});
for(const code of [429,403,402])test('generic '+code+' remains unknown and never falls back',async()=>{let calls=0;const c=await setup(async()=>{calls++;return Response.json({error:{code}},{status:code});});
  await assert.rejects(dispatchNormalInference(c,v,msg),/OUTCOME_UNKNOWN/);assert.equal((await normalInferenceStatus(c.storage)).unknown,200);assert.equal(calls,1);
});
test('verified pre-generation 429 permits only configured fallback proposal; no second dispatch',async()=>{let calls=0;const c=await setup(async()=>{calls++;return Response.json({error:{code:429}},{status:429});},{preGenerationRejection:()=> '429'});
  const route=c.policy.normal.routes.economy;c.policy.normal.routes.backup={...route,modelID:'fixture/backup'};
  c.policy.selections.backup={...c.policy.selections.economy,modelID:'fixture/backup'};
  c.policy.normal.fallbacks={economy:['backup']};
  const result=await dispatchNormalInference(c,v,msg);assert.equal(result.kind,'rejected');assert.equal((await normalInferenceStatus(c.storage)).reserved,0);
  assert.deepEqual(await normalFallbackAllowed(c.storage,grant,result.intent,c.policy,'backup'),{selection:'backup',requiresNewAuthorizedT03Selection:true});
  await assert.rejects(normalFallbackAllowed(c.storage,grant,result.intent,c.policy,'other'),/NOT_AUTHORIZED/);assert.equal(calls,1);
});
test('verified 403 freezes new reservations',async()=>{const c=await setup(async()=>Response.json({error:{code:403}},{status:403}),{preGenerationRejection:()=> '403'});
  assert.equal((await dispatchNormalInference(c,v,msg)).kind,'rejected');assert.equal((await normalInferenceStatus(c.storage)).paymentBlocked,true);
  await assert.rejects(dispatchNormalInference(c,{...v,callId:'call_2'},msg),/PAYMENT_BLOCKED/);
});
test('pre-send abort and token proof fail before any reservation/dispatch; post-send timeout stays unknown',async()=>{let calls=0;const c=await setup(async()=>{calls++;return done();});
  const ctrl=new AbortController();ctrl.abort();await assert.rejects(dispatchNormalInference(c,v,msg,[],ctrl.signal),/DEADLINE_BEFORE/);assert.equal(await normalInferenceStatus(c.storage),null);
  c.boundInputTokens=()=>1001;await assert.rejects(dispatchNormalInference(c,v,msg),/WIRE_OR_TOKEN/);assert.equal(calls,0);
  const d=await setup(async()=>{calls++;return new Promise(()=>{});});d.policy.normal.routes.economy.timeoutMs=20;
  // Keep Node event loop alive even if AbortSignal.timeout is unref'ed.
  const keep=setTimeout(()=>{},100);try{await assert.rejects(dispatchNormalInference(d,v,msg),/OUTCOME_UNKNOWN/);}finally{clearTimeout(keep);}
  assert.equal((await normalInferenceStatus(d.storage)).unknown,200);assert.equal(calls,1);
});
test('redirect refused at first hop, no bearer forwarding',async()=>{let calls=0;const fake=async(url,init)=>{calls++;assert.equal(url,'https://example.invalid/chat');assert.equal(init.redirect,'manual');assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture');return new Response(null,{status:307,headers:{location:'https://evil.invalid'}});};
  const c=await setup(normalHttpSender(fake,{endpoint:'https://example.invalid/chat',providerID:'cloudflare',modelID:'fixture/model',headers:{authorization:'Bearer fixture'}}));
  await assert.rejects(dispatchNormalInference(c,v,msg),/OUTCOME_UNKNOWN/);assert.equal(calls,1);
});
test('oversized body, invalid usage and wrong model cannot settle',async()=>{for(const send of [async()=>new Response('x'.repeat(4000)),async()=>Response.json({id:'r',model:'wrong',choices:[{finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),async()=>Response.json({id:'r',model:'fixture/model',choices:[{finish_reason:'stop'}],usage:{prompt_tokens:1001,completion_tokens:1,total_tokens:1002}})]){
  const c=await setup(send);await assert.rejects(dispatchNormalInference(c,v,msg),/OUTCOME_UNKNOWN/);assert.equal((await normalInferenceStatus(c.storage)).confirmed,0);assert.equal((await normalInferenceStatus(c.storage)).unknown,200);
}});
test('catalogue/preset is not registered or live capability',()=>{const e={providerID:'cloudflare',modelID:'@cf/deepseek-ai/deepseek-v4.1-flash-1017',registered:true,tools:true,validUntil:Date.now()+1000,evidenceId:'a'.repeat(64)};
  assert.equal(resolveAuthorizedMeteredSelection('economy',e).providerID,'cloudflare');
  for(const invalid of [{...e,registered:false},{...e,validUntil:0},{...e,modelID:'other'}])assert.throws(()=>resolveAuthorizedMeteredSelection('economy',invalid),/CAPABILITY_UNVERIFIED/);
  assert.throws(()=>resolveAuthorizedMeteredSelection('review',e),/CAPABILITY_UNVERIFIED/);
});

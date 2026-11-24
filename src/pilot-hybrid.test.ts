import { test,expect } from "bun:test";
import { makePilotHybridBinding } from "./pilot-hybrid";
import { PILOT_GLM, PILOT_PRICING_REVISION, PILOT_GLM_RESERVE_MICRO_USD, PILOT_MAX_PAID_CALLS, PILOT_INFERENCE_MICRO_USD, pilotBudgetPolicy, inferenceBudgetTotals, type PilotDispatchEvidence } from "./supervisor-inference-budget";
import type { PilotContext } from "./pilot-hybrid";
import { createAI } from "agents/models/opencode";
import { makePreparationReceipt,preparationInput } from "./pilot-preparation";
import type { PilotClaim } from "./pilot-authorization";
import type { SupervisorTask } from "./supervisor-control";

const id="abcdef0123456789",session="ses_r2_"+id,instance="12345678-1234-1234-1234-123456789abc";
async function fixture(){
 const rows=new Map<string,unknown>(),createdAt=Date.now(),policy=pilotBudgetPolicy(id,instance,createdAt);
 rows.set("supervisor:admission:v1",{version:1,slots:{[id]:{token:"token",generation:1,phase:"running"}}});
 const task:SupervisorTask={id,repository:"aamvtrampa36-del/opencode-harness-example",branch:"opencode/staging-"+id,
   fingerprint:"a".repeat(64),baseCommit:"c".repeat(40),model:"cloudflare",status:"running",sessionIdPolicy:"deterministic-v1",session,
   project:"supervised-"+id,pilotInstance:instance,createdAt,operationId:"rc-start-"+id};
 const claim:PilotClaim={instance,objectId:"b".repeat(64),startedAt:createdAt,approval:{
   schema:"pilot-release-v2",environment:"staging",requestId:id,releaseSha:"d".repeat(40),sourceCommit:task.baseCommit!,
   sourceTree:"e".repeat(40),containerImageDigest:"sha256:"+"f".repeat(64),reconciliationDigest:"e".repeat(64),fingerprint:task.fingerprint,
   notBefore:createdAt-100,expiresAt:createdAt+1800000,ciRun:"123",approvalRef:"test-only",
   residualRisk:"accepted-bounded-trial",plannedOtherMicroUsd:500000,evidence:{sdkOffline:"a".repeat(64),
   routeControls:"a".repeat(64),closeControls:"a".repeat(64),billingHeadroom:"a".repeat(64),
   freeZeroPrice:"a".repeat(64),glmBillingBound:"b".repeat(64)},pricingRevision:PILOT_PRICING_REVISION,maxWireBytes:49152,
   billingReview:{basis:"current-cycle-metered",cycleStart:createdAt-1000,observedThrough:createdAt,
     observedDurationGbSeconds:50000,sharedAndLagMarginGbSeconds:30000,pilotAllowanceGbSeconds:2000}}};
 const input=await preparationInput(claim,task,{id,token:"token",generation:1});
 task.pilotPreparation=await makePreparationReceipt({schema:"pilot-preparation-v1",input,containerObject:"c".repeat(64),
   containerOwner:instance,bootLabel:instance,bootId:instance,imageDigest:input.imageDigest,nodeVersion:"24.20.0",
   os:"debian-trixie",sourceDigest:"d".repeat(64),sourceFiles:100,preparedAt:createdAt});
 rows.set("supervisor:pilot:single-use-v1",claim);
 rows.set("supervisor:task:"+id,task);
 rows.set("supervisor:session:"+session,id);
 let tail=Promise.resolve();
 const storage={get:async(k:string)=>structuredClone(rows.get(k)),transaction:async(fn:(tx:any)=>Promise<any>)=>{
   const prev=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);await prev;
   const draft=new Map(rows);
   try{const result=await fn({get:async(k:string)=>structuredClone(draft.get(k)),put:async(k:string,v:unknown)=>{draft.set(k,structuredClone(v));}});
     rows.clear();for(const [k,v] of draft)rows.set(k,v);return result;
   }finally{release();}
 }} as unknown as DurableObjectStorage;
 const proof:PilotDispatchEvidence={kind:"pilot-risk-bounded-v2",experimentId:id,instance,validUntil:createdAt+800000,
   residualRiskExplicitlyAccepted:true,exclusiveLeaseVerified:true,actualSdkInterceptorVerified:true,noUncontrolledRoutesVerified:true,
   closeVerified:true,billingHeadroomReviewed:true,plannedOtherMicroUsd:500000,
   billingReview:{basis:"current-cycle-metered",cycleStart:createdAt-1000,observedThrough:createdAt,observedDurationGbSeconds:50000,sharedAndLagMarginGbSeconds:30000,pilotAllowanceGbSeconds:2000},
   preparationDigest:task.pilotPreparation.digest,maxWireBytes:48*1024,pricingRevision:PILOT_PRICING_REVISION,freeZeroPriceReceipt:"a".repeat(64),glmBillingBoundReceipt:"b".repeat(64)};
 const ctx:PilotContext={storage,grant:{id,token:"token",generation:1},policy,proof};
 let free=0,paid=0;let mode="ok";let key:string|undefined="offline-dummy";
 const response=(model:string,cost:number)=>Response.json({id:crypto.randomUUID(),object:"chat.completion",created:1,model,
   choices:[{index:0,message:{role:"assistant",content:"ok"},finish_reason:"stop"}],
   usage:{prompt_tokens:mode==="input-limit"?64001:20,completion_tokens:5,total_tokens:mode==="input-limit"?64006:25,cost}});
 const raw={run:async(m:string,b:any,o:any)=>{paid++;expect(m).toBe(PILOT_GLM);expect(b.max_completion_tokens).toBe(8000);
   expect(o.gateway).toBeUndefined();expect((await inferenceBudgetTotals(storage))?.reserved).toBe(PILOT_GLM_RESERVE_MICRO_USD);
   return response(mode==="bad-model"?"other-model":m,0);}} as unknown as Ai;
 const bind=makePilotHybridBinding(raw,async(s)=>{if(s!==session)throw Error("wrong session");return ctx;},async()=>key,
   (async(url:any,init:any)=>{free++;expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const b=JSON.parse(init.body);expect(b.model).toBe("openrouter/free");expect(b.provider.max_price.prompt).toBe(0);expect(b.max_tokens).toBe(8000);
    if(mode==="quota")return Response.json({error:{code:429,metadata:{limit_source:"openrouter_free_tier_per_minute"}}},{status:429});
    if(mode==="ambiguous")return Response.json({error:{code:429}},{status:429});
    return response("free/model:free",mode==="cost"?1:0);
   }) as typeof fetch);
 const call=(s=session,model=PILOT_GLM,input:any={messages:[{role:"user",content:"test"}]})=>
   (bind as any).run(model,input,{returnRawResponse:true,extraHeaders:{"x-opencode-session-id":s}});
 return {rows,storage,ctx,bind,call,counts:()=>[free,paid],mode:(m:string)=>mode=m,missingKey:()=>key=undefined};
}
test("combined budget counts all calls and blocks call 21",async()=>{
 const f=await fixture();for(let n=0;n<20;n++)expect((await f.call()).ok).toBe(true);
 await expect(f.call()).rejects.toThrow();expect(f.counts()).toEqual([20,0]);expect((await inferenceBudgetTotals(f.storage))?.pilot?.calls).toBe(20);
});
test("explicit router quota refusal switches once, same session, shared count",async()=>{
 const f=await fixture();f.mode("quota");await f.call();f.mode("ok");await f.call();
 expect(f.counts()).toEqual([1,2]);expect((await inferenceBudgetTotals(f.storage))?.pilot?.calls).toBe(3);
});
test("missing key is pre-send unavailability",async()=>{
 const f=await fixture();f.missingKey();await f.call();expect(f.counts()).toEqual([0,1]);
});
for(const mode of ["ambiguous","cost"])test("sticky unknown: "+mode,async()=>{
 const f=await fixture();f.mode(mode);await expect(f.call()).rejects.toThrow("PILOT_PROVIDER_OUTCOME_UNKNOWN");
 await expect(f.call()).rejects.toThrow();expect(f.counts()).toEqual([1,0]);
});
test("no proof, foreign session, other model and oversized input cannot dispatch",async()=>{
 const f=await fixture();await expect(f.call("foreign")).rejects.toThrow();
 await expect(f.call(session,"other")).rejects.toThrow();
 await expect(f.call(session,PILOT_GLM,{messages:[{role:"user",content:"x".repeat(60000)}]})).rejects.toThrow();
 f.ctx.proof.validUntil=Date.now()-1;await expect(f.call()).rejects.toThrow("PILOT_DISPATCH_STOP");expect(f.counts()).toEqual([0,0]);
});
test("concurrent reservations cannot overlap",async()=>{
 const f=await fixture();const r=await Promise.allSettled([f.call(),f.call()]);
 expect(r.filter(x=>x.status==="fulfilled").length).toBe(1);expect(f.counts()).toEqual([1,0]);
});
test("pinned Agents model language hook actually reaches the metered binding",async()=>{
 const f=await fixture(), ai=createAI({binding:f.bind});ai(PILOT_GLM);
 let hook:any;
 await ai.plugin.setup({provider:{transform:async()=>({dispose(){}})},aisdk:{hook:async(_name:string,fn:any)=>{hook=fn;return {dispose(){}};}}} as any);
 const event:any={model:{id:PILOT_GLM,modelID:PILOT_GLM}};hook(event);
 const result=await event.language.doStream({prompt:[{role:"user",content:[{type:"text",text:"test"}]}],headers:{"x-opencode-session-id":session},maxOutputTokens:8000});
 const reader=result.stream.getReader();let parts=0;for(;;){const x=await reader.read();if(x.done)break;parts++;}
 expect(parts).toBeGreaterThan(0);expect(f.counts()).toEqual([1,0]);
});

test("wire limit covers final serialized payload before dispatch",async()=>{
 const f=await fixture();f.ctx.proof.maxWireBytes=50;
 await expect(f.call()).rejects.toThrow("PILOT_INPUT_WIRE_LIMIT");
 expect(f.counts()).toEqual([0,0]);
});

test("GLM reserves full context exposure before each send; cheap receipts do not replenish paid slots",async()=>{
 const f=await fixture();f.missingKey();
 for(let n=0;n<PILOT_MAX_PAID_CALLS;n++)expect((await f.call()).ok).toBe(true);
 await expect(f.call()).rejects.toThrow("PILOT_PAID_CALL_LIMIT");
 expect(f.counts()).toEqual([0,13]);
 const totals=await inferenceBudgetTotals(f.storage);
 expect(totals?.pilot?.paidCalls).toBe(13);
 expect(totals?.pilot?.calls).toBe(13);
 expect(13*PILOT_GLM_RESERVE_MICRO_USD).toBeLessThanOrEqual(PILOT_INFERENCE_MICRO_USD);
});
test("combined counter still includes rejected Free call after economic revision",async()=>{
 const f=await fixture();
 for(let n=0;n<7;n++)await f.call();
 f.mode("quota");await f.call();f.mode("ok");
 for(let n=0;n<11;n++)await f.call();
 await expect(f.call()).rejects.toThrow();
 expect(f.counts()).toEqual([8,12]);expect((await inferenceBudgetTotals(f.storage))?.pilot?.calls).toBe(20);
});
for(const mode of ["input-limit","bad-model"])test("paid usage/model violation keeps full reserve and blocks all new sends: "+mode,async()=>{
 const f=await fixture();f.missingKey();f.mode(mode);
 await expect(f.call()).rejects.toThrow("PILOT_PROVIDER_OUTCOME_UNKNOWN");
 const totals=await inferenceBudgetTotals(f.storage);
 expect(totals?.unknown).toBe(PILOT_GLM_RESERVE_MICRO_USD);
 expect(totals?.paymentBlocked).toBe(true);
 await expect(f.call()).rejects.toThrow();expect(f.counts()).toEqual([0,1]);
});
test("Free usage over post-acceptance limit stops even though monetary reservation is zero",async()=>{
 const f=await fixture();f.mode("input-limit");await expect(f.call()).rejects.toThrow();
 expect((await inferenceBudgetTotals(f.storage))?.paymentBlocked).toBe(true);
 await expect(f.call()).rejects.toThrow();expect(f.counts()).toEqual([1,0]);
});

test("no durable preparation means zero provider sends even with an otherwise valid proof",async()=>{
 const f=await fixture();const task=f.rows.get("supervisor:task:"+id) as SupervisorTask;
 delete task.pilotPreparation;
 await expect(f.call()).rejects.toThrow("PILOT_PREPARATION_REQUIRED");expect(f.counts()).toEqual([0,0]);
});
test("altered durable receipt cannot reach either provider",async()=>{
 const f=await fixture();const task=f.rows.get("supervisor:task:"+id) as SupervisorTask;
 task.pilotPreparation!.bootId=crypto.randomUUID();f.missingKey();
 await expect(f.call()).rejects.toThrow("PILOT_PREPARATION_REQUIRED");expect(f.counts()).toEqual([0,0]);
});
test("cancelled task and changed admission generation cannot send",async()=>{
 const f=await fixture();const task=f.rows.get("supervisor:task:"+id) as SupervisorTask;
 task.status="cancel_requested";await expect(f.call()).rejects.toThrow();expect(f.counts()).toEqual([0,0]);
 const g=await fixture();const ledger=g.rows.get("supervisor:admission:v1") as any;ledger.slots[id].generation=2;
 await expect(g.call()).rejects.toThrow();expect(g.counts()).toEqual([0,0]);
});

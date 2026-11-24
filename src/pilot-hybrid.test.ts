import { test,expect } from "bun:test";
import { makePilotHybridBinding } from "./pilot-hybrid";
import { PILOT_GLM, pilotBudgetPolicy, inferenceBudgetTotals, type PilotDispatchEvidence } from "./supervisor-inference-budget";
import type { PilotContext } from "./pilot-hybrid";
import { createAI } from "agents/models/opencode";

const id="abcdef0123456789",session="ses_r2_"+id,instance="12345678-1234-1234-1234-123456789abc";
function fixture(){
 const rows=new Map<string,unknown>(),createdAt=Date.now(),policy=pilotBudgetPolicy(id,instance,createdAt);
 rows.set("supervisor:admission:v1",{version:1,slots:{[id]:{token:"token",generation:1,phase:"running"}}});
 rows.set("supervisor:task:"+id,{model:"cloudflare",status:"running",sessionIdPolicy:"deterministic-v1",session,project:"supervised-"+id,
   pilotInstance:instance,createdAt,operationId:"rc-start-"+id});
 rows.set("supervisor:session:"+session,id);
 let tail=Promise.resolve();
 const storage={get:async(k:string)=>structuredClone(rows.get(k)),transaction:async(fn:(tx:any)=>Promise<any>)=>{
   const prev=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);await prev;
   const draft=new Map(rows);
   try{const result=await fn({get:async(k:string)=>structuredClone(draft.get(k)),put:async(k:string,v:unknown)=>{draft.set(k,structuredClone(v));}});
     rows.clear();for(const [k,v] of draft)rows.set(k,v);return result;
   }finally{release();}
 }} as unknown as DurableObjectStorage;
 const proof:PilotDispatchEvidence={kind:"pilot-risk-bounded-v1",experimentId:id,instance,validUntil:createdAt+800000,
   residualRiskExplicitlyAccepted:true,exclusiveLeaseVerified:true,actualSdkInterceptorVerified:true,noUncontrolledRoutesVerified:true,
   closeVerified:true,billingHeadroomVerified:true,plannedOtherMicroUsd:500000,
   inputBounds:{free:{maxWireBytes:48*1024,maxInputTokens:64000,receipt:"a".repeat(64)},glm:{maxWireBytes:48*1024,maxInputTokens:64000,receipt:"b".repeat(64)}}};
 const ctx:PilotContext={storage,grant:{id,token:"token",generation:1},policy,proof};
 let free=0,paid=0;let mode="ok";let key:string|undefined="offline-dummy";
 const response=(model:string,cost:number)=>Response.json({id:crypto.randomUUID(),object:"chat.completion",created:1,model,
   choices:[{index:0,message:{role:"assistant",content:"ok"},finish_reason:"stop"}],
   usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25,cost}});
 const raw={run:async(m:string,b:any,o:any)=>{paid++;expect(m).toBe(PILOT_GLM);expect(b.max_completion_tokens).toBe(8000);
   expect(o.gateway).toBeUndefined();return response(m,0);}} as unknown as Ai;
 const bind=makePilotHybridBinding(raw,async(s)=>{if(s!==session)throw Error("wrong session");return ctx;},async()=>key,
   (async(url:any,init:any)=>{free++;expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const b=JSON.parse(init.body);expect(b.model).toBe("openrouter/free");expect(b.provider.max_price.prompt).toBe(0);expect(b.max_tokens).toBe(8000);
    if(mode==="quota")return Response.json({error:{code:429,metadata:{limit_source:"openrouter_free_tier_per_minute"}}},{status:429});
    if(mode==="ambiguous")return Response.json({error:{code:429}},{status:429});
    return response("free/model:free",mode==="cost"?1:0);
   }) as typeof fetch);
 const call=(s=session,model=PILOT_GLM,input:any={messages:[{role:"user",content:"test"}]})=>
   (bind as any).run(model,input,{returnRawResponse:true,extraHeaders:{"x-opencode-session-id":s}});
 return {storage,ctx,bind,call,counts:()=>[free,paid],mode:(m:string)=>mode=m,missingKey:()=>key=undefined};
}
test("combined budget counts all calls and blocks call 21",async()=>{
 const f=fixture();for(let n=0;n<20;n++)expect((await f.call()).ok).toBe(true);
 await expect(f.call()).rejects.toThrow();expect(f.counts()).toEqual([20,0]);expect((await inferenceBudgetTotals(f.storage))?.pilot?.calls).toBe(20);
});
test("explicit router quota refusal switches once, same session, shared count",async()=>{
 const f=fixture();f.mode("quota");await f.call();f.mode("ok");await f.call();
 expect(f.counts()).toEqual([1,2]);expect((await inferenceBudgetTotals(f.storage))?.pilot?.calls).toBe(3);
});
test("missing key is pre-send unavailability",async()=>{
 const f=fixture();f.missingKey();await f.call();expect(f.counts()).toEqual([0,1]);
});
for(const mode of ["ambiguous","cost"])test("sticky unknown: "+mode,async()=>{
 const f=fixture();f.mode(mode);await expect(f.call()).rejects.toThrow("PILOT_PROVIDER_OUTCOME_UNKNOWN");
 await expect(f.call()).rejects.toThrow();expect(f.counts()).toEqual([1,0]);
});
test("no proof, foreign session, other model and oversized input cannot dispatch",async()=>{
 const f=fixture();await expect(f.call("foreign")).rejects.toThrow();
 await expect(f.call(session,"other")).rejects.toThrow();
 await expect(f.call(session,PILOT_GLM,{messages:[{role:"user",content:"x".repeat(60000)}]})).rejects.toThrow();
 f.ctx.proof.validUntil=Date.now()-1;await expect(f.call()).rejects.toThrow("PILOT_DISPATCH_STOP");expect(f.counts()).toEqual([0,0]);
});
test("concurrent reservations cannot overlap",async()=>{
 const f=fixture();const r=await Promise.allSettled([f.call(),f.call()]);
 expect(r.filter(x=>x.status==="fulfilled").length).toBe(1);expect(f.counts()).toEqual([1,0]);
});
test("pinned Agents model language hook actually reaches the metered binding",async()=>{
 const f=fixture(), ai=createAI({binding:f.bind});ai(PILOT_GLM);
 let hook:any;
 await ai.plugin.setup({provider:{transform:async()=>({dispose(){}})},aisdk:{hook:async(_name:string,fn:any)=>{hook=fn;return {dispose(){}};}}} as any);
 const event:any={model:{id:PILOT_GLM,modelID:PILOT_GLM}};hook(event);
 const result=await event.language.doStream({prompt:[{role:"user",content:[{type:"text",text:"test"}]}],headers:{"x-opencode-session-id":session},maxOutputTokens:8000});
 const reader=result.stream.getReader();let parts=0;for(;;){const x=await reader.read();if(x.done)break;parts++;}
 expect(parts).toBeGreaterThan(0);expect(f.counts()).toEqual([1,0]);
});

test("input certificate must cover final serialized payload before dispatch",async()=>{
 const f=fixture();f.ctx.proof.inputBounds.free.maxWireBytes=50;
 await expect(f.call()).rejects.toThrow("PILOT_INPUT_BOUND_UNCERTIFIED");
 expect(f.counts()).toEqual([0,0]);
});

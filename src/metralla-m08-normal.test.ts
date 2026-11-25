import { test,expect } from "bun:test";
import { parseNormalApproval,approvedNormalTask,assertNormalTaskPin,assertNormalGitHubFence } from "./metralla-m08-normal-approval";
import { makeNormalMeteredBinding } from "./metralla-m08-normal-binding";
import { createAI } from "agents/models/opencode";
import { PILOT_GLM, type PaidPreflight, type BudgetPolicy, inferenceBudgetTotals } from "./supervisor-inference-budget";
import type { SupervisorTask } from "./supervisor-control";
import type { AdmissionSlot } from "./supervisor-admission";
const id="0123456789abcdef",session="ses_r2_"+id,repo="aamvtrampa36-del/opencode-harness-example",now=Date.now();
const grant={id,token:"12345678-1234-1234-1234-123456789abc",generation:1};
const pin={repo,base:"metralla/integracion-01",branch:"opencode/staging-"+id,commit:"a".repeat(40),tree:"b".repeat(40),paths:["src/client.tsx"]};
const task:SupervisorTask={id,repository:repo,branch:pin.branch,project:"supervised-"+id,fingerprint:"c".repeat(64),status:"running",session,sessionIdPolicy:"deterministic-v1",createdAt:now,operationId:"rc-start-"+id,model:"cloudflare",githubSource:pin,baseCommit:pin.commit,sourceTree:pin.tree};
const slot:AdmissionSlot={token:grant.token,generation:1,expiresAt:now+60000,phase:"running"};
const proof:PaidPreflight={now,exclusiveLeaseVerified:true,actualSdkInterceptorVerified:true,noUncontrolledRoutesVerified:true,disposabilityVerified:true,
 services:Object.fromEntries(["workers_ai","openrouter","workers","durable_objects","containers","github_actions"].map(k=>[k,{active:true,routeBound:true,hardStopProven:true,exclusiveAccount:true,measuredAt:now-100,validUntil:now+600000,remainingMicroUsd:100000,worstInFlightMicroUsd:1000}]))};
const policy:BudgetPolicy={experimentId:id,totalMicroUsd:100000,taskMicroUsd:100000,maxAttempts:1,selections:{cloudflare:{providerID:"cloudflare",modelID:PILOT_GLM,price:{inputMicroUsdPerMillion:100000,outputMicroUsdPerMillion:200000,revision:"fixture"}}},
 normal:{validUntil:now+600000,maxCalls:2,maxCallsPerTask:2,maxInflight:1,rounds:{one:{taskIds:[id],maxMicroUsd:100000,maxCalls:2,maxInflight:1}},routes:{cloudflare:{providerID:"cloudflare",modelID:PILOT_GLM,registered:true,tools:true,evidenceId:"d".repeat(64),validUntil:now+600000,maxInputTokens:1000,maxOutputTokens:100,maxWireBytes:10000,maxResponseBytes:10000,timeoutMs:1000,requestsPerMinute:10}}}};
const raw={schema:"metralla-normal-v1",releaseSha:"e".repeat(40),notBefore:now-100,expiresAt:now+600000,approvalRef:"fixture-only",policy,preflight:proof,tasks:[{requestId:id,fingerprint:task.fingerprint,selection:task.model,pin}],contextBoundEvidence:{cloudflare:"f".repeat(64)}};
const approval=()=>parseNormalApproval(JSON.stringify(raw),raw.releaseSha,now);
test("server-owned approval exact pin and task; reject foreign or missing proof",()=>{
 expect(approvedNormalTask(approval(),task).pin.commit).toBe(pin.commit);expect(assertNormalTaskPin(approval(),task).tree).toBe(pin.tree);
 expect(()=>parseNormalApproval(undefined,raw.releaseSha,now)).toThrow();
 expect(()=>parseNormalApproval(JSON.stringify(raw),"0".repeat(40),now)).toThrow();
 expect(()=>approvedNormalTask(approval(),{...task,fingerprint:"0".repeat(64)})).toThrow();
 expect(()=>assertNormalTaskPin(approval(),{...task,githubSource:{...pin,paths:["other"]}})).toThrow();
 expect(()=>parseNormalApproval(JSON.stringify({...raw,preflight:{...proof,noUncontrolledRoutesVerified:false}}),raw.releaseSha,now)).toThrow();
});
test("exact mutation fence and branch write-ahead fence",()=>{
 expect(()=>assertNormalGitHubFence(task,slot,grant,pin,"mutation",session)).not.toThrow();
 for(const x of [{...task,status:"cancelled" as const},{...task,cancelAmbiguous:true},{...task,session:"ses_foreign"},{...task,githubSource:undefined}])
 expect(()=>assertNormalGitHubFence(x,slot,grant,pin,"mutation",session)).toThrow();
 expect(()=>assertNormalGitHubFence(task,{...slot,generation:2},grant,pin,"mutation",session)).toThrow();
 const preparing={...task,status:"preparing" as const,session:undefined,operationId:undefined};
 expect(()=>assertNormalGitHubFence(preparing,{...slot,phase:"effect_unknown",effect:"github_branch"},grant,pin,"branch")).not.toThrow();
 expect(()=>assertNormalGitHubFence(preparing,slot,grant,pin,"branch")).toThrow();
});
test("native Agents SDK hook dispatches only through normal budget adapter",async()=>{
 const rows=new Map<string,unknown>([["supervisor:admission:v1",{version:1,slots:{[id]:slot}}],["supervisor:task:"+id,task]]);
 const storage={get:async(k:string)=>structuredClone(rows.get(k)),transaction:async(fn:any)=>{const draft=new Map(rows);const out=await fn({get:async(k:string)=>structuredClone(draft.get(k)),put:async(k:string,v:any)=>{draft.set(k,structuredClone(v));}});rows.clear();for(const [k,v] of draft)rows.set(k,v);return out;}} as unknown as DurableObjectStorage;
 let sends=0;
 const bind=makeNormalMeteredBinding({run:async(model:string,input:any)=>{sends++;expect(model).toBe(PILOT_GLM);expect(input.max_completion_tokens).toBe(100);expect((await inferenceBudgetTotals(storage))?.reserved).toBeGreaterThan(0);
 return Response.json({id:crypto.randomUUID(),object:"chat.completion",created:1,model,choices:[{index:0,message:{role:"assistant",content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});}} as unknown as Ai,
 async s=>{if(s!==session)throw Error("foreign");return {storage,grant,policy,preflight:proof,selection:"cloudflare",operationId:task.operationId!,contextBoundEvidence:"f".repeat(64)};},async()=>undefined);
 const ai=createAI({binding:bind});ai(PILOT_GLM);let hook:any;
 await ai.plugin.setup({provider:{transform:async()=>({dispose(){}})},aisdk:{hook:async(_name:string,fn:any)=>{hook=fn;return {dispose(){}};}}} as any);
 const event:any={model:{id:PILOT_GLM,modelID:PILOT_GLM}};hook(event);
 const result=await event.language.doStream({prompt:[{role:"user",content:[{type:"text",text:"test"}]}],headers:{"x-opencode-session-id":session},maxOutputTokens:100});
 const reader=result.stream.getReader();let parts=0;for(;;){const x=await reader.read();if(x.done)break;parts++;}
 expect(parts).toBeGreaterThan(0);expect(sends).toBe(1);expect((await inferenceBudgetTotals(storage))?.reserved).toBe(0);
 await expect((bind as any).run("foreign",{messages:[]},{returnRawResponse:true})).rejects.toThrow();
 await expect((bind as any).run(PILOT_GLM,{messages:[{role:"user",content:"x"}]},{returnRawResponse:true,extraHeaders:{"x-opencode-session-id":"ses_other"}})).rejects.toThrow();
 expect(sends).toBe(1);
});

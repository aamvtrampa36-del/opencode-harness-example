import {test,expect} from "bun:test";
import {inspectConsumedBudget,inspectNormalBudgetReady,pilotBudgetPolicy,PILOT_FREE} from "./supervisor-inference-budget";
import {reconciliationDigest} from "./supervisor-reconciliation";
const id="42574cb3f5ee0cbf", G="supervisor:inference:budget:v1", T="supervisor:inference:task:"+id, R="supervisor:inference:call:"+id+":";
const policy=pilotBudgetPolicy(id,"00000000-0000-4000-8000-000000000001",1);
const snapshot=JSON.stringify({...policy,selections:Object.fromEntries(Object.keys(policy.selections).sort().map(k=>[k,policy.selections[k]]))});
const base={version:1,policy:snapshot,hybrid:{calls:0,paidCalls:0,selection:PILOT_FREE},confirmed:0,reserved:0,unknown:0,paymentBlocked:false};
function readOnly(entries:[string,unknown][]){
 const m=new Map(entries),before=JSON.stringify([...m]);
 const tx={get:async(k:string)=>m.get(k),list:async({prefix,limit}:{prefix:string;limit:number})=>new Map([...m].filter(([k])=>k.startsWith(prefix)).slice(0,limit)),put:()=>{throw Error("WRITE_FORBIDDEN")},delete:()=>{throw Error("WRITE_FORBIDDEN")}};
 return {storage:{transaction:async(fn:(t:unknown)=>Promise<unknown>)=>fn(tx)} as unknown as DurableObjectStorage,unchanged:()=>expect(JSON.stringify([...m])).toBe(before)};
}
test("consumed readback verifies absent ledger AND absent call/task rows without writing",async()=>{
 const f=readOnly([]);const result=await inspectConsumedBudget(f.storage);
 expect(result).toEqual({schema:"metralla-consumed-budget-readback-v1",requestId:id,previousDigest:await reconciliationDigest(null),calls:0,confirmedMicroUsd:0,reservedMicroUsd:0,unknownMicroUsd:0,ledgerPresent:false,accountingSettled:true});f.unchanged();
});
test("consumed readback validates the canonical historical pilot policy",async()=>{
 const f=readOnly([[G,base]]);const result=await inspectConsumedBudget(f.storage);
 expect(result.previousDigest).toBe(await reconciliationDigest(base));expect(result.accountingSettled).toBe(true);f.unchanged();
});
for(const [name,entries,error] of [
 ["unknown",[[G,{...base,unknown:1}]],"BUDGET_TRANSITION_OLD_UNSETTLED"],
 ["reserved",[[G,{...base,reserved:1}]],"BUDGET_TRANSITION_OLD_UNSETTLED"],
 ["blocked payment",[[G,{...base,paymentBlocked:true}]],"BUDGET_TRANSITION_OLD_UNSETTLED"],
 ["pending",[[G,{...base,hybrid:{...base.hybrid,pending:"call"}}]],"BUDGET_TRANSITION_OLD_UNSETTLED"],
 ["orphan call",[[R+"c",{}]],"BUDGET_TRANSITION_ORPHAN_HISTORY"],
 ["orphan task",[[T,{confirmed:0,reserved:0,unknown:0}]],"BUDGET_TRANSITION_ORPHAN_HISTORY"],
] as [string,[string,unknown][],string][]){test("consumed readback rejects "+name,async()=>{const f=readOnly(entries);await expect(inspectConsumedBudget(f.storage)).rejects.toThrow(error);f.unchanged();});}
test("normal readiness cannot fabricate a missing ledger or bypass paid preflight",async()=>{
 const now=Date.now(),task="0123456789abcdef",end=now+60000;
 const p:import("./supervisor-inference-budget").BudgetPolicy={experimentId:task,totalMicroUsd:1000,taskMicroUsd:1000,maxAttempts:1,selections:{cloudflare:{providerID:"cloudflare",modelID:"fixture",price:{inputMicroUsdPerMillion:1,outputMicroUsdPerMillion:1,revision:"fixture"}}},normal:{validUntil:end,maxCalls:1,maxCallsPerTask:1,maxInflight:1,rounds:{one:{taskIds:[task],maxMicroUsd:1000,maxCalls:1,maxInflight:1}},routes:{cloudflare:{providerID:"cloudflare",modelID:"fixture",tools:true,registered:true,evidenceId:"a".repeat(64),validUntil:end,maxInputTokens:100,maxOutputTokens:100,maxWireBytes:1000,maxResponseBytes:1000,timeoutMs:1000,requestsPerMinute:1}}}};
 const proof:import("./supervisor-inference-budget").PaidPreflight={now,exclusiveLeaseVerified:true,actualSdkInterceptorVerified:true,noUncontrolledRoutesVerified:true,disposabilityVerified:true,services:Object.fromEntries(["workers_ai","openrouter","workers","durable_objects","containers","github_actions"].map(k=>[k,{active:true,routeBound:true,hardStopProven:true,exclusiveAccount:true,measuredAt:now,validUntil:end,remainingMicroUsd:1000,worstInFlightMicroUsd:10}]))};
 const f=readOnly([]);await expect(inspectNormalBudgetReady(f.storage,p,proof)).rejects.toThrow("NORMAL_LEDGER_NOT_READY");
 await expect(inspectNormalBudgetReady(f.storage,p,{...proof,exclusiveLeaseVerified:false})).rejects.toThrow("PAID_PREFLIGHT_STOP");f.unchanged();
});

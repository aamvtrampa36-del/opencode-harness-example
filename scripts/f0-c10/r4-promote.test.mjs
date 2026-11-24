import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {promotionPlan} from "./r4-promote.mjs";
const now=Date.now(),source="a".repeat(40),accountId="b".repeat(32),receipt="c".repeat(64);
const id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const pilot={schema:"pilot-release-v2",environment:"staging",requestId:"d".repeat(16),releaseSha:source,
 sourceCommit:"e".repeat(40),sourceTree:"f".repeat(40),containerImageDigest:"sha256:"+receipt,reconciliationDigest:receipt,
 fingerprint:receipt,notBefore:now-1000,expiresAt:now+1800000,ciRun:"42",approvalRef:"test-only",residualRisk:"accepted-bounded-trial",
 plannedOtherMicroUsd:500000,evidence:Object.fromEntries(["sdkOffline","routeControls","closeControls","billingHeadroom","freeZeroPrice","glmBillingBound"].map(k=>[k,receipt])),
 pricingRevision:"2026-11-24-context-neurons-v2",maxWireBytes:49152,
 billingReview:{basis:"current-cycle-metered",cycleStart:now-1000,observedThrough:now,observedDurationGbSeconds:50000,sharedAndLagMarginGbSeconds:30000,pilotAllowanceGbSeconds:2000}};
const targets=["opencode-g1-staging","opencode-staging-control-mcp"].map((worker,i)=>({worker,version:id(i+1),rollbackVersion:id(i+3),rollbackDeployment:id(i+5),uploadReceipt:receipt}));
const a={schema:"r4-explicit-promotion-v1",environment:"staging",operation:"promote-two-existing-workers",promoteAuthorized:true,accountId,
 source,ciHead:source,ciConclusion:"success",ciRun:"42",approvalRef:"test-only",notBefore:now-1000,expiresAt:now+1200000,
 exclusivityReceipt:receipt,economicsReceipt:receipt,reconciliationDigest:receipt,pilot,targets};
const maintenance={schema:"r4-reconciliation-v1",environment:"staging",releaseSha:source,requestId:pilot.requestId,approvalRef:"test-only",externalDrainReceipt:receipt,drainedAt:now-100,notBefore:now-100,expiresAt:now+1800000};
const o={accountId,observedAt:now,activeContainers:0,startingContainers:0,activeBuilds:0,
 historicalReconciliation:{schema:"r4-historical-quarantine-v1",digest:receipt,releaseSha:source,requestId:pilot.requestId,
 observedAt:now-100,scope:"fixed-supervisor-do-only",historyPreserved:true,providerDispatchAuthorized:false,completePass:false},
 admissionCapacity:{stopReason:null,activeSlots:0,inventoryComplete:true},targets:targets.map((t,i)=>{
 const bindings=[{name:"EXISTING",type:"durable_object_namespace",namespace_id:"old"}];
 return {worker:t.worker,triggerStopGuard:true,deployment:{id:t.rollbackDeployment,versions:[{version_id:t.rollbackVersion,percentage:100}]},
 oldVersion:{id:t.rollbackVersion,resources:{bindings:[...structuredClone(bindings),...(i===0?[
 {name:"OPENCODE_PILOT_HYBRID_REQUEST_ID",type:"plain_text",text:pilot.requestId},
 {name:"OPENCODE_R4_RECONCILIATION",type:"plain_text",text:JSON.stringify(maintenance)}]:[])],script_runtime:{compatibility_date:"2026-06-11"}}},
 newVersion:{id:t.version,annotations:{"workers/tag":"r4-"+source.slice(0,16),"workers/message":"R4 explicitly approved upload-only "+source},
 resources:{script_runtime:{compatibility_date:"2026-06-11"},bindings:[...bindings,...(i===0?[
 {name:"OPENCODE_PILOT_HYBRID_REQUEST_ID",type:"plain_text",text:pilot.requestId},
 {name:"OPENCODE_PILOT_AUTHORIZATION",type:"plain_text",text:JSON.stringify(pilot)}]:[])]}}};})};
const run=(m=a,r=o)=>{const b=Buffer.from(JSON.stringify(m));return promotionPlan(b,createHash("sha256").update(b).digest("hex"),r,now)};
test("verified exact two-target plan never applies or authorizes inference",()=>{
 const p=run();assert.equal(p.requests.length,2);assert.equal(p.applied,false);assert.equal(p.providerDispatchAuthorized,false);
 assert.equal(p.requests[0].body.versions[0].version_id,targets[0].version);
});
test("stale readbacks, rollback drift, active work and disabled STOP guard block promotion",()=>{
 for(const mutate of [x=>x.observedAt-=60001,x=>x.activeContainers=1,x=>x.activeBuilds=1,
  x=>x.targets[0].triggerStopGuard=false,x=>x.targets[0].deployment.versions[0].percentage=50]){
  const z=structuredClone(o);mutate(z);assert.throws(()=>run(a,z));
 }
});
test("wrong version tag, namespace drift and wrong pilot binding block promotion",()=>{
 for(const mutate of [x=>x.targets[0].newVersion.annotations["workers/tag"]="bad",
  x=>x.targets[0].newVersion.resources.bindings[0].namespace_id="new",
  x=>x.targets[0].newVersion.resources.bindings[1].text="bad"]){
  const z=structuredClone(o);mutate(z);assert.throws(()=>run(a,z));
 }
});

test("maintenance-only may promote frozen code with no pilot grant; mixing grants is forbidden",()=>{
 const m={...a,maintenance};delete m.pilot;delete m.reconciliationDigest;
 const z=structuredClone(o);
 z.targets[0].oldVersion.resources.bindings=z.targets[0].oldVersion.resources.bindings.filter(x=>x.name==="EXISTING");
 z.targets[0].newVersion.resources.bindings=z.targets[0].newVersion.resources.bindings.filter(x=>x.name!=="OPENCODE_PILOT_AUTHORIZATION");
 z.targets[0].newVersion.resources.bindings.push({name:"OPENCODE_R4_RECONCILIATION",type:"plain_text",text:JSON.stringify(maintenance)});
 assert.equal(run(m,z).mode,"maintenance-only");assert.throws(()=>run({...m,pilot},z));
 const bad=structuredClone(z);bad.targets[0].newVersion.resources.bindings.push({name:"OPENCODE_PILOT_AUTHORIZATION",type:"plain_text",text:JSON.stringify(pilot)});
 assert.throws(()=>run(m,bad));
 assert.throws(()=>run({...a,reconciliationDigest:"0".repeat(64)},o));
});

test("pilot promotion needs independent server readback, not a matching manifest field alone",()=>{
 for(const mutate of [x=>delete x.historicalReconciliation,x=>x.historicalReconciliation.digest="0".repeat(64),
  x=>x.admissionCapacity.activeSlots=1,x=>x.historicalReconciliation.observedAt=now-3600001]){
  const z=structuredClone(o);mutate(z);assert.throws(()=>run(a,z));
 }
});

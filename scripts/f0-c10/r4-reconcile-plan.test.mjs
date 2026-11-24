import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {reconcilePlan} from "./r4-reconcile-plan.mjs";
const now=Date.now(),source="a".repeat(40),accountId="b".repeat(32),receipt="c".repeat(64),lane="d".repeat(16);
const id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const freeze={schema:"r4-freeze-v1",environment:"staging",releaseSha:source,requestId:lane,approvalRef:"test-only",notBefore:now-10000,expiresAt:now+100000};
const targets=["opencode-g1-staging","opencode-staging-control-mcp"].map((worker,i)=>({worker,version:id(i+1),deployment:id(i+3)}));
const a={schema:"r4-account-reconcile-v1",environment:"staging",operation:"reconcile-only",reconcileAuthorized:true,source,accountId,
 ciHead:source,ciConclusion:"success",ciRun:"42",freeze,freezeObservedAt:now-5000,drainedAt:now-1000,externalDrainReceipt:receipt,targets};
const o={accountId,observedAt:now,activeContainers:0,startingContainers:0,activeBuilds:0,activeWorkflows:0,
 workflow:{name:"opencode-supervisor-stage",script_name:"opencode-g1-staging",class_name:"OpenCodeSupervisorWorkflow"},
 freezeStatus:{...freeze,providerDispatchAuthorized:false,reconciliationRoute:"account-workflow-only"},
 targets:targets.map((t,i)=>({worker:t.worker,triggerStopGuard:true,deployment:{id:t.deployment,versions:[{version_id:t.version,percentage:100}]},
 version:{id:t.version,annotations:{"workers/tag":"r4-"+source.slice(0,16)},resources:{bindings:i?[]:[
 {name:"OPENCODE_PILOT_HYBRID_REQUEST_ID",type:"plain_text",text:lane},
 {name:"OPENCODE_R4_RECONCILIATION",type:"plain_text",text:JSON.stringify(freeze)}]}}}))};
const run=(m=a,r=o)=>{const b=Buffer.from(JSON.stringify(m));return reconcilePlan(b,createHash("sha256").update(b).digest("hex"),r,now)};
test("exact private Workflow request uses JSON-encoded params and deterministic instance identity",()=>{
 const p=run();assert.equal(p.applied,false);assert.equal(p.providerDispatchAuthorized,false);
 assert.equal(p.request.path,"/accounts/"+accountId+"/workflows/opencode-supervisor-stage/instances");
 assert.equal(p.request.body.instance_id,"r4-reconcile-"+source.slice(0,16)+"-"+lane);
 assert.equal(JSON.parse(p.request.body.params).action,"r4_reconcile");
 assert.equal(p.readback.path,p.request.path+"/"+p.request.body.instance_id);
});
test("never plans reconciliation before actual freeze readback, after drift, or with active work",()=>{
 for(const patch of [{drainedAt:now-6000},{freezeObservedAt:now-10001},{reconcileAuthorized:false},{source:"0".repeat(40)}])assert.throws(()=>run({...a,...patch}));
 for(const mutate of [x=>delete x.freezeStatus,x=>x.activeWorkflows=1,x=>x.activeContainers=1,x=>x.activeBuilds=1,
  x=>x.targets[0].deployment.versions[0].percentage=50,x=>x.workflow.script_name="production",
  x=>x.targets[0].version.resources.bindings.push({name:"OPENCODE_PILOT_AUTHORIZATION",type:"plain_text",text:"unexpected"})]){
  const z=structuredClone(o);mutate(z);assert.throws(()=>run(a,z));
 }
});

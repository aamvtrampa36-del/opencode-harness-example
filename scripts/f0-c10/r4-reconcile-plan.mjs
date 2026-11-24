/** Offline construction of the exact account-authenticated Workflow request.
 * Nothing here invokes Cloudflare. Evidence pins must originate from actual
 * administrator readbacks, not from guessed timestamps or missing logs.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {parseFreezeManifest,reconciliationFromFrozenWorkflow} from "../../src/supervisor-reconciliation.ts";
const hash=b=>createHash("sha256").update(b).digest("hex");
const hex=(v,n)=>typeof v==="string"&&v.length===n&&/^[a-f0-9]+$/.test(v);
const uuid=v=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export function reconcilePlan(raw,pin,o,now=Date.now()){
 assert(hex(pin,64)&&hash(raw)===pin,"STOP_UNCERTIFIED_STAGING_RELEASE");
 const a=JSON.parse(raw),f=a.freeze;
 assert(a.schema==="r4-account-reconcile-v1"&&a.environment==="staging"&&a.operation==="reconcile-only"&&a.reconcileAuthorized===true);
 assert(hex(a.accountId,32)&&a.accountId===o.accountId&&hex(a.source,40)&&a.ciHead===a.source&&a.ciConclusion==="success");
 assert(/^\d{1,20}$/.test(a.ciRun)&&parseFreezeManifest(JSON.stringify(f),a.source,f?.requestId,now));
 assert(Number.isSafeInteger(o.observedAt)&&o.observedAt<=now&&now-o.observedAt<=60000);
 assert(o.workflow?.name==="opencode-supervisor-stage"&&o.workflow.script_name==="opencode-g1-staging"&&o.workflow.class_name==="OpenCodeSupervisorWorkflow");
 assert.equal(o.activeContainers,0);assert.equal(o.startingContainers,0);assert.equal(o.activeBuilds,0);assert.equal(o.activeWorkflows,0);
 assert(o.freezeStatus?.schema==="r4-freeze-v1"&&o.freezeStatus.releaseSha===a.source&&
  o.freezeStatus.requestId===f.requestId&&o.freezeStatus.approvalRef===f.approvalRef&&
  o.freezeStatus.providerDispatchAuthorized===false&&o.freezeStatus.reconciliationRoute==="account-workflow-only");
 assert(Array.isArray(a.targets)&&a.targets.length===2&&Array.isArray(o.targets)&&o.targets.length===2);
 for(const worker of ["opencode-g1-staging","opencode-staging-control-mcp"]){
  const t=a.targets.find(t=>t.worker===worker),r=o.targets.find(t=>t.worker===worker);
  assert(t&&r&&uuid(t.version)&&uuid(t.deployment)&&r.triggerStopGuard===true&&r.deployment.id===t.deployment);
  assert.deepEqual(r.deployment.versions,[{version_id:t.version,percentage:100}]);
  assert.equal(r.version.id,t.version);
  assert.equal(r.version.annotations?.["workers/tag"],"r4-"+a.source.slice(0,16));
  if(worker==="opencode-g1-staging"){
   const b=r.version.resources?.bindings;assert(Array.isArray(b));
   assert(!b.some(x=>x.name==="OPENCODE_PILOT_AUTHORIZATION"));
   const lane=b.filter(x=>x.name==="OPENCODE_PILOT_HYBRID_REQUEST_ID"),freeze=b.filter(x=>x.name==="OPENCODE_R4_RECONCILIATION");
   assert.equal(lane.length,1);assert.equal(freeze.length,1);
   assert.equal(lane[0].type,"plain_text");assert.equal(freeze[0].type,"plain_text");
   assert.equal(lane[0].text,f.requestId);assert.deepEqual(JSON.parse(freeze[0].text),f);
  }
 }
 const command={action:"r4_reconcile",releaseSha:a.source,requestId:f.requestId,approvalRef:f.approvalRef,
  freezeObservedAt:a.freezeObservedAt,drainedAt:a.drainedAt,externalDrainReceipt:a.externalDrainReceipt};
 reconciliationFromFrozenWorkflow(f,command,now);
 assert(command.drainedAt<=o.observedAt,"drain evidence must precede fresh readback");
 const instance_id="r4-reconcile-"+a.source.slice(0,16)+"-"+f.requestId;
 const path="/accounts/"+a.accountId+"/workflows/opencode-supervisor-stage/instances";
 return {schema:"r4-account-reconcile-plan-v1",decision:"READY_FOR_EXPLICIT_ADMIN_APPLY",applied:false,completePass:false,
  providerDispatchAuthorized:false,source:a.source,expiresAt:f.expiresAt,
  request:{method:"POST",path,body:{instance_id,params:JSON.stringify(command)}},
  readback:{method:"GET",path:path+"/"+instance_id}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const [manifest,pin,observations]=process.argv.slice(2);
  console.log(JSON.stringify(reconcilePlan(readFileSync(manifest),pin,JSON.parse(readFileSync(observations,"utf8")))));
 }catch(e){console.error("STOP_UNCERTIFIED_STAGING_RELEASE",e.message);process.exitCode=2;}
}

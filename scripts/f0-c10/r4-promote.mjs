/** Explicit external promotion plan. The plan is produced only from an
 * independently pinned administrator envelope AND readbacks of the actual
 * uploaded versions/current deployments. It is never an automatic deploy.
 * Apply the exact POSTs via Cloudflare Admin within the approved live lot,
 * rechecking the plan before each write; on ambiguous effects STOP.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {parsePilotApproval} from "../../src/pilot-authorization.ts";
import {parseFreezeManifest} from "../../src/supervisor-reconciliation.ts";
const hash=b=>createHash("sha256").update(b).digest("hex");
const hex=(v,n)=>typeof v==="string"&&v.length===n&&/^[a-f0-9]+$/.test(v);
const uuid=v=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const same=(x,y)=>assert.deepEqual(sort(x),sort(y));
const names=["opencode-g1-staging","opencode-staging-control-mcp"];
const expectedTag=sha=>"r4-"+sha.slice(0,16);
const message=sha=>"R4 explicitly approved upload-only "+sha;
const pilotNames=["OPENCODE_PILOT_HYBRID_REQUEST_ID","OPENCODE_PILOT_AUTHORIZATION","OPENCODE_R4_RECONCILIATION"];
function bindingMetadata(v,exclude=[]){
 const a=v.resources?.bindings;assert(Array.isArray(a));
 const out=a.filter(b=>!exclude.includes(b.name)).map(b=>{
  // Secret values must never be recorded; identifiers and all other resource metadata must match.
  if(b.type==="secret_text"||b.type==="secret_key")return {name:b.name,type:b.type};
  return b;
 }).sort((a,b)=>a.name.localeCompare(b.name));
 assert.equal(new Set(out.map(b=>b.name)).size,out.length);
 return out;
}
export function promotionPlan(raw,pin,o,now=Date.now()){
 assert(hex(pin,64)&&hash(raw)===pin,"STOP_UNCERTIFIED_STAGING_RELEASE: manifest hash");
 const a=JSON.parse(raw);
 assert.equal(a.schema,"r4-explicit-promotion-v1");assert.equal(a.environment,"staging");
 assert.equal(a.operation,"promote-two-existing-workers");assert.equal(a.promoteAuthorized,true);
 assert(hex(a.accountId,32)&&a.accountId===o.accountId&&hex(a.source,40)&&a.ciHead===a.source&&a.ciConclusion==="success"&&/^\d{1,20}$/.test(a.ciRun));
 assert(typeof a.approvalRef==="string"&&a.approvalRef.length>=8&&a.approvalRef.length<=160);
 assert(Number.isSafeInteger(a.notBefore)&&a.notBefore<=now&&Number.isSafeInteger(a.expiresAt)&&a.expiresAt>now&&a.expiresAt-now<=3600000);
 assert(Number.isSafeInteger(o.observedAt)&&o.observedAt<=now&&now-o.observedAt<=60000);
 assert(hex(a.economicsReceipt,64),"independent economic evidence required");
 assert.equal(o.activeContainers,0);assert.equal(o.startingContainers,0);assert.equal(o.activeBuilds,0);
 const maintenance=a.maintenance,p=a.pilot;
 if(maintenance!==undefined){
  assert(!("pilot" in a)&&parseFreezeManifest(JSON.stringify(maintenance),a.source,maintenance?.requestId,now)&&
    maintenance.approvalRef===a.approvalRef,"invalid maintenance authorization");
  assert(hex(a.preFreezeObservationReceipt,64)&&!("exclusivityReceipt" in a)&&!("reconciliationDigest" in a),"freeze is not a drain certificate");
 }else{
  assert(hex(a.exclusivityReceipt,64),"post-freeze exclusivity evidence required");
  assert(p?.approvalRef===a.approvalRef&&p.ciRun===a.ciRun&&parsePilotApproval(JSON.stringify(p),a.source,p.requestId,now),"invalid v2 manifest");
  assert.equal(a.reconciliationDigest,p.reconciliationDigest,"historical reconciliation receipt required");
  const c=o.historicalReconciliation,capacity=o.admissionCapacity;
  assert(c?.schema==="r4-historical-quarantine-v1"&&c.digest===p.reconciliationDigest&&
    c.releaseSha===a.source&&c.requestId===p.requestId&&c.scope==="fixed-supervisor-do-only"&&
    c.historyPreserved===true&&c.providerDispatchAuthorized===false&&c.completePass===false&&
    Number.isSafeInteger(c.observedAt)&&c.observedAt<=now&&now-c.observedAt<=3600000,
    "fresh server reconciliation readback required");
  assert(capacity?.stopReason===null&&capacity.activeSlots===0&&capacity.inventoryComplete===true,
    "historical admission capacity not cleared");
 }
 assert(Array.isArray(a.targets)&&a.targets.length===2&&Array.isArray(o.targets)&&o.targets.length===2);
 const requests=[];
 for(const name of names){
  const t=a.targets.find(t=>t.worker===name),r=o.targets.find(t=>t.worker===name);
  assert(t&&r&&uuid(t.version)&&uuid(t.rollbackVersion)&&uuid(t.rollbackDeployment)&&hex(t.uploadReceipt,64));
  const reuse=name===names[1]&&maintenance===undefined&&t.version===t.rollbackVersion;
  assert(reuse||t.version!==t.rollbackVersion,"only already-certified MCP may be reused in pilot promotion");
  assert.equal(r.triggerStopGuard,true);assert.equal(r.deployment.id,t.rollbackDeployment);
  same(r.deployment.versions,[{version_id:t.rollbackVersion,percentage:100}]);
  assert.equal(r.oldVersion.id,t.rollbackVersion);assert.equal(r.newVersion.id,t.version);
  assert.equal(r.newVersion.annotations?.["workers/tag"],expectedTag(a.source));
  assert.equal(r.newVersion.annotations?.["workers/message"],message(a.source));
  const excluded=name===names[0]?pilotNames:[];
  same(bindingMetadata(r.oldVersion,excluded),bindingMetadata(r.newVersion,excluded));
  same(r.oldVersion.resources.script_runtime,r.newVersion.resources.script_runtime);
  if(name===names[0]){
   const bindings=r.newVersion.resources.bindings;
   const lane=bindings.filter(b=>b.name===pilotNames[0]),manifest=bindings.filter(b=>b.name===pilotNames[1]),
    maintenanceBinding=bindings.filter(b=>b.name===pilotNames[2]);
   assert.equal(lane.length,1);assert.equal(lane[0].type,"plain_text");
   if(maintenance!==undefined){
    assert.equal(manifest.length,0);assert.equal(maintenanceBinding.length,1);
    assert.equal(r.oldVersion.resources.bindings.filter(b=>pilotNames.includes(b.name)).length,0,"old pilot/maintenance lane must be resolved");
    assert.equal(maintenanceBinding[0].type,"plain_text");assert.equal(lane[0].text,maintenance.requestId);
    same(JSON.parse(maintenanceBinding[0].text),maintenance);
   }else{
    assert.equal(maintenanceBinding.length,0);assert.equal(manifest.length,1);assert.equal(manifest[0].type,"plain_text");
    assert.equal(lane[0].text,p.requestId);same(JSON.parse(manifest[0].text),p);
    // A valid pilot grant must be preceded by the same-release maintenance
    // version and pinned completed reconciliation, not a historical build.
    const previous=r.oldVersion.resources.bindings;
    const oldMaintenance=previous.filter(b=>b.name===pilotNames[2]),oldPilot=previous.filter(b=>b.name===pilotNames[1]);
    const oldLane=previous.filter(b=>b.name===pilotNames[0]);
    assert.equal(oldMaintenance.length,1);assert.equal(oldPilot.length,0);assert.equal(oldLane.length,1);
    assert.equal(oldLane[0].type,"plain_text");assert.equal(oldLane[0].text,p.requestId);assert.equal(oldMaintenance[0].type,"plain_text");
    const old=JSON.parse(oldMaintenance[0].text);
    assert.equal(old.schema,"r4-freeze-v1");assert.equal(old.releaseSha,a.source);assert.equal(old.requestId,p.requestId);
    assert.equal(old.approvalRef,a.approvalRef);
   }
  }
  if(reuse){same(r.oldVersion,r.newVersion);continue;}
  const path="/accounts/"+a.accountId+"/workers/scripts/"+name+"/deployments";
  requests.push({worker:name,precondition:{deployment:t.rollbackDeployment,version:t.rollbackVersion},
   method:"POST",path,body:{strategy:"percentage",versions:[{version_id:t.version,percentage:100}],
    code_update_strategy:{mode:"immediate"},annotations:{"workers/message":"R4 promotion "+a.source+" "+a.approvalRef}},
   rollback:{method:"POST",path,body:{strategy:"percentage",versions:[{version_id:t.rollbackVersion,percentage:100}],code_update_strategy:{mode:"immediate"}},
    condition:"only after own promotion confirmed, physical close/no effects and exact latest deployment readback"}});
 }
 return {schema:"r4-promotion-plan-v1",source:a.source,ciRun:a.ciRun,manifestSha256:pin,expiresAt:a.expiresAt,requests,
  decision:"READY_FOR_EXPLICIT_ADMIN_APPLY",mode:maintenance?"freeze-only":"pilot",applied:false,providerDispatchAuthorized:false,completePass:false,
  instructions:maintenance?"Freeze only: no drain or reconciliation is certified. Read back both versions at 100%, then independently verify drain, then invoke account Workflow r4_reconcile.":"Revalidate both before first POST and each target immediately before its POST. Read back both versions at 100%, including reused MCP. STOP on ambiguity. Rollback is not data rollback."};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const [manifest,pin,observations]=process.argv.slice(2);
  console.log(JSON.stringify(promotionPlan(readFileSync(manifest),pin,JSON.parse(readFileSync(observations,"utf8")))));
 }catch(e){console.error("STOP_UNCERTIFIED_STAGING_RELEASE",e.message);process.exitCode=2;}
}

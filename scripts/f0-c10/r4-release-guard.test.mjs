import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {verifyApproval} from "./r4-release-guard.mjs";
const id="12345678-1234-1234-1234-123456789abc",source="a".repeat(40),now=1000000;
const receipt={schema:"r4-release-inventory-v2",source,role:"mcp",worker:"opencode-staging-control-mcp",
 bundle:{files:3,sha256:"b".repeat(64)},executable:"c".repeat(64),config:"d".repeat(64)};
const accountId="c".repeat(32),obs={accountId,id,versions:[{version_id:id,percentage:100}]};
const approval={schema:"r4-explicit-version-upload-v1",environment:"staging",accountId,operation:"upload-only",uploadAuthorized:true,
 source,ciRun:"42",ciConclusion:"success",ciHead:source,approvalRef:"test-only",notBefore:now-1,expiresAt:now+10000,
 worker:receipt.worker,role:receipt.role,inventory:receipt,rollbackDeployment:id,rollbackVersion:id,promoteAuthorized:false};
const bytes=v=>Buffer.from(JSON.stringify(v)),pin=b=>createHash("sha256").update(b).digest("hex");
const run=(v=approval,r=receipt,o=obs,t=now)=>{const b=bytes(v);return verifyApproval(b,pin(b),r,o,t);};
test("exact authorized upload-only envelope passes offline",()=>assert.equal(run().operation,"upload-only"));
test("unapproved hash, stale or wrong source, CI and wrong target fail closed",()=>{
 assert.throws(()=>verifyApproval(bytes(approval),"0".repeat(64),receipt,obs,now));
 for(const p of [{expiresAt:now},{source:"0".repeat(40)},{ciHead:"0".repeat(40)},{ciConclusion:"failure"},
  {uploadAuthorized:false},{promoteAuthorized:true},{worker:"opencode-harness-example"},{operation:"deploy"},
  {environment:"production"},{accountId:"0".repeat(32)}])assert.throws(()=>run({...approval,...p}));
});
test("tampered package, rollback drift and partial deployment fail closed",()=>{
 assert.throws(()=>run(approval,{...receipt,executable:"0".repeat(64)}));
 assert.throws(()=>run(approval,receipt,{...obs,id:"00000000-0000-0000-0000-000000000000"}));
 assert.throws(()=>run(approval,receipt,{...obs,versions:[{version_id:id,percentage:50}]}));
});

test("principal upload is rejected when the backend v2 contract is incomplete",()=>{
 const r={...receipt,role:"principal",worker:"opencode-g1-staging"};
 const v={...approval,role:r.role,worker:r.worker,inventory:r,pilot:{schema:"pilot-release-v2",environment:"staging",
   releaseSha:source,ciRun:"42",requestId:"a".repeat(16),sourceCommit:source,sourceTree:source,
   containerImageDigest:"sha256:"+"a".repeat(64),notBefore:now-1,expiresAt:now+1800000,
   approvalRef:"test-only",residualRisk:"accepted-bounded-trial",fingerprint:"a".repeat(64)}};
 assert.throws(()=>run(v,r),/invalid backend pilot authorization/);
});

test("maintenance envelope is separately authorized and cannot contain a pilot grant",()=>{
 const r={...receipt,role:"principal",worker:"opencode-g1-staging"};
 const maintenance={schema:"r4-reconciliation-v1",environment:"staging",releaseSha:source,requestId:"a".repeat(16),
  approvalRef:"test-only",externalDrainReceipt:"e".repeat(64),drainedAt:now-100,notBefore:now-100,expiresAt:now+10000};
 const m={...approval,role:r.role,worker:r.worker,inventory:r,maintenance};
 assert.equal(run(m,r).maintenance.schema,"r4-reconciliation-v1");
 assert.throws(()=>run({...m,pilot:{}},r));
 assert.throws(()=>run({...m,maintenance:{...maintenance,drainedAt:now-900001}},r));
});

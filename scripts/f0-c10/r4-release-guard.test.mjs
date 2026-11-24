import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {verifyApproval} from "./r4-release-guard.mjs";
const id="12345678-1234-1234-1234-123456789abc",source="a".repeat(40),now=1000000;
const receipt={schema:"r4-release-inventory-v2",source,role:"mcp",worker:"opencode-staging-control-mcp",
 bundle:{files:3,sha256:"b".repeat(64)},executable:"c".repeat(64),config:"d".repeat(64)};
const obs={id,versions:[{version_id:id,percentage:100}]};
const approval={schema:"r4-explicit-version-upload-v1",environment:"staging",operation:"upload-only",uploadAuthorized:true,
 source,ciRun:"42",ciConclusion:"success",ciHead:source,approvalRef:"test-only",notBefore:now-1,expiresAt:now+10000,
 worker:receipt.worker,role:receipt.role,inventory:receipt,rollbackDeployment:id,rollbackVersion:id,promoteAuthorized:false};
const bytes=v=>Buffer.from(JSON.stringify(v)),pin=b=>createHash("sha256").update(b).digest("hex");
const run=(v=approval,r=receipt,o=obs,t=now)=>{const b=bytes(v);return verifyApproval(b,pin(b),r,o,t);};
test("exact authorized upload-only envelope passes offline",()=>assert.equal(run().operation,"upload-only"));
test("unapproved hash, stale or wrong source, CI and wrong target fail closed",()=>{
 assert.throws(()=>verifyApproval(bytes(approval),"0".repeat(64),receipt,obs,now));
 for(const p of [{expiresAt:now},{source:"0".repeat(40)},{ciHead:"0".repeat(40)},{ciConclusion:"failure"},
  {uploadAuthorized:false},{promoteAuthorized:true},{worker:"opencode-harness-example"},{operation:"deploy"},
  {environment:"production"}])assert.throws(()=>run({...approval,...p}));
});
test("tampered package, rollback drift and partial deployment fail closed",()=>{
 assert.throws(()=>run(approval,{...receipt,executable:"0".repeat(64)}));
 assert.throws(()=>run(approval,receipt,{...obs,id:"00000000-0000-0000-0000-000000000000"}));
 assert.throws(()=>run(approval,receipt,{...obs,versions:[{version_id:id,percentage:50}]}));
});

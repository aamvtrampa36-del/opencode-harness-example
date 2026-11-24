import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {evaluateUsd2ApprovalReceipt} from "./preflight-03-usd2.mjs";

const manifestFile=fileURLToPath(new URL("../../docs/f0-c10/PREFLIGHT_03_USD2_AUTHORIZATION.json",import.meta.url));
const cliFile=fileURLToPath(new URL("./preflight-03-usd2.mjs",import.meta.url));
const fresh=()=>JSON.parse(readFileSync(manifestFile,"utf8"));

test("owner-approved ceiling = USD 2.00 across all costs, NEVER GO",()=>{
  const x=evaluateUsd2ApprovalReceipt(fresh());
  assert.deepEqual([x.totalCapUsd,x.totalCapMicroUsd,x.decision],["2.00",2_000_000,"STOP"]);
  assert.equal(x.liveDispatchAuthorized,false);
  assert.equal(x.providerHardCutoffVerified,false);
  assert.equal(x.isolatedLiveLeaseVerified,false);
  assert.equal(x.allCostsMeasured,false);
});
test("wrong amount, currency, and per-provider duplication fail closed",()=>{
  for(const patch of [
    {microUsd:2_000_001},
    {amount:"2.01"},
    {currency:"BRL"},
    {notPerProvider:false},
    {notPerTask:false}
  ]){
    const x=fresh();Object.assign(x.ownerDecision,patch);
    assert.throws(()=>evaluateUsd2ApprovalReceipt(x),/USD2_APPROVAL_CHANGED_OR_INVALID/);
  }
});
test("cannot claim provider GO or alter historical base SHA through JSON",()=>{
  for(const key of ["operationalLeaseDeployed","providerCutoffDeployed",
    "liveDispatchAuthorized","accountPolicyMutationsAuthorized"]){
    const x=fresh();x.implementation[key]=true;
    assert.throws(()=>evaluateUsd2ApprovalReceipt(x),/USD2_UNTRUSTED_JSON_CANNOT_PROVE_GO/);
  }
  const spoof=fresh();spoof.gate="GO";
  assert.throws(()=>evaluateUsd2ApprovalReceipt(spoof),/USD2_FORGED_GO/);
  const stale=fresh();stale.implementation.baseSha="f".repeat(40);
  assert.throws(()=>evaluateUsd2ApprovalReceipt(stale),/USD2_SOURCE_PROVENANCE_CHANGED/);
});
test("cannot mark a provider cutoff as proven without authenticated evidence",()=>{
  for(const key of ["singleControllingDurableObject","accountIsolation",
    "providerHardCutoffVerified","allRoutesIntercepted",
    "attributableCostUpperBoundVerified","rollbackVerified"]){
    const x=fresh();x.guarantees[key]=true;
    assert.throws(()=>evaluateUsd2ApprovalReceipt(x),/USD2_UNTRUSTED_JSON_CANNOT_PROVE_GO/);
  }
});
test("all ten cost channels must remain unknown instead of fabricated zero",()=>{
  for(const key of Object.keys(fresh().costInventory)){
    const x=fresh();x.costInventory[key]=0;
    assert.throws(()=>evaluateUsd2ApprovalReceipt(x),/USD2_COST_DATA_NOT_YET_VERIFIABLE/);
  }
  const missing=fresh();delete missing.costInventory.unclassified;
  assert.throws(()=>evaluateUsd2ApprovalReceipt(missing),/USD2_COST_DATA_NOT_YET_VERIFIABLE/);
});
test("HTTP 403 for modern spend policies must not be silently rewritten as configured",()=>{
  const x=fresh();x.cloudflareReadOnly.spendPoliciesModern.result="OK";
  assert.throws(()=>evaluateUsd2ApprovalReceipt(x),/USD2_BILLING_OBSERVATION_INVALID/);
});
test("command line receipt exits 2 STOP (not zero), with no secret or action",()=>{
  const result=spawnSync(process.execPath,[cliFile,"--manifest",manifestFile],{
    encoding:"utf8",timeout:5000
  });
  assert.equal(result.status,2);
  assert.equal(result.stderr,"");
  const output=JSON.parse(result.stdout);
  assert.equal(output.totalCapMicroUsd,2_000_000);
  assert.equal(output.decision,"STOP");
  assert.equal(output.liveDispatchAuthorized,false);
  assert.doesNotMatch(result.stdout,/account_id|access_token|OPENROUTER_API_KEY|CLOUDFLARE_API_TOKEN/);
});
test("missing or malformed file fails closed, never authorizes a charge",()=>{
  const result=spawnSync(process.execPath,[cliFile,"--manifest","/nonexistent-usd2.json"],{
    encoding:"utf8",timeout:5000
  });
  assert.equal(result.status,2);
  assert.match(result.stderr,/USD2_FAIL_CLOSED/);
  assert.equal(result.stdout,"");
});

const revalidatedFile=fileURLToPath(new URL("../../docs/f0-c10/PREFLIGHT_03_USD2_AUTHORIZATION_REVALIDATED.json",import.meta.url));
const revalidated=()=>JSON.parse(readFileSync(revalidatedFile,"utf8"));
test("historical 403 and later empty policy list are distinct STOP observations",()=>{
  const old=evaluateUsd2ApprovalReceipt(fresh());
  const now=evaluateUsd2ApprovalReceipt(revalidated());
  assert.equal(old.reason,"PROVIDER_BILLING_403_AND_ALL_SERVICE_CUTOFF_NOT_PROVEN");
  assert.equal(now.reason,"NO_SPEND_POLICIES_LISTED_AND_ALL_SERVICE_CUTOFF_NOT_PROVEN");
  assert.deepEqual([now.totalCapMicroUsd,now.decision,now.liveDispatchAuthorized,now.providerHardCutoffVerified],[2_000_000,"STOP",false,false]);
});
test("empty-list observation cannot be forged into policy enforcement",()=>{
  for(const patch of [{listedPolicyCount:1},{listedPolicyCount:null},{previousResult:"OK"},{verifiedActivePolicy:true},{method:"POST"},{result:"OK"}]){
    const x=revalidated();Object.assign(x.cloudflareReadOnly.spendPoliciesModern,patch);
    assert.throws(()=>evaluateUsd2ApprovalReceipt(x),/USD2_BILLING_OBSERVATION_INVALID/);
  }
  const x=revalidated();x.guarantees.providerHardCutoffVerified=true;
  assert.throws(()=>evaluateUsd2ApprovalReceipt(x),/USD2_UNTRUSTED_JSON_CANNOT_PROVE_GO/);
});
test("CLI revalidated receipt exits 2, never dispatches",()=>{
  const result=spawnSync(process.execPath,[cliFile,"--manifest",revalidatedFile],{encoding:"utf8",timeout:5000});
  assert.equal(result.status,2);
  assert.equal(result.stderr,"");
  assert.equal(JSON.parse(result.stdout).decision,"STOP");
  assert.equal(JSON.parse(result.stdout).liveDispatchAuthorized,false);
});

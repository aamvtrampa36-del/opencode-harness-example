/**
 * F0-C10/PREFLIGHT-03 machine-checkable approval receipt. Pure offline CLI.
 * STOP, exit 2 is required: this does not inspect billing, reserve resources
 * or make external calls. Never upgrade a JSON assertion into provider GO.
 */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

const REQUIRED_COSTS=[
  "workers_ai","openrouter","workers","durable_objects","containers",
  "github_actions","storage","egress","observability","unclassified"
];
const BLOCKED_FLAGS=[
  "operationalLeaseDeployed","providerCutoffDeployed","liveDispatchAuthorized",
  "accountPolicyMutationsAuthorized"
];
const REQUIRED_EVIDENCE=[
  "singleControllingDurableObject","accountIsolation",
  "providerHardCutoffVerified","allRoutesIntercepted",
  "attributableCostUpperBoundVerified","rollbackVerified"
];
function requireCondition(ok,message){if(!ok)throw Error(message)}
export function evaluateUsd2ApprovalReceipt(input){
  requireCondition(input&&input.schema==="f0-c10.preflight-usd2-approval.v1"&&
    input.project==="F0-C10","USD2_INVALID_PROVENANCE");
  const b=input.ownerDecision||{},i=input.implementation||{},cf=input.cloudflareReadOnly||{},
    guarantees=input.guarantees||{},costs=input.costInventory||{};
  requireCondition(b.currency==="USD"&&b.amount==="2.00"&&
    b.microUsd===2_000_000&&b.notPerTask===true&&b.notPerProvider===true,
    "USD2_APPROVAL_CHANGED_OR_INVALID");
  requireCondition(i.baseSha==="63706447d36b10ccbbaa87e75cc3e9874808ad54"&&
    i.basePr===159&&i.preflightPhase==="PREFLIGHT-03",
    "USD2_SOURCE_PROVENANCE_CHANGED");
  requireCondition(BLOCKED_FLAGS.every(k=>i[k]===false)&&
    REQUIRED_EVIDENCE.every(k=>guarantees[k]===false),
    "USD2_UNTRUSTED_JSON_CANNOT_PROVE_GO");
  requireCondition(input.gate==="STOP","USD2_FORGED_GO");
  // Historical receipts remain valid; a later successful empty list is not a cutoff.
  const observed=cf.spendPoliciesModern;
  const historicalBilling=observed?.result==="HTTP_403"&&observed.listedPolicyCount===undefined;
  const emptyBilling=observed?.result==="HTTP_200_EMPTY"&&
    observed.listedPolicyCount===0&&observed.previousResult==="HTTP_403";
  requireCondition(observed?.method==="GET"&&observed.verifiedActivePolicy===null&&
    (historicalBilling||emptyBilling),"USD2_BILLING_OBSERVATION_INVALID");
  requireCondition(Object.keys(costs).length===REQUIRED_COSTS.length&&
    REQUIRED_COSTS.every(k=>Object.hasOwn(costs,k)&&costs[k]===null),
    "USD2_COST_DATA_NOT_YET_VERIFIABLE");
  return {
    project:"F0-C10",currency:"USD",totalCapMicroUsd:2_000_000,
    totalCapUsd:"2.00",approvedNumericCeilingRecorded:true,
    budgetQuotesVerified:false,providerHardCutoffVerified:false,
    isolatedLiveLeaseVerified:false,allCostsMeasured:false,
    decision:"STOP",liveDispatchAuthorized:false,
    reason:historicalBilling?"PROVIDER_BILLING_403_AND_ALL_SERVICE_CUTOFF_NOT_PROVEN":
      "NO_SPEND_POLICIES_LISTED_AND_ALL_SERVICE_CUTOFF_NOT_PROVEN"
  };
}
function main(args){
  requireCondition(args.length===2&&args[0]==="--manifest"&&args[1],
    "USD2_USAGE_MANIFEST_REQUIRED");
  const input=JSON.parse(readFileSync(resolve(args[1]),"utf8"));
  const result=evaluateUsd2ApprovalReceipt(input);
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
  process.exitCode=2; // A valid receipt is NOT a GO.
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main(process.argv.slice(2))}
  catch(err){process.stderr.write("USD2_FAIL_CLOSED: "+String(err.message||err)+"\n");process.exitCode=2}
}

import { freezeGitHubSourcePin, sameGitHubSourcePin, type GitHubSourcePin } from "./metralla-m05-source";
import type { SupervisorTask } from "./supervisor-control";
import type { StartGrant, AdmissionSlot } from "./supervisor-admission";
import { paidPreflight, type BudgetPolicy, type PaidPreflight } from "./supervisor-inference-budget";
import { resolveAuthorizedMeteredSelection, type ModelSelectionID } from "./model-presets";

const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
type TaskApproval={requestId:string;fingerprint:string;selection:ModelSelectionID;pin:GitHubSourcePin};
export type NormalApproval={schema:"metralla-normal-v1";releaseSha:string;notBefore:number;expiresAt:number;
  approvalRef:string;policy:BudgetPolicy;preflight:PaidPreflight;tasks:TaskApproval[];
  contextBoundEvidence:Record<string,string>};
function check(ok:unknown,code:string):asserts ok {if(!ok)throw Error(code);}
export function parseNormalApproval(raw:unknown,release:string,now=Date.now()):NormalApproval{
  check(typeof raw==="string"&&raw.length<=65536&&SHA.test(release),"NORMAL_APPROVAL_REQUIRED");
  const a=JSON.parse(raw) as NormalApproval;
  check(a?.schema==="metralla-normal-v1"&&a.releaseSha===release&&
    Number.isSafeInteger(a.notBefore)&&a.notBefore<=now&&Number.isSafeInteger(a.expiresAt)&&a.expiresAt>now&&
    a.expiresAt-now<=24*3600000&&typeof a.approvalRef==="string"&&a.approvalRef.length>=8&&a.approvalRef.length<=160&&
    a.policy?.normal&&!a.policy.hybrid&&a.policy.normal.validUntil<=a.expiresAt&&
    a.policy.normal.validUntil>now&&a.policy.maxAttempts===1&&a.preflight&&
    paidPreflight({...a.preflight,now}).decision==="GO"&&Array.isArray(a.tasks)&&a.tasks.length>0&&a.tasks.length<=10,
    "NORMAL_APPROVAL_INVALID");
  const ids=new Set<string>();
  for(const x of a.tasks){
    check(x&&/^[a-f0-9]{16}$/.test(x.requestId)&&!ids.has(x.requestId)&&HASH.test(x.fingerprint),"NORMAL_APPROVAL_TASK");
    ids.add(x.requestId);x.pin=freezeGitHubSourcePin(x.pin);
    check(x.pin.branch==="opencode/"+(x.pin.repo==="aamvtrampa36-del/opencode-harness-example"?"staging-":"supervised-")+x.requestId,
      "NORMAL_APPROVAL_BRANCH");
    const route=Object.hasOwn(a.policy.normal.routes,x.selection)?a.policy.normal.routes[x.selection]:undefined;
    check(route&&typeof a.contextBoundEvidence?.[x.selection]==="string"&&HASH.test(a.contextBoundEvidence[x.selection]),"NORMAL_CONTEXT_BOUND_UNVERIFIED");
    resolveAuthorizedMeteredSelection(x.selection,route,now);
  }
  const listed=Object.values(a.policy.normal.rounds).flatMap(round=>round.taskIds);
  check(listed.length===ids.size&&listed.every(id=>ids.has(id))&&new Set(listed).size===ids.size,"NORMAL_APPROVAL_ROUND_SCOPE");
  return a;
}
export function approvedNormalTask(a:NormalApproval,task:Pick<SupervisorTask,"id"|"fingerprint"|"repository"|"branch"|"project"|"model"|"mode"|"forkedFrom">){
  const x=a.tasks.find(t=>t.requestId===task.id);
  check(x&&task.mode===undefined&&!task.forkedFrom&&x.fingerprint===task.fingerprint&&
    x.pin.repo===task.repository.toLowerCase()&&x.pin.branch===task.branch&&
    task.project==="supervised-"+task.id&&x.selection===(task.model??"economy"),"NORMAL_TASK_OUTSIDE_APPROVAL");
  return x;
}
export function assertNormalTaskPin(a:NormalApproval,task:SupervisorTask){
  const x=approvedNormalTask(a,task);
  check(task.githubSource&&sameGitHubSourcePin(task.githubSource,x.pin)&&
    (!task.baseCommit||task.baseCommit===x.pin.commit)&&(!task.sourceTree||task.sourceTree===x.pin.tree),
    "NORMAL_DURABLE_PIN_MISMATCH");return x.pin;
}
export function assertNormalGitHubFence(task:SupervisorTask|undefined,slot:AdmissionSlot|undefined,grant:StartGrant,pin:GitHubSourcePin,
  phase:"branch"|"mutation",session?:string){
  check(task&&task.id===grant.id&&!task.pilotInstance&&!task.mode&&task.githubSource&&sameGitHubSourcePin(task.githubSource,pin)&&
    task.project==="supervised-"+grant.id&&task.repository.toLowerCase()===pin.repo&&task.branch===pin.branch&&
    slot&&slot.token===grant.token&&slot.generation===grant.generation&&!task.cancelAmbiguous&&!task.pendingTurn,
    "NORMAL_GITHUB_FENCE");
  if(phase==="branch"){
    check(task.status==="preparing"&&!task.session&&!task.operationId&&slot.phase==="effect_unknown"&&slot.effect==="github_branch","NORMAL_BRANCH_FENCE");
  }else{
    check(task.status==="running"&&task.session===session&&session==="ses_r2_"+task.id&&
      task.operationId==="rc-start-"+task.id&&task.baseCommit===pin.commit&&task.sourceTree===pin.tree&&
      (slot.phase==="running"||slot.phase==="effect_unknown"&&slot.effect==="submit"),"NORMAL_MUTATION_FENCE");
  }
}

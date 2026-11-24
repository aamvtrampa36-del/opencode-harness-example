import type { SupervisorTask } from "./supervisor-control";
import { PILOT_WORK_MS, PILOT_CLOSE_MS, PILOT_MAX_WIRE_BYTES, PILOT_PRICING_REVISION, pilotBillingReviewValid, type PilotBillingReview, type PilotDispatchEvidence } from "./supervisor-inference-budget";

export const PILOT_REPO="aamvtrampa36-del/opencode-harness-example";
export const PILOT_BASE="f0-c10/integracion-final-20261123";
export const PILOT_CLAIM="supervisor:pilot:single-use-v1";
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[a-f0-9]{16}$/;
const UUID=/^[a-f0-9-]{36}$/;
const RECEIPTS=["sdkOffline","routeControls","closeControls","billingHeadroom","freeZeroPrice","glmBillingBound"] as const;
type EvidenceName=typeof RECEIPTS[number];
export type PilotApproval={
  schema:"pilot-release-v2";environment:"staging";requestId:string;releaseSha:string;
  fingerprint:string;notBefore:number;expiresAt:number;ciRun:string;approvalRef:string;
  residualRisk:"accepted-bounded-trial";plannedOtherMicroUsd:number;
  evidence:Record<EvidenceName,string>;pricingRevision:typeof PILOT_PRICING_REVISION;maxWireBytes:number;
  billingReview:PilotBillingReview;
};
export type PilotClaim={approval:PilotApproval;instance:string;objectId:string;startedAt:number};
function int(x:unknown,min:number,max:number){return typeof x==="number"&&Number.isSafeInteger(x)&&x>=min&&x<=max;}
function hash(x:unknown){return typeof x==="string"&&HASH.test(x);}
/** Deployment-admin-only configuration. Receipt digests identify externally
 * reviewed evidence; syntax validation does not authenticate their contents.
 * Economic evidence covers zero-price routing, GLM's published billing/context
 * rules and actual account headroom (including monthly rounding). Do not
 * populate until independently reviewed and authorized. No client/MCP input
 * can create or change this manifest. */
export function parsePilotApproval(raw:unknown,releaseSha:string,lane:string,now=Date.now()):PilotApproval|undefined {
  if(typeof raw!=="string"||raw.length>8192||!SHA.test(releaseSha)||!ID.test(lane))return undefined;
  try{
    const p=JSON.parse(raw) as PilotApproval;
    if(!p||p.schema!=="pilot-release-v2"||p.environment!=="staging"||p.requestId!==lane||
      p.releaseSha!==releaseSha||!hash(p.fingerprint)||!int(p.notBefore,0,now)||!int(p.expiresAt,now+PILOT_WORK_MS+PILOT_CLOSE_MS,now+60*60_000)||
      typeof p.ciRun!=="string"||!/^\d{1,20}$/.test(p.ciRun)||
      typeof p.approvalRef!=="string"||p.approvalRef.length<8||p.approvalRef.length>160||
      p.residualRisk!=="accepted-bounded-trial"||!int(p.plannedOtherMicroUsd,0,850_000)||
      p.pricingRevision!==PILOT_PRICING_REVISION||!int(p.maxWireBytes,1,PILOT_MAX_WIRE_BYTES)||
      !pilotBillingReviewValid(p.billingReview,now)||
      !p.evidence||!RECEIPTS.every(k=>hash(p.evidence[k])))return undefined;
    return p;
  }catch{return undefined;}
}
export function validatePilotClaim(claim:PilotClaim,task:SupervisorTask,now:number){
  if(!claim||!UUID.test(claim.instance)||!HASH.test(claim.objectId)||claim.startedAt!==task.createdAt||
    claim.approval.requestId!==task.id||claim.approval.fingerprint!==task.fingerprint||
    task.repository!==PILOT_REPO||task.model!=="cloudflare"||task.mode!==undefined||task.forkedFrom||
    task.pilotInstance!==claim.instance||task.project!=="supervised-"+task.id||
    !parsePilotApproval(JSON.stringify(claim.approval),claim.approval.releaseSha,task.id,now))throw Error("PILOT_AUTHORIZATION_INVALID");
}
/** Committed atomically with T03 admission, never reclaimed by TTL.
 * Process identity fences a restarted isolate. */
export function evidenceFromClaim(claim:PilotClaim|undefined,approval:PilotApproval|undefined,
  instance:string,objectId:string,task:SupervisorTask,now=Date.now()):PilotDispatchEvidence|undefined{
  if(!claim||!approval||claim.instance!==instance||claim.objectId!==objectId||
    claim.startedAt!==task.createdAt||task.pilotInstance!==instance||task.id!==approval.requestId||
    task.fingerprint!==approval.fingerprint||task.repository!==PILOT_REPO||
    JSON.stringify(claim.approval)!==JSON.stringify(approval)||
    now>=claim.startedAt+PILOT_WORK_MS||now>=approval.expiresAt)return undefined;
  return {kind:"pilot-risk-bounded-v2",experimentId:task.id,instance,validUntil:claim.startedAt+PILOT_WORK_MS,
    residualRiskExplicitlyAccepted:true,exclusiveLeaseVerified:true,
    actualSdkInterceptorVerified:true,noUncontrolledRoutesVerified:true,closeVerified:true,billingHeadroomReviewed:true,billingReview:approval.billingReview,
    plannedOtherMicroUsd:approval.plannedOtherMicroUsd,pricingRevision:approval.pricingRevision,maxWireBytes:approval.maxWireBytes,
    freeZeroPriceReceipt:approval.evidence.freeZeroPrice,glmBillingBoundReceipt:approval.evidence.glmBillingBound};
}

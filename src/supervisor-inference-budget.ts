/**
 * F0-C10/R3-T07: durable cost journal. PILOTO-01 reuses this transaction
 * authority at the hybrid binding adapter. No network in this module.
 * Existing strict preflight and ordinary policies are preserved. The pilot
 * requires separately attested, risk-bounded server-side dispatch evidence.
 */
import { validateNormalPolicy, newNormalState, normalReserve, normalDispatch, normalRoundMove, type NormalPolicy, type NormalState } from "./metralla-m04-policy.ts";
import type { StartGrant } from "./supervisor-admission";
import type { SupervisorTask } from "./supervisor-control";
import type { PilotClaim } from "./pilot-authorization";
import { durablePreparationValid } from "./pilot-preparation.ts";
import { CONSUMED_PILOT_ID, consumedArchiveExempts, reconciliationDigest } from "./supervisor-reconciliation.ts";

export type Price = { inputMicroUsdPerMillion: number; outputMicroUsdPerMillion: number; revision: string };
export type ModelAllowance = { providerID: string; modelID: string; price: Price };
export const PILOT_FREE = "openrouter:openrouter/free";
export const PILOT_BACKUP = "cloudflare";
export const PILOT_GLM = "@cf/zai-org/glm-4.7-flash";
export const PILOT_MAX_CALLS = 20;
/** Post-response acceptance limit, not a tokenizer certificate. */
export const PILOT_INPUT_TOKENS = 64_000;
export const PILOT_OUTPUT_TOKENS = 8_000;
export const PILOT_MAX_WIRE_BYTES = 48 * 1024;
// Published GLM context includes input, reasoning and completion. Reserve the
// FULL context as input PLUS the output cap, never credit free account quotas.
// Rates round UP from 5500/36400 neurons per million at $0.011/1000.
// This is a conservative single-inference rating, not a provider invoice cap.
export const PILOT_GLM_BILLABLE_INPUT_CEILING = 131_072;
export const PILOT_GLM_INPUT_RATE = 61_000;
export const PILOT_GLM_OUTPUT_RATE = 401_000;
export const PILOT_GLM_RESERVE_MICRO_USD = 11_500;
export const PILOT_PRICING_REVISION = "2026-11-24-context-neurons-v2";
export const PILOT_MAX_PAID_CALLS = 13;
export const PILOT_INFERENCE_MICRO_USD = 150_000;
export const PILOT_WORK_MS = 15 * 60_000;
export const PILOT_CLOSE_MS = 5 * 60_000;
export type HybridPolicy = { session: string; instance: string; workUntil: number };
type HybridState = { calls: number; paidCalls: number; selection: typeof PILOT_FREE | typeof PILOT_BACKUP; pending?: string };
export type BudgetPolicy = {
  experimentId: string; totalMicroUsd: number; taskMicroUsd: number;
  maxAttempts: number; selections: Record<string, ModelAllowance>; hybrid?: HybridPolicy; normal?: NormalPolicy;
};
export type InferenceIntent = {
  requestId: string; operationId: string; callId: string; attemptId: string;
  selection: string; inputTokenCeiling: number; outputTokenCeiling: number; wireBytes?: number; payloadSha256?:string;
};
type Counter = { confirmed: number; reserved: number; unknown: number };
type Global = Counter & { version: 1; policy: string; paymentBlocked: boolean; hybrid?: HybridState; normal?: NormalState };
type Row = { identity: string; requestId: string; operationId: string; callId: string;
  attemptId: string; attemptIds: string[]; attempts: number; selection: string;
  providerID: string; modelID: string; price: Price; inputTokenCeiling: number;
  outputTokenCeiling: number; exposure: number; state: "reserved" | "sent" | "unknown" | "rejected" | "settled";
  reason?: string; receiptId?: string; inputTokens?: number; outputTokens?: number; charge?: number; actualModel?: string;
  generation?:number; releaseSha?:string; sessionId?:string; reservedAt?:number; dispatchAt?:number; terminalAt?:number };
const GLOBAL = "supervisor:inference:budget:v1";
const TASK = (id: string) => "supervisor:inference:task:" + id;
const CALL = (id: string, call: string) => "supervisor:inference:call:" + id + ":" + call;
const RECEIPT = (provider: string, id: string) => "supervisor:inference:receipt:" + provider + ":" + id;
const ID = /^[a-f0-9]{16}$/;
const CALL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PRICE_LIMIT = 1_000_000_000;
const CASH_LIMIT = 1_000_000_000_000;
const TOKENS_LIMIT = 1_048_576;
const int = (x: unknown, min: number, max: number) => typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max;
function requireValue(condition: unknown, label: string): asserts condition { if (!condition) throw Error(label); }
function policySnapshot(policy: BudgetPolicy): string {
  requireValue(ID.test(policy.experimentId) && int(policy.totalMicroUsd, 1, CASH_LIMIT) &&
    int(policy.taskMicroUsd, 1, policy.totalMicroUsd) && int(policy.maxAttempts, 1, 8), "BUDGET_POLICY_INVALID");
  if (policy.hybrid) {
    const h = policy.hybrid, free = policy.selections?.[PILOT_FREE], backup = policy.selections?.[PILOT_BACKUP];
    requireValue(h.session === "ses_r2_" + policy.experimentId &&
      /^[a-f0-9-]{36}$/.test(h.instance) && int(h.workUntil,1,Number.MAX_SAFE_INTEGER) &&
      policy.totalMicroUsd === PILOT_INFERENCE_MICRO_USD && policy.taskMicroUsd === PILOT_INFERENCE_MICRO_USD &&
      policy.maxAttempts === 1 && Object.keys(policy.selections).length === 2 &&
      free?.providerID === "openrouter" && free.modelID === "openrouter/free" &&
      free.price?.inputMicroUsdPerMillion === 0 && free.price?.outputMicroUsdPerMillion === 0 &&
      backup?.providerID === "cloudflare" && backup.modelID === PILOT_GLM &&
      free.price?.revision === PILOT_PRICING_REVISION &&
      backup.price?.inputMicroUsdPerMillion === PILOT_GLM_INPUT_RATE &&
      backup.price?.outputMicroUsdPerMillion === PILOT_GLM_OUTPUT_RATE &&
      backup.price?.revision === PILOT_PRICING_REVISION &&
      PILOT_MAX_PAID_CALLS * PILOT_GLM_RESERVE_MICRO_USD <= PILOT_INFERENCE_MICRO_USD,
      "PILOT_POLICY_INVALID");
  }
  requireValue(!policy.normal || !policy.hybrid,"NORMAL_AND_PILOT_MUTUALLY_EXCLUSIVE");
  if(policy.normal)validateNormalPolicy(policy.normal,policy.totalMicroUsd,policy.selections);
  const selections = Object.keys(policy.selections ?? {}).sort();
  requireValue(selections.length > 0 && selections.length <= 16, "BUDGET_POLICY_INVALID");
  const canonical: Record<string, ModelAllowance> = Object.create(null);
  for (const selection of selections) {
    const model = policy.selections[selection];
    requireValue(/^[\w:./-]{1,160}$/.test(selection) && model &&
      ["cloudflare", "openrouter"].includes(model.providerID) &&
      typeof model.modelID === "string" && model.modelID.length > 0 && model.modelID.length < 160 &&
      model.price && int(model.price.inputMicroUsdPerMillion, policy.hybrid && selection === PILOT_FREE ? 0 : 1, PRICE_LIMIT) &&
      int(model.price.outputMicroUsdPerMillion, policy.hybrid && selection === PILOT_FREE ? 0 : 1, PRICE_LIMIT) &&
      typeof model.price.revision === "string" && model.price.revision.length > 0,
    "BUDGET_POLICY_INVALID");
    canonical[selection] = model;
  }
  return JSON.stringify({ experimentId:policy.experimentId, totalMicroUsd:policy.totalMicroUsd,
    taskMicroUsd:policy.taskMicroUsd, maxAttempts:policy.maxAttempts, selections:canonical,
    ...(policy.hybrid ? {hybrid:policy.hybrid} : {}), ...(policy.normal?{normal:policy.normal}:{}) });
}
function reserveCost(intent: InferenceIntent, price: Price): number {
  requireValue(int(intent.inputTokenCeiling, 1, TOKENS_LIMIT) &&
    int(intent.outputTokenCeiling, 1, TOKENS_LIMIT), "TOKEN_CEILING_MISSING");
  return Math.ceil((intent.inputTokenCeiling * price.inputMicroUsdPerMillion +
    intent.outputTokenCeiling * price.outputMicroUsdPerMillion) / 1_000_000);
}
function zero(): Counter { return { confirmed: 0, reserved: 0, unknown: 0 }; }
function total(c: Counter): number { return c.confirmed + c.reserved + c.unknown; }
function adjust(c: Counter, delta: Partial<Counter>) {
  for (const key of ["confirmed", "reserved", "unknown"] as const) {
    const value = c[key] + (delta[key] ?? 0);
    requireValue(int(value, 0, CASH_LIMIT), "BUDGET_ACCOUNTING_CORRUPT");
    c[key] = value;
  }
}
/** Only valid at an actual T03 transaction boundary, not a UI/MCP caller-supplied claim. */
async function assertT03(tx: DurableObjectTransaction, grant: StartGrant, intent: InferenceIntent, policy: BudgetPolicy) {
  requireValue(ID.test(grant.id) && grant.id === intent.requestId &&
    CALL_ID.test(intent.callId) && CALL_ID.test(intent.attemptId) &&
    typeof intent.operationId === "string", "INFERENCE_IDENTITY_INVALID");
  const ledger = await tx.get<{version:number;slots:Record<string,{token:string;generation:number;phase:string;effect?:string}>}>("supervisor:admission:v1");
  const slot = ledger?.version === 1 ? ledger.slots?.[grant.id] : undefined;
  const task = await tx.get<SupervisorTask>("supervisor:task:" + grant.id);
  requireValue(slot && slot.token === grant.token && slot.generation === grant.generation &&
    (slot.phase === "running" || (slot.phase === "effect_unknown" &&
      ["submit", "turn_submit"].includes(slot.effect ?? ""))) &&
    task?.sessionIdPolicy === "deterministic-v1" &&
    ["running", "preparing"].includes(task.status) && !task.cancelAmbiguous &&
    task.operationId === intent.operationId &&
    (intent.operationId === "rc-start-" + grant.id ||
      /^rc-turn-[a-f0-9]{16}-[a-f0-9]{16}$/.test(intent.operationId)) &&
    (policy.hybrid ? task.model === PILOT_BACKUP : intent.selection === (task.model ?? "economy")),
    "T03_FENCE_OR_MODEL_INVALID");
  if(policy.normal){requireValue(!task.pilotInstance,"NORMAL_PILOT_TASK_FORBIDDEN");
    if(task.githubSource)requireValue(int(task.normalWorkUntil,Date.now()+1,policy.normal.validUntil),"NORMAL_WORK_DEADLINE");
  }
  if (policy.hybrid) {
    const h = policy.hybrid;
    requireValue(grant.id === policy.experimentId && task.session === h.session &&
      task.project === "supervised-" + grant.id && task.pilotInstance === h.instance &&
      typeof task.createdAt === "number" && h.workUntil === task.createdAt + PILOT_WORK_MS &&
      Date.now() < h.workUntil && task.status === "running" && !task.pendingTurn &&
      task.operationId === "rc-start-" + grant.id &&
      Object.keys(ledger!.slots).length === 1 &&
      await tx.get<string>("supervisor:session:" + h.session) === grant.id &&
      [PILOT_FREE,PILOT_BACKUP].includes(intent.selection) &&
      intent.inputTokenCeiling === (intent.selection===PILOT_BACKUP?PILOT_GLM_BILLABLE_INPUT_CEILING:PILOT_INPUT_TOKENS) &&
      intent.outputTokenCeiling === PILOT_OUTPUT_TOKENS,
      "PILOT_FENCE_SESSION_OR_DEADLINE_INVALID");
    requireValue(await durablePreparationValid(task,await tx.get<PilotClaim>("supervisor:pilot:single-use-v1"),grant), "PILOT_PREPARATION_REQUIRED");
  }
}
function assertIntent(intent: InferenceIntent) {
  requireValue(ID.test(intent.requestId) && CALL_ID.test(intent.callId) &&
    CALL_ID.test(intent.attemptId) && typeof intent.selection === "string", "INFERENCE_IDENTITY_INVALID");
}
async function readGlobal(tx: DurableObjectTransaction, snapshot: string, policy: BudgetPolicy): Promise<Global> {
  const previous = await tx.get<Global>(GLOBAL);
  if (!previous) return {version:1,policy:snapshot,paymentBlocked:false,...zero(),
    ...(policy.hybrid ? {hybrid:{calls:0,paidCalls:0,selection:PILOT_FREE}} : {}),
    ...(policy.normal?{normal:newNormalState(policy.normal)}:{})};
  requireValue(previous.version === 1 && previous.policy === snapshot &&
    [previous.confirmed,previous.reserved,previous.unknown].every(x => int(x,0,CASH_LIMIT)),
  "BUDGET_POLICY_CHANGED_OR_CORRUPT");
  if (policy.hybrid) requireValue(previous.hybrid &&
    int(previous.hybrid.calls,0,PILOT_MAX_CALLS) &&
    int(previous.hybrid.paidCalls,0,Math.min(PILOT_MAX_PAID_CALLS,previous.hybrid.calls)) &&
    (previous.hybrid.selection!==PILOT_FREE || previous.hybrid.paidCalls===0) &&
    [PILOT_FREE,PILOT_BACKUP].includes(previous.hybrid.selection) &&
    (previous.hybrid.pending === undefined || CALL_ID.test(previous.hybrid.pending)),
    "PILOT_LEDGER_CORRUPT");
  else requireValue(!previous.hybrid, "PILOT_LEDGER_POLICY_MISMATCH");
  requireValue(Boolean(previous.normal)===Boolean(policy.normal),"NORMAL_LEDGER_POLICY_MISMATCH");
  return previous;
}
function intentFingerprint(intent:InferenceIntent){return JSON.stringify({requestId:intent.requestId,operationId:intent.operationId,
  callId:intent.callId,selection:intent.selection,inputTokenCeiling:intent.inputTokenCeiling,
  outputTokenCeiling:intent.outputTokenCeiling,...(intent.wireBytes===undefined?{}:{wireBytes:intent.wireBytes}),
  ...(intent.payloadSha256===undefined?{}:{payloadSha256:intent.payloadSha256})});}
function moveNormal(global:Global,intent:InferenceIntent,from:"reserved"|"unknown",to:"unknown"|"confirmed"|"released",exposure:number,charge=0){
  if(global.normal){const p=(JSON.parse(global.policy) as BudgetPolicy).normal;requireValue(p,"NORMAL_LEDGER_POLICY_MISMATCH");normalRoundMove(p,global.normal,intent,from,to,exposure,charge);}
}
/** Read-only preflight; never replaces/archives an incompatible historical ledger. */
export async function assertNormalBudgetReady(storage:DurableObjectStorage,policy:BudgetPolicy,proof:PaidPreflight){
  requireValue(policy.normal&&!policy.hybrid&&paidPreflight({...proof,now:Date.now()}).decision==="GO","PAID_PREFLIGHT_STOP");
  const snap=policySnapshot(policy);
  await storage.transaction(async tx=>{const g=await readGlobal(tx,snap,policy);requireValue(!g.paymentBlocked&&g.unknown===0,"NORMAL_UNRESOLVED_CHARGE");});
}
/** Same T03 Durable Object owner. No external RPC/await other than DO storage inside the tx. */
export async function reserveInference(storage: DurableObjectStorage, grant: StartGrant,
  intent: InferenceIntent, policy: BudgetPolicy) {
  assertIntent(intent);
  const snap = policySnapshot(policy), allowance = Object.prototype.hasOwnProperty.call(policy.selections,intent.selection)?policy.selections[intent.selection]:undefined;
  requireValue(allowance, "MODEL_NOT_ALLOWED");
  const ratedExposure = reserveCost(intent, allowance.price);
  const paidPilot = Boolean(policy.hybrid && intent.selection===PILOT_BACKUP);
  if(paidPilot)requireValue(ratedExposure<=PILOT_GLM_RESERVE_MICRO_USD,"PILOT_RATING_EXCEEDS_RESERVE");
  const expectedExposure = paidPilot ? PILOT_GLM_RESERVE_MICRO_USD : ratedExposure;
  return storage.transaction(async tx => {
    await assertT03(tx,grant,intent,policy);
    const global = await readGlobal(tx,snap,policy);
    requireValue(!global.paymentBlocked, "PAYMENT_BLOCKED");
    const key = CALL(intent.requestId,intent.callId);
    const old = await tx.get<Row>(key);
    const identity = intentFingerprint(intent);
    if (old) {
      requireValue(old.identity === identity, "INFERENCE_FINGERPRINT_CONFLICT");
      if (old.attemptId === intent.attemptId) return {kind:"existing" as const,state:old.state};
      requireValue(old.state === "rejected" && old.reason !== "402" && old.reason !== "403" && old.reason !== "cancelled_before_dispatch", "UPSTREAM_EFFECT_UNCERTAIN");
      requireValue(old.attempts < policy.maxAttempts && !old.attemptIds.includes(intent.attemptId),
      "INFERENCE_RETRY_DENIED");
    }
    if (policy.hybrid) {
      const h=global.hybrid!;
      requireValue(!h.pending && h.calls < PILOT_MAX_CALLS && h.selection === intent.selection && !old,
        "PILOT_CALL_LIMIT_PENDING_OR_PROVIDER");
      if(paidPilot){
        requireValue(h.paidCalls<PILOT_MAX_PAID_CALLS,"PILOT_PAID_CALL_LIMIT");
        // Lifetime count: a cheap success never replenishes a paid-call slot.
        h.paidCalls++;
      }
      h.calls++; h.pending=intent.callId;
    }
    const task = await tx.get<Counter>(TASK(intent.requestId)) ?? zero();
    requireValue(total(global) + expectedExposure <= policy.totalMicroUsd &&
      total(task) + expectedExposure <= policy.taskMicroUsd, "INFERENCE_BUDGET_EXHAUSTED");
    if(policy.normal){requireValue(task.unknown===0,"NORMAL_UNRESOLVED_CHARGE");normalReserve(policy.normal,global.normal!,intent,expectedExposure,Date.now());}
    const row: Row = {identity,requestId:intent.requestId,operationId:intent.operationId,
      callId:intent.callId,attemptId:intent.attemptId,attemptIds:[...(old?.attemptIds ?? []),intent.attemptId],
      attempts:(old?.attempts ?? 0)+1,selection:intent.selection,
      providerID:allowance.providerID,modelID:allowance.modelID,price:allowance.price,
      inputTokenCeiling:intent.inputTokenCeiling,outputTokenCeiling:intent.outputTokenCeiling,
      exposure:expectedExposure,state:"reserved"};
    if(policy.normal){const owner=await tx.get<SupervisorTask>("supervisor:task:"+grant.id);
      if(owner?.githubSource)Object.assign(row,{generation:grant.generation,releaseSha:owner.normalReleaseSha,sessionId:owner.session,reservedAt:Date.now()});}
    adjust(global,{reserved:expectedExposure});adjust(task,{reserved:expectedExposure});
    await tx.put(key,row);await tx.put(TASK(intent.requestId),task);await tx.put(GLOBAL,global);
    return {kind:"reserved" as const,exposureMicroUsd:expectedExposure};
  });
}
/** Preflight is evaluated for EVERY real model call, not just task start. */
export type SpendService = "workers_ai"|"openrouter"|"workers"|"durable_objects"|"containers"|"github_actions";
export type ServiceProof = { active:boolean; disabledRouteVerified?:boolean; routeBound?:boolean;
  measuredAt?:number; validUntil?:number; hardStopProven?:boolean; remainingMicroUsd?:number;
  worstInFlightMicroUsd?:number; exclusiveAccount?:boolean; }; 
export type PaidPreflight = { now:number; exclusiveLeaseVerified:boolean; actualSdkInterceptorVerified:boolean;
  noUncontrolledRoutesVerified:boolean; disposabilityVerified:boolean;
  services:Partial<Record<SpendService,ServiceProof>> };
export function paidPreflight(input: PaidPreflight): {decision:"GO"|"STOP"; blockers:string[]} {
  const blockers:string[]=[];
  if (!input.exclusiveLeaseVerified) blockers.push("T03_EXCLUSIVE_LEASE_UNKNOWN");
  if (!input.actualSdkInterceptorVerified) blockers.push("SDK_INFERENCE_BYPASS_UNKNOWN");
  if (!input.noUncontrolledRoutesVerified) blockers.push("UNCONTROLLED_MODEL_ROUTE");
  if (!input.disposabilityVerified) blockers.push("ISOLATED_DISPOSABLE_ENV_UNKNOWN");
  const services:SpendService[]=["workers_ai","openrouter","workers","durable_objects","containers","github_actions"];
  for (const service of services) {
    const p=input.services?.[service];
    if (!p) {blockers.push(service+":UNKNOWN");continue;}
    if (p.active === false) {
      if (p.disabledRouteVerified !== true) blockers.push(service+":BYPASS_NOT_PROVEN");
      continue;
    }
    if (p.active !== true || p.routeBound !== true || p.hardStopProven !== true ||
      p.exclusiveAccount !== true || !int(p.measuredAt,0,Number.MAX_SAFE_INTEGER) ||
      !int(p.validUntil,0,Number.MAX_SAFE_INTEGER) || p.measuredAt! > input.now ||
      p.validUntil! <= input.now || !int(p.remainingMicroUsd,0,CASH_LIMIT) ||
      !int(p.worstInFlightMicroUsd,0,CASH_LIMIT) ||
      p.remainingMicroUsd! < p.worstInFlightMicroUsd!) blockers.push(service+":HARD_STOP_NOT_PROVEN");
  }
  return {decision:blockers.length?"STOP":"GO",blockers};
}
/** Private server evidence, not an input schema or a client boolean. No
 * caller-supplied claim supplies this evidence. The pilot's risk objective differs
 * from a guaranteed invoice: do not weaken the original strict preflight. */
/** Review a conservative account-duration scenario, not a live billing cutoff.
 * Billable DO duration can be rounded into $12.50 blocks. For this pilot only
 * accept a scenario that stays inside the included 400,000 GB-s. Historical
 * data may be used explicitly as a proxy just after a billing-cycle reset.
 * The operator must verify the underlying receipt, lag and shared activity. */
export type PilotBillingReview = {
  basis:"current-cycle-metered"|"previous-cycle-proxy";
  cycleStart:number; observedThrough:number;
  observedDurationGbSeconds:number; sharedAndLagMarginGbSeconds:number;
  pilotAllowanceGbSeconds:number;
};
export function pilotBillingReviewValid(review:unknown,now:number):boolean{
  const r=review as Partial<PilotBillingReview>|undefined;
  const lag=72*60*60_000;
  if(!r||!int(now,0,Number.MAX_SAFE_INTEGER)||!int(r.cycleStart,0,now)||
    !int(r.observedThrough,Math.max(0,now-lag),now)||
    !int(r.observedDurationGbSeconds,0,400_000)||
    !int(r.sharedAndLagMarginGbSeconds,1,400_000)||
    !int(r.pilotAllowanceGbSeconds,2_000,400_000))return false;
  if(r.basis==="current-cycle-metered"){
    if(r.observedThrough!<r.cycleStart!)return false;
  }else if(r.basis==="previous-cycle-proxy"){
    if(now-r.cycleStart!>lag||r.observedThrough!>r.cycleStart!)return false;
  }else return false;
  return r.observedDurationGbSeconds!+r.sharedAndLagMarginGbSeconds!+r.pilotAllowanceGbSeconds!<=400_000;
}
export type PilotDispatchEvidence = {
  kind:"pilot-risk-bounded-v2"; experimentId:string; instance:string; validUntil:number;
  residualRiskExplicitlyAccepted:true; exclusiveLeaseVerified:true;
  actualSdkInterceptorVerified:true; noUncontrolledRoutesVerified:true;
  /** Offline close controls, not a physical-stop observation. */
  closeVerified:true; billingHeadroomReviewed:true; plannedOtherMicroUsd:number;
  billingReview:PilotBillingReview;
  pricingRevision:typeof PILOT_PRICING_REVISION; maxWireBytes:number;
  freeZeroPriceReceipt:string; glmBillingBoundReceipt:string; preparationDigest:string;
};
export function pilotDispatchEvidenceValid(policy:BudgetPolicy, proof:unknown, now=Date.now()): boolean {
  const p=proof as Partial<PilotDispatchEvidence>|undefined;
  return Boolean(policy.hybrid && p?.kind==="pilot-risk-bounded-v2" &&
    p.experimentId===policy.experimentId && p.instance===policy.hybrid.instance &&
    int(p.validUntil,now+1,policy.hybrid.workUntil) &&
    p.residualRiskExplicitlyAccepted===true && p.exclusiveLeaseVerified===true &&
    p.actualSdkInterceptorVerified===true && p.noUncontrolledRoutesVerified===true &&
    p.closeVerified===true && p.billingHeadroomReviewed===true &&
    pilotBillingReviewValid(p.billingReview,now) &&
    int(p.plannedOtherMicroUsd,0,850_000) &&
    p.pricingRevision===PILOT_PRICING_REVISION &&
    int(p.maxWireBytes,1,PILOT_MAX_WIRE_BYTES) &&
    typeof p.preparationDigest==="string" && /^[a-f0-9]{64}$/.test(p.preparationDigest) &&
    typeof p.freeZeroPriceReceipt==="string" && /^[a-f0-9]{64}$/.test(p.freeZeroPriceReceipt) &&
    typeof p.glmBillingBoundReceipt==="string" && /^[a-f0-9]{64}$/.test(p.glmBillingBoundReceipt));
}
export function pilotBudgetPolicy(id:string,instance:string,createdAt:number):BudgetPolicy {
  return {experimentId:id,totalMicroUsd:PILOT_INFERENCE_MICRO_USD,
    taskMicroUsd:PILOT_INFERENCE_MICRO_USD,maxAttempts:1,
    selections:{
      [PILOT_FREE]:{providerID:"openrouter",modelID:"openrouter/free",price:{inputMicroUsdPerMillion:0,outputMicroUsdPerMillion:0,revision:PILOT_PRICING_REVISION}},
      [PILOT_BACKUP]:{providerID:"cloudflare",modelID:PILOT_GLM,price:{inputMicroUsdPerMillion:PILOT_GLM_INPUT_RATE,outputMicroUsdPerMillion:PILOT_GLM_OUTPUT_RATE,revision:PILOT_PRICING_REVISION}}
    },hybrid:{session:"ses_r2_"+id,instance,workUntil:createdAt+PILOT_WORK_MS}};
}
/** Read selected provider; optionally switch once when the trusted key loader
 * proves no primary request can be sent (no key). Never switch an in-flight call. */
export async function pilotProviderSelection(storage:DurableObjectStorage,grant:StartGrant,
  policy:BudgetPolicy, intent:InferenceIntent, primaryUnavailableBeforeSend:boolean) {
  const snap=policySnapshot(policy);
  requireValue(policy.hybrid,"PILOT_POLICY_REQUIRED");
  return storage.transaction(async tx=>{
    await assertT03(tx,grant,intent,policy);
    const global=await readGlobal(tx,snap,policy), h=global.hybrid!;
    requireValue(!global.paymentBlocked && !h.pending && h.calls<PILOT_MAX_CALLS,"PILOT_CALL_LIMIT_OR_UNCERTAIN_EFFECT");
    if(primaryUnavailableBeforeSend && h.selection===PILOT_FREE) {
      h.selection=PILOT_BACKUP;
      await tx.put(GLOBAL,global);
    }
    if(h.selection===PILOT_BACKUP)requireValue(h.paidCalls<PILOT_MAX_PAID_CALLS,"PILOT_PAID_CALL_LIMIT");
    return h.selection;
  });
}
/** Exactly one dispatch flag per attempt. The pilot adapter invokes this
 * immediately before the actual network or Workers AI binding call. */
export async function beginInferenceDispatch(storage: DurableObjectStorage,grant:StartGrant,
  intent:InferenceIntent,policy:BudgetPolicy,preflight:PaidPreflight|PilotDispatchEvidence) {
  requireValue(policy.hybrid ? pilotDispatchEvidenceValid(policy,preflight) :
    !("kind" in preflight) && paidPreflight({...preflight,now:Date.now()}).decision === "GO", "PAID_PREFLIGHT_STOP");
  const snap=policySnapshot(policy);
  return storage.transaction(async tx=>{
    await assertT03(tx,grant,intent,policy);
    const global=await readGlobal(tx,snap,policy);
    requireValue(!global.paymentBlocked,"PAYMENT_BLOCKED");
    const row=await tx.get<Row>(CALL(intent.requestId,intent.callId));
    requireValue(row && row.attemptId===intent.attemptId && row.identity===intentFingerprint(intent),"INFERENCE_RESERVATION_MISSING");
    if(row.state!=="reserved")return {proceed:false,state:row.state};
    if(policy.hybrid) {
      const task=await tx.get<SupervisorTask>("supervisor:task:"+grant.id);
      requireValue(global.hybrid?.pending===intent.callId && pilotDispatchEvidenceValid(policy,preflight) &&
        "preparationDigest" in preflight && task?.pilotPreparation?.digest===preflight.preparationDigest, "PILOT_DISPATCH_FENCED");
    }
    if(policy.normal){requireValue(!("kind" in preflight)&&paidPreflight({...preflight,now:Date.now()}).decision==="GO","PAID_PREFLIGHT_STOP");
      normalDispatch(policy.normal,global.normal!,intent,Date.now());await tx.put(GLOBAL,global);}
    row.state="sent";if(row.reservedAt!==undefined)row.dispatchAt=Date.now();
    await tx.put(CALL(intent.requestId,intent.callId),row);
    return {proceed:true,state:"sent" as const};
  });
}
export async function markInferenceUnknown(storage:DurableObjectStorage,intent:InferenceIntent,reason:string) {
  requireValue(reason.length>0 && reason.length<128,"INVALID_UNKNOWN_REASON");
  return storage.transaction(async tx=>{
    const key=CALL(intent.requestId,intent.callId),row=await tx.get<Row>(key);
    requireValue(row && row.attemptId===intent.attemptId && row.identity===intentFingerprint(intent),"INFERENCE_ATTEMPT_MISMATCH");
    if(row.state==="unknown")return {reused:true};
    requireValue(row.state==="sent","INFERENCE_NOT_SENT");
    const global=await tx.get<Global>(GLOBAL),task=await tx.get<Counter>(TASK(intent.requestId));
    requireValue(global && task,"INFERENCE_LEDGER_MISSING");
    adjust(global,{reserved:-row.exposure,unknown:row.exposure});
    adjust(task,{reserved:-row.exposure,unknown:row.exposure});
    moveNormal(global,intent,"reserved","unknown",row.exposure);
    // Even a zero-rated Free request with an invalid receipt is a stop.
    if(global.hybrid)global.paymentBlocked=true;
    row.state="unknown";row.reason=reason;if(row.reservedAt!==undefined)row.terminalAt=Date.now();
    await tx.put(key,row);await tx.put(GLOBAL,global);await tx.put(TASK(intent.requestId),task);
    return {reused:false};
  });
}
/** Proof is required from a private trusted adapter; HTTP status alone is not proof. */
export async function rejectInferenceBeforeGeneration(storage:DurableObjectStorage,intent:InferenceIntent,
  receipt:{origin:"trusted-provider-adapter"; beforeGeneration:true; code:"429"|"3040"|"402"|"403"; preGenerationSource?:"openrouter_free_tier_per_minute"|"openrouter_free_tier_per_day"}) {
  requireValue(receipt.origin==="trusted-provider-adapter" && receipt.beforeGeneration===true &&
    ["429","3040","402","403"].includes(receipt.code),"PREGEN_PROOF_REQUIRED");
  return storage.transaction(async tx=>{
    const key=CALL(intent.requestId,intent.callId),row=await tx.get<Row>(key);
    requireValue(row && row.attemptId===intent.attemptId && row.identity===intentFingerprint(intent),"INFERENCE_ATTEMPT_MISMATCH");
    if(row.state==="rejected"&&row.reason===receipt.code)return {reused:true};
    requireValue(row.state==="sent","UNKNOWN_EFFECT_MUST_NOT_RELEASE");
    const global=await tx.get<Global>(GLOBAL),task=await tx.get<Counter>(TASK(intent.requestId));
    requireValue(global && task,"INFERENCE_LEDGER_MISSING");
    adjust(global,{reserved:-row.exposure});adjust(task,{reserved:-row.exposure});
    if(global.hybrid) {
      requireValue(global.hybrid.pending===intent.callId && row.selection===PILOT_FREE &&
        global.hybrid.selection===PILOT_FREE && receipt.code==="429" &&
        ["openrouter_free_tier_per_minute","openrouter_free_tier_per_day"].includes(receipt.preGenerationSource??""),
        "PILOT_FALLBACK_REQUIRES_ROUTER_PREGEN_PROOF");
      global.hybrid.selection=PILOT_BACKUP;delete global.hybrid.pending;
    }
    moveNormal(global,intent,"reserved","released",row.exposure);
    if(receipt.code==="402"||receipt.code==="403")global.paymentBlocked=true;
    row.state="rejected";row.reason=receipt.code;if(row.reservedAt!==undefined)row.terminalAt=Date.now();
    await tx.put(key,row);await tx.put(GLOBAL,global);await tx.put(TASK(intent.requestId),task);
    return {reused:false};
  });
}
/** Rated cost is NOT an invoice; late receipts may settle an unknown even after slot reclaim. */
export async function settleInference(storage:DurableObjectStorage,intent:InferenceIntent,
  receipt:{origin:"trusted-provider-adapter"; receiptId:string; inputTokens:number; outputTokens:number; actualModel?:string}) {
  requireValue(receipt.origin==="trusted-provider-adapter" && CALL_ID.test(receipt.receiptId) &&
    int(receipt.inputTokens,0,TOKENS_LIMIT) && int(receipt.outputTokens,0,TOKENS_LIMIT),"USAGE_RECEIPT_REQUIRED");
  return storage.transaction(async tx=>{
    const key=CALL(intent.requestId,intent.callId),row=await tx.get<Row>(key);
    requireValue(row && row.attemptId===intent.attemptId && row.identity===intentFingerprint(intent),"INFERENCE_ATTEMPT_MISMATCH");
    if(row.state==="settled") {
      requireValue(row.receiptId===receipt.receiptId && row.inputTokens===receipt.inputTokens &&
        row.outputTokens===receipt.outputTokens && row.actualModel===receipt.actualModel,"DUPLICATE_SETTLEMENT_CONFLICT");
      return {reused:true,chargedMicroUsd:row.charge!};
    }
    requireValue(row.state==="sent"||row.state==="unknown","INFERENCE_NOT_BILLABLE");
    requireValue(receipt.inputTokens<=row.inputTokenCeiling && receipt.outputTokens<=row.outputTokenCeiling,
      "UPSTREAM_USAGE_OVER_CEILING");
    const charged=Math.ceil((receipt.inputTokens*row.price.inputMicroUsdPerMillion+
      receipt.outputTokens*row.price.outputMicroUsdPerMillion)/1_000_000);
    requireValue(charged<=row.exposure,"CHARGE_EXCEEDS_RESERVATION");
    const receiptKey=RECEIPT(row.providerID,receipt.receiptId);
    const previous=await tx.get<string>(receiptKey);
    requireValue(!previous || previous===key,"PROVIDER_RECEIPT_REUSED_OTHER_CALL");
    const global=await tx.get<Global>(GLOBAL),task=await tx.get<Counter>(TASK(intent.requestId));
    requireValue(global && task,"INFERENCE_LEDGER_MISSING");
    if(global.normal)requireValue(receipt.actualModel===row.modelID,"NORMAL_MODEL_RECEIPT_MISMATCH");
    if(global.hybrid) {
      requireValue(global.hybrid.pending===intent.callId && row.state==="sent" &&
        receipt.inputTokens<=PILOT_INPUT_TOKENS && receipt.outputTokens<=PILOT_OUTPUT_TOKENS &&
        typeof receipt.actualModel==="string" && receipt.actualModel.length>0 && receipt.actualModel.length<=160 &&
        (row.selection!==PILOT_BACKUP || receipt.actualModel===PILOT_GLM),
        "PILOT_TERMINAL_RECEIPT_REQUIRED");
      delete global.hybrid.pending;
    }
    const bucket=row.state==="unknown"?"unknown":"reserved";
    adjust(global,{[bucket]:-row.exposure,confirmed:charged});
    adjust(task,{[bucket]:-row.exposure,confirmed:charged});
    moveNormal(global,intent,bucket,"confirmed",row.exposure,charged);
    row.state="settled";row.receiptId=receipt.receiptId;row.inputTokens=receipt.inputTokens;if(row.reservedAt!==undefined)row.terminalAt=Date.now();
    row.outputTokens=receipt.outputTokens;row.charge=charged;row.actualModel=receipt.actualModel;
    await tx.put(key,row);await tx.put(receiptKey,key);await tx.put(GLOBAL,global);
    await tx.put(TASK(intent.requestId),task);
    return {reused:false,chargedMicroUsd:charged};
  });
}
export async function inferenceBudgetTotals(storage:Pick<DurableObjectStorage,"get">) {
  const global=await storage.get<Global>(GLOBAL);
  return global ? {confirmed:global.confirmed,reserved:global.reserved,unknown:global.unknown,
    exposureMicroUsd:total(global),paymentBlocked:global.paymentBlocked,
    ...(global.hybrid ? {pilot:{...global.hybrid}} : {})} : null;
}
/** Cancellation before the dispatch flag is durable is the only local release proof. Never clears sent/unknown. */
export async function cancelReservedNormalInference(storage:DurableObjectStorage,grant:StartGrant,intent:InferenceIntent,policy:BudgetPolicy){
  requireValue(policy.normal&&!policy.hybrid,"NORMAL_POLICY_REQUIRED");
  const snapshot=policySnapshot(policy);
  return storage.transaction(async tx=>{
    await assertT03(tx,grant,intent,policy);
    const key=CALL(intent.requestId,intent.callId),row=await tx.get<Row>(key);
    requireValue(row&&row.attemptId===intent.attemptId&&row.identity===intentFingerprint(intent),"INFERENCE_ATTEMPT_MISMATCH");
    if(row.state==="rejected"&&row.reason==="cancelled_before_dispatch")return {reused:true};
    requireValue(row.state==="reserved","UNKNOWN_EFFECT_MUST_NOT_RELEASE");
    const global=await readGlobal(tx,snapshot,policy),task=await tx.get<Counter>(TASK(intent.requestId));
    requireValue(task,"INFERENCE_LEDGER_MISSING");
    adjust(global,{reserved:-row.exposure});adjust(task,{reserved:-row.exposure});
    moveNormal(global,intent,"reserved","released",row.exposure);
    row.state="rejected";row.reason="cancelled_before_dispatch";if(row.reservedAt!==undefined)row.terminalAt=Date.now();
    await tx.put(key,row);await tx.put(GLOBAL,global);await tx.put(TASK(intent.requestId),task);
    return {reused:false};
  });
}
export async function normalInferenceStatus(storage:Pick<DurableObjectStorage,"get">){
  const g=await storage.get<Global>(GLOBAL);
  if(!g?.normal)return null;
  return {calls:g.normal.calls,active:g.normal.active,rounds:g.normal.rounds,
    confirmed:g.confirmed,reserved:g.reserved,unknown:g.unknown,
    canCloseAccounting:g.normal.active===0&&g.reserved===0&&g.unknown===0,paymentBlocked:g.paymentBlocked};
}

/** Proposal only: no provider selection mutation or dispatch. T03 must authorize
 * the model change and a new callId. A generic 429 or any unknown is not a receipt. */
export async function normalFallbackAllowed(storage:DurableObjectStorage,grant:StartGrant,intent:InferenceIntent,policy:BudgetPolicy,target:string){
  requireValue(policy.normal&&!policy.hybrid,"NORMAL_POLICY_REQUIRED");
  const snapshot=policySnapshot(policy);
  return storage.transaction(async tx=>{
    await assertT03(tx,grant,intent,policy);
    const global=await readGlobal(tx,snapshot,policy),row=await tx.get<Row>(CALL(intent.requestId,intent.callId));
    const route=Object.hasOwn(policy.normal!.routes,target)?policy.normal!.routes[target]:undefined;
    requireValue(!global.paymentBlocked&&row&&row.identity===intentFingerprint(intent)&&row.attemptId===intent.attemptId&&
      row.state==="rejected"&&["429","3040"].includes(row.reason??"")&&
      Object.hasOwn(policy.normal!.fallbacks??{},intent.selection)&&policy.normal!.fallbacks![intent.selection].includes(target)&&
      route&&Date.now()<route.validUntil&&Date.now()<policy.normal!.validUntil,"NORMAL_FALLBACK_NOT_AUTHORIZED");
    return {selection:target,requiresNewAuthorizedT03Selection:true};
  });
}

/** Unknown provider effect is never physical-close accounting evidence. */
export async function normalTaskAccountingClosed(tx:Pick<DurableObjectTransaction,"get">,id:string){
  const global=await tx.get<Global>(GLOBAL),task=await tx.get<Counter>(TASK(id));
  if(!global?.normal||global.hybrid||global.version!==1)return false;
  const state=global.normal.tasks[id];
  return Boolean(state&&state.active===0&&task&&task.reserved===0&&task.unknown===0&&
    int(task.confirmed,0,CASH_LIMIT)&&int(state.calls,0,10000));
}

/** Replace only a completely settled consumed pilot policy. All old task/call/
 * provider-receipt keys remain immutable and globally unique. No zeroing debt.
 * Account Workflow verifies the independent authorization outside this transaction;
 * exact prior/new digests and expiry are rechecked inside it. */
export type BudgetTransition={schema:"metralla-budget-transition-v1";releaseSha:string;approvalRef:string;
 previousDigest:string;nextPolicyDigest:string;archiveDigest:string;notBefore:number;expiresAt:number};
const BUDGET_TRANSITION="supervisor:inference:transition:v1:";
export async function normalBudgetTransitionSnapshot(storage:DurableObjectStorage,policy:BudgetPolicy){
  requireValue(policy.normal&&!policy.hybrid,"NORMAL_POLICY_REQUIRED");
  const nextPolicy=policySnapshot(policy);
  return storage.transaction(async tx=>{
    const previous=await tx.get<Global>(GLOBAL),archive=await tx.get<{digest:string}>("supervisor:consumed-pilot:archive:v1:"+CONSUMED_PILOT_ID);
    return {previousDigest:await reconciliationDigest(previous??null),nextPolicyDigest:await reconciliationDigest(nextPolicy),archiveDigest:archive?.digest??null};
  });
}
/** Read-only accounting evidence for the fixed consumed pilot. Not external closure or authorization. */
async function assertConsumedBudgetSettled(tx:Pick<DurableObjectTransaction,"get"|"list">,previous:Global|undefined){
  // Scan only the consumed pilot's bounded history, not the complete historical database.
  const rows=await tx.list<Row>({prefix:"supervisor:inference:call:"+CONSUMED_PILOT_ID+":",limit:PILOT_MAX_CALLS+1});
  requireValue(rows.size<=PILOT_MAX_CALLS,"BUDGET_TRANSITION_HISTORY_LIMIT");
  const task=await tx.get<Counter>(TASK(CONSUMED_PILOT_ID));
  if(previous){
    let old:BudgetPolicy;try{old=JSON.parse(previous.policy);}catch{throw Error("BUDGET_TRANSITION_OLD_POLICY");}
    requireValue(old.experimentId===CONSUMED_PILOT_ID&&old.hybrid&&!old.normal&&policySnapshot(old)===previous.policy&&previous.version===1&&
      previous.hybrid&&!previous.normal&&!previous.paymentBlocked&&!previous.hybrid.pending&&previous.reserved===0&&previous.unknown===0&&
      int(previous.confirmed,0,old.totalMicroUsd)&&previous.hybrid.calls===rows.size,"BUDGET_TRANSITION_OLD_UNSETTLED");
    let confirmed=0;
    for(const [rowKey,row] of rows){
      requireValue(row.requestId===CONSUMED_PILOT_ID&&rowKey===CALL(row.requestId,row.callId)&&row.attempts===1&&
        ["settled","rejected"].includes(row.state)&&int(row.exposure,0,old.totalMicroUsd),"BUDGET_TRANSITION_CALL_UNSETTLED");
      const allowed=Object.hasOwn(old.selections,row.selection)?old.selections[row.selection]:undefined;
      requireValue(allowed&&allowed.providerID===row.providerID&&allowed.modelID===row.modelID&&await reconciliationDigest(row.price)===await reconciliationDigest(allowed.price),"BUDGET_TRANSITION_CALL_POLICY");
      if(row.state==="settled"){
        requireValue(int(row.charge,0,row.exposure)&&int(row.inputTokens,0,row.inputTokenCeiling)&&int(row.outputTokens,0,row.outputTokenCeiling)&&
          row.charge===Math.ceil((row.inputTokens!*allowed.price.inputMicroUsdPerMillion+row.outputTokens!*allowed.price.outputMicroUsdPerMillion)/1000000)&&typeof row.receiptId==="string"&&await tx.get(RECEIPT(row.providerID,row.receiptId))===rowKey,"BUDGET_TRANSITION_RECEIPT_INVALID");
        confirmed+=row.charge!;
      }
    }
    requireValue(confirmed===previous.confirmed&&(!rows.size&&!task&&confirmed===0||task&&task.confirmed===confirmed&&task.reserved===0&&task.unknown===0),"BUDGET_TRANSITION_COUNTER_MISMATCH");
  }else requireValue(rows.size===0&&!task,"BUDGET_TRANSITION_ORPHAN_HISTORY");
  return {schema:"metralla-consumed-budget-readback-v1" as const,requestId:CONSUMED_PILOT_ID,
    previousDigest:await reconciliationDigest(previous??null),calls:rows.size,
    confirmedMicroUsd:previous?.confirmed??0,reservedMicroUsd:0,unknownMicroUsd:0,
    ledgerPresent:previous!==undefined,accountingSettled:true as const};
}
export async function inspectConsumedBudget(storage:DurableObjectStorage){
  return storage.transaction(async tx=>assertConsumedBudgetSettled(tx,await tx.get<Global>(GLOBAL)));
}
/** Both private readbacks require a real, settled ledger. Neither initializes it. */
async function readSettledNormalBudget(storage:DurableObjectStorage,policy:BudgetPolicy,checkPaid?:()=>void){
  const snap=policySnapshot(policy);
  requireValue(policy.normal&&!policy.hybrid,"NORMAL_POLICY_REQUIRED");
  checkPaid?.();
  return storage.transaction(async tx=>{
    const g=await tx.get<Global>(GLOBAL);
    requireValue(g?.version===1&&g.policy===snap&&g.normal&&!g.hybrid&&!g.paymentBlocked&&
      int(g.confirmed,0,policy.totalMicroUsd)&&g.reserved===0&&g.unknown===0&&g.normal.active===0,"NORMAL_LEDGER_NOT_READY");
    const ledger=await tx.get<{version:number;slots:Record<string,unknown>}>("supervisor:admission:v1");
    requireValue(ledger?.version===1&&ledger.slots&&Object.keys(ledger.slots).length===0&&await consumedArchiveExempts(tx,ledger.slots),"BUDGET_TRANSITION_NOT_DRAINED");
    const archive=await tx.get<{digest:string}>("supervisor:consumed-pilot:archive:v1:"+CONSUMED_PILOT_ID);
    requireValue(archive,"NORMAL_LEDGER_NOT_READY");
    checkPaid?.();
    return {policyDigest:await reconciliationDigest(snap),ledgerDigest:await reconciliationDigest(g),
      archiveDigest:archive.digest,confirmedMicroUsd:g.confirmed,reservedMicroUsd:0,unknownMicroUsd:0,active:0,accountingReady:true};
  });
}
export async function inspectNormalBudgetReady(storage:DurableObjectStorage,policy:BudgetPolicy,proof:PaidPreflight,clock=Date.now){
  const check=()=>requireValue(paidPreflight({...proof,now:clock()}).decision==="GO","PAID_PREFLIGHT_STOP");
  return {schema:"metralla-normal-budget-readback-v1",...await readSettledNormalBudget(storage,policy,check)};
}
/** A prepared ledger is not a paid preflight or a dispatch approval. */
export async function inspectPreparedNormalBudget(storage:DurableObjectStorage,policy:BudgetPolicy){
  return {schema:"metralla-normal-budget-accounting-v1",...await readSettledNormalBudget(storage,policy)};
}
type TransitionMode={kind:"paid";proof:PaidPreflight}|{kind:"prepare"};
export async function transitionConsumedBudget(storage:DurableObjectStorage,policy:BudgetPolicy,proof:PaidPreflight,
  authority:BudgetTransition,verify:(a:BudgetTransition)=>Promise<boolean>,clock=Date.now){
  return commitConsumedBudget(storage,policy,{kind:"paid",proof},authority,verify,clock);
}
/** Private, signed accounting-only transition; all CAS, archive, unknown-debt,
 * historical-row and new-ID guards are shared with the paid transition.
 * Does not create a task, reserve spend, grant GO or call any provider. */
export async function prepareConsumedBudget(storage:DurableObjectStorage,policy:BudgetPolicy,
  authority:BudgetTransition,verify:(a:BudgetTransition)=>Promise<boolean>,clock=Date.now){
  return commitConsumedBudget(storage,policy,{kind:"prepare"},authority,verify,clock);
}
async function commitConsumedBudget(storage:DurableObjectStorage,policy:BudgetPolicy,mode:TransitionMode,
  authority:BudgetTransition,verify:(a:BudgetTransition)=>Promise<boolean>,clock:()=>number){
  const a=structuredClone(authority),snap=policySnapshot(policy),nextPolicyDigest=await reconciliationDigest(snap);
  const paidAllowed=(now:number)=>mode.kind==="prepare"||paidPreflight({...mode.proof,now}).decision==="GO";
  const now=clock(),valid=()=>a?.schema==="metralla-budget-transition-v1"&&/^[a-f0-9]{40}$/.test(a.releaseSha)&&
    typeof a.approvalRef==="string"&&a.approvalRef.length>=8&&a.approvalRef.length<=160&&
    [a.previousDigest,a.nextPolicyDigest,a.archiveDigest].every(x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x))&&
    int(a.notBefore,0,clock())&&int(a.expiresAt,clock()+1,now+3600000)&&a.nextPolicyDigest===nextPolicyDigest&&
    (mode.kind!=="prepare"||!!policy.normal&&policy.normal.validUntil>clock());
  requireValue(policy.normal&&!policy.hybrid&&valid()&&paidAllowed(now)&&await verify(a),"BUDGET_TRANSITION_AUTHORIZATION");
  return storage.transaction(async tx=>{
    requireValue(valid()&&paidAllowed(clock()),"BUDGET_TRANSITION_EXPIRED");
    const key=BUDGET_TRANSITION+policy.experimentId;
    const previous=await tx.get<Global>(GLOBAL),prior=await tx.get<{authorization:BudgetTransition;previous:Global|null;nextPolicyDigest:string;digest:string}>(key);
    if(prior){
      const {digest,...body}=prior;
      requireValue(digest===await reconciliationDigest(body)&&await reconciliationDigest(prior.authorization)===await reconciliationDigest(a)&&previous?.policy===snap,"BUDGET_TRANSITION_CONFLICT");
      return {digest,reused:true};
    }
    requireValue(await reconciliationDigest(previous??null)===a.previousDigest,"BUDGET_TRANSITION_SNAPSHOT_CHANGED");
    const ledger=await tx.get<{version:number;slots:Record<string,unknown>}>("supervisor:admission:v1");
    requireValue(ledger?.version===1&&ledger.slots&&Object.keys(ledger.slots).length===0&&await consumedArchiveExempts(tx,ledger.slots),"BUDGET_TRANSITION_NOT_DRAINED");
    const archive=await tx.get<{digest:string}>("supervisor:consumed-pilot:archive:v1:"+CONSUMED_PILOT_ID);
    requireValue(archive?.digest===a.archiveDigest,"BUDGET_TRANSITION_ARCHIVE_CHANGED");
    await assertConsumedBudgetSettled(tx,previous);
    requireValue(policy.experimentId!==CONSUMED_PILOT_ID,"BUDGET_TRANSITION_ID_REUSED");
    for(const id of Object.values(policy.normal!.rounds).flatMap(x=>x.taskIds)){
      requireValue(id!==CONSUMED_PILOT_ID&&!await tx.get("supervisor:task:"+id)&&!await tx.get(TASK(id))&&
        (await tx.list({prefix:"supervisor:inference:call:"+id+":",limit:1})).size===0,"BUDGET_TRANSITION_ID_REUSED");
    }
    const body={authorization:a,previous:previous??null,nextPolicyDigest};
    const digest=await reconciliationDigest(body);
    await tx.put(key,{...body,digest});
    await tx.put(GLOBAL,{version:1,policy:snap,paymentBlocked:false,...zero(),normal:newNormalState(policy.normal!) } satisfies Global);
    return {digest,reused:false};
  });
}

/** Fixed metadata projection of the authoritative provider journal. No prompt,
 * response text, credentials or reservation token. Lexical cursor is scoped
 * by the private observer Workflow; not a provider-native start/end oracle. */
export async function readProviderReceipts(storage:Pick<DurableObjectStorage,"list">,task:SupervisorTask,after:string|null,limit=16){
  requireValue(task.githubSource&&typeof task.normalReleaseSha==="string"&&/^[a-f0-9]{40}$/.test(task.normalReleaseSha)&&task.session==="ses_r2_"+task.id&&task.operationId==="rc-start-"+task.id&&
    (after===null||CALL_ID.test(after))&&int(limit,1,16),"PROVIDER_RECEIPT_SCOPE");
  const prefix="supervisor:inference:call:"+task.id+":";
  const rows=await storage.list<Row>({prefix,...(after?{startAfter:prefix+after}:{}),limit:limit+1});
  requireValue(rows.size<=limit+1,"PROVIDER_RECEIPT_LIMIT");
  const selected=[...rows].slice(0,limit).map(([key,row])=>{
    requireValue(key===prefix+row.callId&&row.requestId===task.id&&row.sessionId===task.session&&row.operationId===task.operationId&&row.releaseSha===task.normalReleaseSha&&
      int(row.generation,1,Number.MAX_SAFE_INTEGER)&&int(row.reservedAt,0,Number.MAX_SAFE_INTEGER)&&
      (row.dispatchAt===undefined||int(row.dispatchAt,row.reservedAt!,Number.MAX_SAFE_INTEGER))&&
      (row.terminalAt===undefined||int(row.terminalAt,row.dispatchAt??row.reservedAt!,Number.MAX_SAFE_INTEGER)),"PROVIDER_RECEIPT_COVERAGE_UNKNOWN");
    return {requestId:row.requestId,sessionId:row.sessionId,operationId:row.operationId,releaseSha:row.releaseSha,generation:row.generation,
      callId:row.callId,providerID:row.providerID,modelID:row.modelID,state:row.state,reservedAt:row.reservedAt,dispatchAt:row.dispatchAt??null,
      terminalAt:row.terminalAt??null,providerReceiptHash:row.receiptId??null,inputTokens:row.inputTokens??null,outputTokens:row.outputTokens??null,chargedMicroUsd:row.charge??null};
  });
  return {source:"provider-dispatch-ledger",rows:selected,nextAfter:rows.size>limit?selected.at(-1)!.callId:null,nativeProviderTimingVerified:false};
}

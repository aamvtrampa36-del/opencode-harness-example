/**
 * F0-C10/R3-T07: candidate durable cost journal, NOT CONNECTED to the model SDK.
 * Called only by a trusted server-side inference adapter on the same T03 owner DO.
 * No scheduler, billing configuration, queue, model dispatch or provider network.
 */
import type { StartGrant } from "./supervisor-admission";

export type Price = { inputMicroUsdPerMillion: number; outputMicroUsdPerMillion: number; revision: string };
export type ModelAllowance = { providerID: string; modelID: string; price: Price };
export type BudgetPolicy = {
  experimentId: string; totalMicroUsd: number; taskMicroUsd: number;
  maxAttempts: number; selections: Record<string, ModelAllowance>;
};
export type InferenceIntent = {
  requestId: string; operationId: string; callId: string; attemptId: string;
  selection: string; inputTokenCeiling: number; outputTokenCeiling: number;
};
type Counter = { confirmed: number; reserved: number; unknown: number };
type Global = Counter & { version: 1; policy: string; paymentBlocked: boolean };
type Row = { identity: string; requestId: string; operationId: string; callId: string;
  attemptId: string; attemptIds: string[]; attempts: number; selection: string;
  providerID: string; modelID: string; price: Price; inputTokenCeiling: number;
  outputTokenCeiling: number; exposure: number; state: "reserved" | "sent" | "unknown" | "rejected" | "settled";
  reason?: string; receiptId?: string; inputTokens?: number; outputTokens?: number; charge?: number };
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
  const selections = Object.keys(policy.selections ?? {}).sort();
  requireValue(selections.length > 0 && selections.length <= 16, "BUDGET_POLICY_INVALID");
  const canonical: Record<string, ModelAllowance> = Object.create(null);
  for (const selection of selections) {
    const model = policy.selections[selection];
    requireValue(/^[\w:./-]{1,160}$/.test(selection) && model &&
      ["cloudflare", "openrouter"].includes(model.providerID) &&
      typeof model.modelID === "string" && model.modelID.length > 0 && model.modelID.length < 160 &&
      model.price && int(model.price.inputMicroUsdPerMillion, 1, PRICE_LIMIT) &&
      int(model.price.outputMicroUsdPerMillion, 1, PRICE_LIMIT) &&
      typeof model.price.revision === "string" && model.price.revision.length > 0,
    "BUDGET_POLICY_INVALID");
    canonical[selection] = model;
  }
  return JSON.stringify({ experimentId:policy.experimentId, totalMicroUsd:policy.totalMicroUsd,
    taskMicroUsd:policy.taskMicroUsd, maxAttempts:policy.maxAttempts, selections:canonical });
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
async function assertT03(tx: DurableObjectTransaction, grant: StartGrant, intent: InferenceIntent) {
  requireValue(ID.test(grant.id) && grant.id === intent.requestId &&
    CALL_ID.test(intent.callId) && CALL_ID.test(intent.attemptId) &&
    typeof intent.operationId === "string", "INFERENCE_IDENTITY_INVALID");
  const ledger = await tx.get<{version:number;slots:Record<string,{token:string;generation:number;phase:string;effect?:string}>}>("supervisor:admission:v1");
  const slot = ledger?.version === 1 ? ledger.slots?.[grant.id] : undefined;
  const task = await tx.get<{model?:string;status:string;operationId?:string;sessionIdPolicy?:string;
    pendingTurn?:{operationId:string};cancelAmbiguous?:boolean}>("supervisor:task:" + grant.id);
  requireValue(slot && slot.token === grant.token && slot.generation === grant.generation &&
    (slot.phase === "running" || (slot.phase === "effect_unknown" &&
      ["submit", "turn_submit"].includes(slot.effect ?? ""))) &&
    task?.sessionIdPolicy === "deterministic-v1" &&
    ["running", "preparing"].includes(task.status) && !task.cancelAmbiguous &&
    task.operationId === intent.operationId &&
    (intent.operationId === "rc-start-" + grant.id ||
      /^rc-turn-[a-f0-9]{16}-[a-f0-9]{16}$/.test(intent.operationId)) &&
    intent.selection === (task.model ?? "economy"), "T03_FENCE_OR_MODEL_INVALID");
}
function assertIntent(intent: InferenceIntent) {
  requireValue(ID.test(intent.requestId) && CALL_ID.test(intent.callId) &&
    CALL_ID.test(intent.attemptId) && typeof intent.selection === "string", "INFERENCE_IDENTITY_INVALID");
}
async function readGlobal(tx: DurableObjectTransaction, snapshot: string): Promise<Global> {
  const previous = await tx.get<Global>(GLOBAL);
  if (!previous) return {version:1,policy:snapshot,paymentBlocked:false,...zero()};
  requireValue(previous.version === 1 && previous.policy === snapshot &&
    [previous.confirmed,previous.reserved,previous.unknown].every(x => int(x,0,CASH_LIMIT)),
  "BUDGET_POLICY_CHANGED_OR_CORRUPT");
  return previous;
}
/** Same T03 Durable Object owner. No external RPC/await other than DO storage inside the tx. */
export async function reserveInference(storage: DurableObjectStorage, grant: StartGrant,
  intent: InferenceIntent, policy: BudgetPolicy) {
  assertIntent(intent);
  const snap = policySnapshot(policy), allowance = policy.selections[intent.selection];
  requireValue(allowance, "MODEL_NOT_ALLOWED");
  const expectedExposure = reserveCost(intent, allowance.price);
  return storage.transaction(async tx => {
    await assertT03(tx,grant,intent);
    const global = await readGlobal(tx,snap);
    requireValue(!global.paymentBlocked, "PAYMENT_BLOCKED");
    const key = CALL(intent.requestId,intent.callId);
    const old = await tx.get<Row>(key);
    const identity = JSON.stringify({requestId:intent.requestId,operationId:intent.operationId,
      callId:intent.callId,selection:intent.selection,inputTokenCeiling:intent.inputTokenCeiling,
      outputTokenCeiling:intent.outputTokenCeiling});
    if (old) {
      requireValue(old.identity === identity, "INFERENCE_FINGERPRINT_CONFLICT");
      if (old.attemptId === intent.attemptId) return {kind:"existing" as const,state:old.state};
      requireValue(old.state === "rejected" && old.reason !== "402", "UPSTREAM_EFFECT_UNCERTAIN");
      requireValue(old.attempts < policy.maxAttempts && !old.attemptIds.includes(intent.attemptId),
      "INFERENCE_RETRY_DENIED");
    }
    const task = await tx.get<Counter>(TASK(intent.requestId)) ?? zero();
    requireValue(total(global) + expectedExposure <= policy.totalMicroUsd &&
      total(task) + expectedExposure <= policy.taskMicroUsd, "INFERENCE_BUDGET_EXHAUSTED");
    const row: Row = {identity,requestId:intent.requestId,operationId:intent.operationId,
      callId:intent.callId,attemptId:intent.attemptId,attemptIds:[...(old?.attemptIds ?? []),intent.attemptId],
      attempts:(old?.attempts ?? 0)+1,selection:intent.selection,
      providerID:allowance.providerID,modelID:allowance.modelID,price:allowance.price,
      inputTokenCeiling:intent.inputTokenCeiling,outputTokenCeiling:intent.outputTokenCeiling,
      exposure:expectedExposure,state:"reserved"};
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
/** Exactly one dispatch flag per attempt. Cannot itself intercept SDK subcalls. */
export async function beginInferenceDispatch(storage: DurableObjectStorage,grant:StartGrant,
  intent:InferenceIntent,policy:BudgetPolicy,preflight:PaidPreflight) {
  requireValue(paidPreflight({...preflight,now:Date.now()}).decision === "GO", "PAID_PREFLIGHT_STOP");
  const snap=policySnapshot(policy);
  return storage.transaction(async tx=>{
    await assertT03(tx,grant,intent);
    const global=await readGlobal(tx,snap);
    requireValue(!global.paymentBlocked,"PAYMENT_BLOCKED");
    const row=await tx.get<Row>(CALL(intent.requestId,intent.callId));
    requireValue(row && row.attemptId===intent.attemptId,"INFERENCE_RESERVATION_MISSING");
    if(row.state!=="reserved")return {proceed:false,state:row.state};
    row.state="sent";
    await tx.put(CALL(intent.requestId,intent.callId),row);
    return {proceed:true,state:"sent" as const};
  });
}
export async function markInferenceUnknown(storage:DurableObjectStorage,intent:InferenceIntent,reason:string) {
  requireValue(reason.length>0 && reason.length<128,"INVALID_UNKNOWN_REASON");
  return storage.transaction(async tx=>{
    const key=CALL(intent.requestId,intent.callId),row=await tx.get<Row>(key);
    requireValue(row && row.attemptId===intent.attemptId,"INFERENCE_ATTEMPT_MISMATCH");
    if(row.state==="unknown")return {reused:true};
    requireValue(row.state==="sent","INFERENCE_NOT_SENT");
    const global=await tx.get<Global>(GLOBAL),task=await tx.get<Counter>(TASK(intent.requestId));
    requireValue(global && task,"INFERENCE_LEDGER_MISSING");
    adjust(global,{reserved:-row.exposure,unknown:row.exposure});
    adjust(task,{reserved:-row.exposure,unknown:row.exposure});
    row.state="unknown";row.reason=reason;
    await tx.put(key,row);await tx.put(GLOBAL,global);await tx.put(TASK(intent.requestId),task);
    return {reused:false};
  });
}
/** Proof is required from a private trusted adapter; HTTP status alone is not proof. */
export async function rejectInferenceBeforeGeneration(storage:DurableObjectStorage,intent:InferenceIntent,
  receipt:{origin:"trusted-provider-adapter"; beforeGeneration:true; code:"429"|"3040"|"402"}) {
  requireValue(receipt.origin==="trusted-provider-adapter" && receipt.beforeGeneration===true &&
    ["429","3040","402"].includes(receipt.code),"PREGEN_PROOF_REQUIRED");
  return storage.transaction(async tx=>{
    const key=CALL(intent.requestId,intent.callId),row=await tx.get<Row>(key);
    requireValue(row && row.attemptId===intent.attemptId,"INFERENCE_ATTEMPT_MISMATCH");
    if(row.state==="rejected"&&row.reason===receipt.code)return {reused:true};
    requireValue(row.state==="sent","UNKNOWN_EFFECT_MUST_NOT_RELEASE");
    const global=await tx.get<Global>(GLOBAL),task=await tx.get<Counter>(TASK(intent.requestId));
    requireValue(global && task,"INFERENCE_LEDGER_MISSING");
    adjust(global,{reserved:-row.exposure});adjust(task,{reserved:-row.exposure});
    if(receipt.code==="402")global.paymentBlocked=true;
    row.state="rejected";row.reason=receipt.code;
    await tx.put(key,row);await tx.put(GLOBAL,global);await tx.put(TASK(intent.requestId),task);
    return {reused:false};
  });
}
/** Rated cost is NOT an invoice; late receipts may settle an unknown even after slot reclaim. */
export async function settleInference(storage:DurableObjectStorage,intent:InferenceIntent,
  receipt:{origin:"trusted-provider-adapter"; receiptId:string; inputTokens:number; outputTokens:number}) {
  requireValue(receipt.origin==="trusted-provider-adapter" && CALL_ID.test(receipt.receiptId) &&
    int(receipt.inputTokens,0,TOKENS_LIMIT) && int(receipt.outputTokens,0,TOKENS_LIMIT),"USAGE_RECEIPT_REQUIRED");
  return storage.transaction(async tx=>{
    const key=CALL(intent.requestId,intent.callId),row=await tx.get<Row>(key);
    requireValue(row && row.attemptId===intent.attemptId,"INFERENCE_ATTEMPT_MISMATCH");
    if(row.state==="settled") {
      requireValue(row.receiptId===receipt.receiptId && row.inputTokens===receipt.inputTokens &&
        row.outputTokens===receipt.outputTokens,"DUPLICATE_SETTLEMENT_CONFLICT");
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
    const bucket=row.state==="unknown"?"unknown":"reserved";
    adjust(global,{[bucket]:-row.exposure,confirmed:charged});
    adjust(task,{[bucket]:-row.exposure,confirmed:charged});
    row.state="settled";row.receiptId=receipt.receiptId;row.inputTokens=receipt.inputTokens;
    row.outputTokens=receipt.outputTokens;row.charge=charged;
    await tx.put(key,row);await tx.put(receiptKey,key);await tx.put(GLOBAL,global);
    await tx.put(TASK(intent.requestId),task);
    return {reused:false,chargedMicroUsd:charged};
  });
}
export async function inferenceBudgetTotals(storage:Pick<DurableObjectStorage,"get">) {
  const global=await storage.get<Global>(GLOBAL);
  return global ? {confirmed:global.confirmed,reserved:global.reserved,unknown:global.unknown,
    exposureMicroUsd:total(global),paymentBlocked:global.paymentBlocked} : null;
}
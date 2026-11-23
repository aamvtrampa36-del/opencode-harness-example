/**
 * F0-C10/PREFLIGHT-02: candidate local worst-case expense reservation.
 *
 * SCOPE: a single, separately provisioned, disposable Durable Object owner.
 * This is NOT an external/provider-enforced hard cutoff and DOES NOT create
 * a global cost maximum across other DOs, Workers, Accounts or SDK routes.
 * Until a trusted adapter intercepts every real route, dispatch remains STOP.
 *
 * No network, API calls, account mutations, billing rules or inference here.
 */
import { armDisposableExternalEffectInTransaction,
  verifyDisposableLeaseInTransaction, type PreflightLeaseGrant
} from "./preflight-exclusive-lease";

export const COST_KINDS = ["workers_ai","openrouter","workers",
  "durable_objects","containers","github_actions"] as const;
export type ExpenseKind = typeof COST_KINDS[number];
/** Owner-approved ceiling for ALL attributable F0-C10 experiment costs.
 * 2026-11-23 approval: USD 2.00 = 2,000,000 microUSD. This is an
 * authorization ceiling, NOT a measured balance or provider hard stop.
 * No per-service allocation or provider dispatch is authorized here.
 */
export const F0_C10_APPROVED_MAX_MICRO_USD = 2_000_000 as const;
export const F0_C10_APPROVED_CURRENCY = "USD" as const;
export type DisposableCostPolicy = {
  scopeHash:string; policyRevision:string;
  /** Operator-selected ceiling within approved US$2 global maximum.
   * No implicit per-service allocations; units: microUSD (1e6 = US$1).
   * This local ledger does not count costs outside this one DO. */
  totalMicroUsd:number;
  maxByServiceMicroUsd:Record<ExpenseKind,number>;
};
type Reservation = {kind:ExpenseKind;operationId:string;maxMicroUsd:number;
  ownerGeneration:number;state:"reserved"|"unknown"|"cancelled"};
type Row = {version:1; policySnapshot:string;
  totalMicroUsd:number;maxByServiceMicroUsd:Record<ExpenseKind,number>;
  exposureMicroUsd:number;byServiceMicroUsd:Record<ExpenseKind,number>};
const LEDGER="preflight:cost:ledger:v1";
const KEY=(id:string)=>"preflight:cost:op:"+id;
const MAX=1_000_000_000_000;
const HEX64=/^[a-f0-9]{64}$/;
const OP=/^[a-z][a-z0-9_-]{0,63}$/;
const REV=/^[a-z][a-z0-9._-]{0,63}$/;
const isInt=(n:unknown,min:number,max:number):n is number =>
  typeof n==="number" && Number.isSafeInteger(n) && n>=min && n<=max;
function requireValid(ok:unknown,label:string):asserts ok {
  if(!ok)throw Error(label);
}
function cleanPolicy(p:DisposableCostPolicy):{snapshot:string;policy:DisposableCostPolicy}{
  requireValid(p && HEX64.test(p.scopeHash) && REV.test(p.policyRevision) &&
    isInt(p.totalMicroUsd,1,MAX),"COST_EXPLICIT_USD_CAP_REQUIRED");
  requireValid(p.totalMicroUsd<=F0_C10_APPROVED_MAX_MICRO_USD,
    "COST_APPROVED_USD2_CEILING_EXCEEDED");
  const caps=Object.create(null) as Record<ExpenseKind,number>;
  requireValid(p.maxByServiceMicroUsd &&
    Object.keys(p.maxByServiceMicroUsd).length===COST_KINDS.length,
    "COST_ALL_SIX_CATEGORIES_REQUIRED");
  for(const kind of COST_KINDS){
    const n=p.maxByServiceMicroUsd[kind];
    requireValid(isInt(n,1,p.totalMicroUsd),"COST_SERVICE_CEILING_INVALID");
    caps[kind]=n;
  }
  const policy={scopeHash:p.scopeHash,policyRevision:p.policyRevision,
    totalMicroUsd:p.totalMicroUsd,maxByServiceMicroUsd:caps};
  return {snapshot:JSON.stringify(policy),policy};
}
function decode(raw:unknown):Row {
  const r=raw as Row;
  requireValid(r && r.version===1 && typeof r.policySnapshot==="string" &&
    isInt(r.totalMicroUsd,1,F0_C10_APPROVED_MAX_MICRO_USD) &&
    isInt(r.exposureMicroUsd,0,r.totalMicroUsd),
    "COST_LEDGER_CORRUPT");
  for(const kind of COST_KINDS){
    requireValid(isInt(r.maxByServiceMicroUsd?.[kind],1,r.totalMicroUsd) &&
      isInt(r.byServiceMicroUsd?.[kind],0,r.maxByServiceMicroUsd[kind]),
      "COST_LEDGER_CORRUPT");
  }
  return r;
}
async function getLedger(tx:Pick<DurableObjectStorage,"get">,policy:DisposableCostPolicy):Promise<Row>{
  const parsed=cleanPolicy(policy);
  const found=await tx.get<Row>(LEDGER);
  requireValid(found,"COST_BUDGET_NOT_INITIALIZED");
  const ledger=decode(found);
  requireValid(ledger.policySnapshot===parsed.snapshot,
    "COST_POLICY_IMMUTABLE");
  return ledger;
}
function zeros():Record<ExpenseKind,number>{
  return Object.fromEntries(COST_KINDS.map(k=>[k,0])) as Record<ExpenseKind,number>;
}
/** Requires same single-owner lease and durable transaction.
 * Cannot be called with a cap if operator hasn't selected a numeric USD max.
 * Callers must not claim this method configured ANY Cloudflare billing policy.
 */
export async function initializeDisposableBudget(storage:DurableObjectStorage,
  grant:PreflightLeaseGrant,policy:DisposableCostPolicy,now:number) {
  const parsed=cleanPolicy(policy);
  requireValid(policy.scopeHash===grant.scopeHash,"COST_SCOPE_MISMATCH");
  return storage.transaction(async tx=>{
    await verifyDisposableLeaseInTransaction(tx,grant,now);
    const prior=await tx.get<Row>(LEDGER);
    if(prior){
      requireValid(decode(prior).policySnapshot===parsed.snapshot,
        "COST_POLICY_IMMUTABLE");
      return {status:"existing" as const,providerCutoffProven:false as const};
    }
    await tx.put(LEDGER,{version:1,policySnapshot:parsed.snapshot,
      totalMicroUsd:policy.totalMicroUsd,
      maxByServiceMicroUsd:parsed.policy.maxByServiceMicroUsd,
      exposureMicroUsd:0,byServiceMicroUsd:zeros()} as Row);
    return {status:"initialized" as const,providerCutoffProven:false as const};
  });
}

export async function reserveDisposableExpense(storage:DurableObjectStorage,
  grant:PreflightLeaseGrant,policy:DisposableCostPolicy,
  intent:{operationId:string;kind:ExpenseKind;maxMicroUsd:number},now:number) {
  requireValid(OP.test(intent.operationId) && COST_KINDS.includes(intent.kind) &&
    isInt(intent.maxMicroUsd,1,F0_C10_APPROVED_MAX_MICRO_USD),
    "COST_INTENT_INVALID");
  return storage.transaction(async tx=>{
    await verifyDisposableLeaseInTransaction(tx,grant,now);
    const ledger=await getLedger(tx,policy);
    const key=KEY(intent.operationId),existing=await tx.get<Reservation>(key);
    if(existing){
      requireValid(existing.kind===intent.kind &&
        existing.maxMicroUsd===intent.maxMicroUsd &&
        existing.ownerGeneration===grant.generation,
        "COST_IDEMPOTENCY_CONFLICT");
      requireValid(existing.state!=="cancelled",
        "COST_CANCELLED_ATTEMPT_CANNOT_RETRY");
      return {kind:"reused" as const,state:existing.state,
        mayDispatch:false};
    }
    requireValid(ledger.exposureMicroUsd+intent.maxMicroUsd<=ledger.totalMicroUsd &&
      ledger.byServiceMicroUsd[intent.kind]+intent.maxMicroUsd<=
      ledger.maxByServiceMicroUsd[intent.kind],
      "COST_BUDGET_EXHAUSTED");
    ledger.exposureMicroUsd+=intent.maxMicroUsd;
    ledger.byServiceMicroUsd[intent.kind]+=intent.maxMicroUsd;
    await tx.put(key,{...intent,ownerGeneration:grant.generation,
      state:"reserved"} as Reservation);
    await tx.put(LEDGER,ledger);
    return {kind:"reserved" as const,mayDispatch:false,
      exposureMicroUsd:ledger.exposureMicroUsd};
  });
}

/** One atomic DO transaction: verify expense + fence + write-ahead UNKNOWN.
 * First caller obtains a candidate dispatch permit; duplicate gets false.
 * This is only a *local* allowance, never upstream financial authorization.
 */
export async function armReservedDisposableExpense(storage:DurableObjectStorage,
  grant:PreflightLeaseGrant,policy:DisposableCostPolicy,operationId:string,
  now:number):Promise<{firstArmed:boolean;providerDispatchAuthorized:false;state:"unknown"}> {
  requireValid(OP.test(operationId),"COST_INTENT_INVALID");
  return storage.transaction(async tx=>{
    const ledger=await getLedger(tx,policy);
    const key=KEY(operationId);
    const row=await tx.get<Reservation>(key);
    requireValid(row && row.ownerGeneration===grant.generation,
      "COST_RESERVATION_MISSING");
    requireValid(row.state==="reserved" || row.state==="unknown",
      "COST_RESERVATION_NOT_DISPATCHABLE");
    const v=await armDisposableExternalEffectInTransaction(tx,grant,operationId,now);
    if(v.mayDispatch) {
      requireValid(row.state==="reserved","COST_MULTIPLE_DISPATCH");
      row.state="unknown";
      await tx.put(key,row);
    } else {
      requireValid(row.state==="unknown","COST_JOURNAL_DISAGREEMENT");
    }
    return {firstArmed:v.mayDispatch,providerDispatchAuthorized:false as const,state:"unknown" as const};
  });
}

/** Clear only an UNSENT reservation while owner lease is still active.
 * After dispatch ambiguity, never release cost by timeout/false HTTP 429.
 */
export async function cancelUnsentDisposableExpense(storage:DurableObjectStorage,
  grant:PreflightLeaseGrant,policy:DisposableCostPolicy,
  operationId:string,now:number) {
  requireValid(OP.test(operationId),"COST_INTENT_INVALID");
  return storage.transaction(async tx=>{
    await verifyDisposableLeaseInTransaction(tx,grant,now);
    const ledger=await getLedger(tx,policy);
    const key=KEY(operationId);
    const row=await tx.get<Reservation>(key);
    requireValid(row && row.ownerGeneration===grant.generation,
      "COST_RESERVATION_MISSING");
    if(row.state==="cancelled") return {reused:true};
    requireValid(row.state==="reserved",
      "COST_UNKNOWN_MUST_NOT_RELEASE");
    row.state="cancelled";
    ledger.exposureMicroUsd-=row.maxMicroUsd;
    ledger.byServiceMicroUsd[row.kind]-=row.maxMicroUsd;
    await tx.put(key,row);await tx.put(LEDGER,ledger);
    return {reused:false};
  });
}

/** Readback only. Zero budget exposure does not imply any live provider is cut off. */
export async function inspectDisposableBudget(storage:Pick<DurableObjectStorage,"get">){
  const row=await storage.get<Row>(LEDGER);
  if(!row)return null;
  const r=decode(row);
  return {totalMicroUsd:r.totalMicroUsd,
    exposureMicroUsd:r.exposureMicroUsd,
    byServiceMicroUsd:r.byServiceMicroUsd,
    providerCutoffProven:false as const,goAuthorized:false as const};
}

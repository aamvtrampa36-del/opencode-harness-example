/**
 * F0-C10/PREFLIGHT-02 — Candidate dedicated-disposable DO lease contract.
 *
 * NOT WIRED to staging, T03 admissions or the SDK. An offline transaction
 * proof is not a real exclusive reservation across accounts, DOs or agents.
 * Do not route a native effect through this helper until an authenticated
 * server-only owner and an isolated Durable Object namespace are verified.
 *
 * No TTL-based reclaim: after a lost response the original sender may still
 * execute. Quarantine is deliberately sticky until a separately authenticated
 * native quiescence protocol exists; none is provided here.
 */
export type PreflightLeaseGrant = Readonly<{
  scopeHash: string; owner: string; claimId: string;
  token: string; generation: number; expiresAt: number;
}>;
export type LeaseClaim =
  | { kind: "granted" | "reused"; grant: PreflightLeaseGrant }
  | { kind: "blocked"; reason: "LEASE_HELD" | "LEASE_EXPIRED_UNFENCED" | "EXTERNAL_EFFECT_UNKNOWN" };
type LeaseState = "held" | "effect_unknown" | "released";
type Row = { version: 1; scopeHash: string; owner: string; claimId: string;
  token: string; generation: number; expiresAt: number; lastAt: number;
  state: LeaseState; attemptedEffectId?: string };
type Scope = { version: 1; scopeHash: string };
const PREFIX = "preflight:isolated-scope:v1";
const LEASE = "preflight:lease:v1";
const HEX64 = /^[a-f0-9]{64}$/;
const HEX16 = /^[a-f0-9]{16}$/;
const EFFECT = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const LIMIT_MS = 60_000;

function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new Error(name);
}
function isClock(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}
function validateGrant(g: PreflightLeaseGrant) {
  check(g && HEX64.test(g.scopeHash) && HEX16.test(g.owner) &&
    HEX16.test(g.claimId) && UUID.test(g.token) &&
    Number.isSafeInteger(g.generation) && g.generation > 0 &&
    isClock(g.expiresAt), "PREFLIGHT_LEASE_GRANT_INVALID");
}
function decodeRow(raw: unknown): Row {
  const r=raw as Row;
  check(r && r.version===1 && HEX64.test(r.scopeHash) &&
    HEX16.test(r.owner) && HEX16.test(r.claimId) && UUID.test(r.token) &&
    Number.isSafeInteger(r.generation) && r.generation>0 &&
    isClock(r.expiresAt) && isClock(r.lastAt) &&
    ["held","effect_unknown","released"].includes(r.state) &&
    (r.state==="effect_unknown" ? typeof r.attemptedEffectId==="string" &&
      EFFECT.test(r.attemptedEffectId) : r.attemptedEffectId===undefined),
    "PREFLIGHT_LEASE_LEDGER_CORRUPT");
  return r;
}
function verifyScope(scope: Scope | undefined, hash: string) {
  check(scope && scope.version===1 && scope.scopeHash===hash,
    "PREFLIGHT_SCOPE_NOT_INITIALIZED_OR_MISMATCHED");
}
function current(row: Row, g: PreflightLeaseGrant) {
  validateGrant(g);
  check(row.scopeHash===g.scopeHash && row.token===g.token &&
    row.owner===g.owner && row.claimId===g.claimId &&
    row.generation===g.generation && row.expiresAt>=g.expiresAt,
    "PREFLIGHT_LEASE_STALE_FENCE");
}
function clock(now: number, row?: Row) {
  check(isClock(now) && (!row || now>=row.lastAt),
    "PREFLIGHT_LEASE_CLOCK_INVALID");
}

/** Strictly local candidate: unrecognized or nonempty DO storage is refused.
 * An empty DO is NOT proof of physical isolation; that requires a real namespace
 * manifest and ownership check outside this helper. No destructive cleanup.
 */
export async function initializeDisposableLease(storage: DurableObjectStorage,
  scopeHash: string): Promise<{scopeHash: string; status: "initialized" | "existing";
    isolationProven: false}> {
  check(HEX64.test(scopeHash), "PREFLIGHT_SCOPE_HASH_INVALID");
  return storage.transaction(async tx=>{
    const existing=await tx.get<Scope>(PREFIX);
    if (existing) {
      verifyScope(existing,scopeHash);
      return {scopeHash,status:"existing" as const,isolationProven:false as const};
    }
    const others=await tx.list({limit:2});
    check(others.size===0,"PREFLIGHT_NONEMPTY_STORAGE");
    await tx.put(PREFIX,{version:1,scopeHash});
    return {scopeHash,status:"initialized" as const,isolationProven:false as const};
  });
}

/** A single lease per dedicated DO. No writes to the project's T03 ledger. */
export async function claimDisposableLease(storage: DurableObjectStorage,args:{
  scopeHash:string; owner:string; claimId:string; now:number; ttlMs:number
}): Promise<LeaseClaim> {
  check(HEX64.test(args.scopeHash) && HEX16.test(args.owner) &&
    HEX16.test(args.claimId) && isClock(args.now) &&
    Number.isSafeInteger(args.ttlMs) && args.ttlMs>=1_000 &&
    args.ttlMs<=LIMIT_MS && args.now+args.ttlMs<=Number.MAX_SAFE_INTEGER,
    "PREFLIGHT_CLAIM_INVALID");
  return storage.transaction(async tx=>{
    verifyScope(await tx.get<Scope>(PREFIX),args.scopeHash);
    const previous=await tx.get<Row>(LEASE);
    let generation=1;
    if(previous){
      const row=decodeRow(previous);
      check(row.scopeHash===args.scopeHash,"PREFLIGHT_SCOPE_MISMATCH");
      clock(args.now,row);
      if(row.state==="effect_unknown")
        return {kind:"blocked" as const,reason:"EXTERNAL_EFFECT_UNKNOWN" as const};
      if(row.state==="held"){
        if(args.now>=row.expiresAt)
          return {kind:"blocked" as const,reason:"LEASE_EXPIRED_UNFENCED" as const};
        if(row.owner===args.owner && row.claimId===args.claimId)
          return {kind:"reused" as const,grant:toGrant(row)};
        return {kind:"blocked" as const,reason:"LEASE_HELD" as const};
      }
      generation=row.generation+1;
      check(Number.isSafeInteger(generation),"PREFLIGHT_LEASE_GENERATION_OVERFLOW");
    }
    const row:Row={version:1,scopeHash:args.scopeHash,owner:args.owner,
      claimId:args.claimId,token:crypto.randomUUID(),generation,
      lastAt:args.now,expiresAt:args.now+args.ttlMs,state:"held"};
    await tx.put(LEASE,row);
    return {kind:"granted" as const,grant:toGrant(row)};
  });
}
function toGrant(row: Row): PreflightLeaseGrant {
  return {scopeHash:row.scopeHash,owner:row.owner,claimId:row.claimId,
    token:row.token,generation:row.generation,expiresAt:row.expiresAt};
}

/** Owner heartbeat; expiration never transfers ownership. */
export async function renewDisposableLease(storage: DurableObjectStorage,
  grant:PreflightLeaseGrant,now:number,ttlMs:number):Promise<PreflightLeaseGrant> {
  validateGrant(grant);
  check(Number.isSafeInteger(ttlMs) && ttlMs>=1_000 && ttlMs<=LIMIT_MS &&
    isClock(now) && now+ttlMs<=Number.MAX_SAFE_INTEGER,"PREFLIGHT_RENEW_INVALID");
  return storage.transaction(async tx=>{
    verifyScope(await tx.get<Scope>(PREFIX),grant.scopeHash);
    const row=decodeRow(await tx.get(LEASE));
    current(row,grant);clock(now,row);
    check(row.state==="held" && now<row.expiresAt,
      "PREFLIGHT_LEASE_NOT_ACTIVE");
    row.lastAt=now;row.expiresAt=now+ttlMs;
    await tx.put(LEASE,row);return toGrant(row);
  });
}

/**
 * For the future trusted cost adapter: validate lease ownership INSIDE the
 * same Durable Object transaction as an expense reservation. This is not an
 * external authorization token and cannot attest physical isolation.
 */
export async function verifyDisposableLeaseInTransaction(
  tx: Pick<DurableObjectStorage,"get">,grant:PreflightLeaseGrant,now:number
):Promise<void> {
  validateGrant(grant);
  verifyScope(await tx.get<Scope>(PREFIX),grant.scopeHash);
  const row=decodeRow(await tx.get<Row>(LEASE));
  current(row,grant);clock(now,row);
  check(row.state==="held" && now<row.expiresAt,
    "PREFLIGHT_LEASE_NOT_ACTIVE");
}

/** MUST be committed before a native external call. First attempt only.
 * A duplicate requestId/effectId is never a second permission to dispatch.
 */
export async function armDisposableExternalEffect(storage:DurableObjectStorage,
  grant:PreflightLeaseGrant,effectId:string,now:number):
  Promise<{mayDispatch:boolean;state:"effect_unknown"}> {
  validateGrant(grant);
  check(EFFECT.test(effectId),"PREFLIGHT_EFFECT_ID_INVALID");
  return storage.transaction(async tx=>{
    verifyScope(await tx.get<Scope>(PREFIX),grant.scopeHash);
    const row=decodeRow(await tx.get(LEASE));
    current(row,grant);clock(now,row);
    if(row.state==="effect_unknown"){
      check(row.attemptedEffectId===effectId,
        "PREFLIGHT_DIFFERENT_EFFECT_IN_QUARANTINE");
      return {mayDispatch:false,state:"effect_unknown" as const};
    }
    check(row.state==="held" && now<row.expiresAt,
      "PREFLIGHT_LEASE_NOT_ACTIVE");
    row.state="effect_unknown";row.attemptedEffectId=effectId;row.lastAt=now;
    await tx.put(LEASE,row);
    return {mayDispatch:true,state:"effect_unknown" as const};
  });
}

/** No effect may be in flight when relinquishing a lease. A terminal string,
 * timeout or absence of an RPC response is never a quiescence certificate.
 */
export async function releaseUnusedDisposableLease(storage:DurableObjectStorage,
  grant:PreflightLeaseGrant,now:number):Promise<{released:true;generation:number}> {
  validateGrant(grant);
  return storage.transaction(async tx=>{
    verifyScope(await tx.get<Scope>(PREFIX),grant.scopeHash);
    const row=decodeRow(await tx.get(LEASE));
    current(row,grant);clock(now,row);
    check(row.state==="held" && now<row.expiresAt,
      "PREFLIGHT_NOT_QUIESCENT");
    row.state="released";row.lastAt=now;
    await tx.put(LEASE,row);
    return {released:true as const,generation:row.generation};
  });
}

/** No token in output and never a GO. Snapshot is per DO, not global. */
export async function inspectDisposableLease(storage:DurableObjectStorage):Promise<
  {scopeHash:string;generation:number;state:LeaseState;
   expiresAt:number;ownerRecorded:boolean;isolationProven:false} | null> {
  const row=await storage.get<Row>(LEASE);
  if(!row)return null;
  const r=decodeRow(row);
  return {scopeHash:r.scopeHash,generation:r.generation,state:r.state,
    expiresAt:r.expiresAt,ownerRecorded:Boolean(r.owner),
    isolationProven:false};
}

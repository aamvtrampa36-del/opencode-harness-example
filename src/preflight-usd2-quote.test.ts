import {describe,expect,test} from "bun:test";
import {F0_C10_GLOBAL_APPROVED_MICRO_USD, COST_KINDS,
  initializeDisposableBudget, reserveDisposableExpense, inspectDisposableBudget,
  type ExpenseKind} from "./preflight-disposable-cost";
import {initializeDisposableLease,claimDisposableLease,
  type PreflightLeaseGrant} from "./preflight-exclusive-lease";
import {F0_C10_USD2_APPROVAL,ADDITIONAL_COST_KINDS,
  buildUsd2DisposableShadowPolicy,evaluateUsd2ShadowQuote,
  type ShadowUsd2Quote} from "./preflight-usd2-quote";

/** Local transactional model, never a live Cloudflare DO or spending policy. */
class FakeDO {
  private rows=new Map<string,unknown>();
  private queue:Promise<void>=Promise.resolve();
  async get<T>(key:string):Promise<T|undefined>{
    const v=this.rows.get(key);return v===undefined?undefined:structuredClone(v) as T;
  }
  async put<T>(key:string,value:T){this.rows.set(key,structuredClone(value));}
  async list<T>(opts:{prefix?:string;limit?:number}={}):Promise<Map<string,T>>{
    return new Map([...this.rows].filter(([k])=>k.startsWith(opts.prefix??""))
      .slice(0,opts.limit??Infinity).map(([k,v])=>[k,structuredClone(v) as T]));
  }
  async transaction<T>(fn:(tx:FakeDO)=>Promise<T>){
    const previous=this.queue;let release!:()=>void;
    this.queue=new Promise<void>(r=>release=r);await previous;
    const staged=new FakeDO();staged.rows=new Map(structuredClone([...this.rows]));
    try{const result=await fn(staged);this.rows=staged.rows;return result;}
    finally{release();}
  }
  asDO(){return this as unknown as DurableObjectStorage;}
}
const scope="a".repeat(64);
const empty=():ShadowUsd2Quote=>({
  currency:"USD",plannedControlDOs:1,source:"synthetic-fixture",
  perServiceWorstCaseMicroUsd:{
    workers_ai:0,openrouter:0,workers:0,
    durable_objects:0,containers:0,github_actions:0
  },
  additionalWorstCaseMicroUsd:{
    storage:0,egress:0,observability:0,unclassified:0
  }
});
const setup=async()=>{
  const db=new FakeDO();await initializeDisposableLease(db.asDO(),scope);
  const x=await claimDisposableLease(db.asDO(),{
    scopeHash:scope,owner:"1".repeat(16),claimId:"2".repeat(16),now:1000,ttlMs:5000});
  if(x.kind==="blocked")throw Error("FIXTURE_NO_GRANT");
  const grant=x.grant as PreflightLeaseGrant;
  const policy=buildUsd2DisposableShadowPolicy(scope,"usd2_20261123");
  await initializeDisposableBudget(db.asDO(),grant,policy,1100);
  return {db,grant,policy};
};
describe("F0-C10/PREFLIGHT-03 global US$2 ceiling, synthetic ONLY",()=>{
  test("budget is precisely 2.00 USD total and authorizes no spend",()=>{
    expect(F0_C10_GLOBAL_APPROVED_MICRO_USD).toBe(2_000_000);
    expect(F0_C10_USD2_APPROVAL).toMatchObject({
      totalUsd:"2.00",currency:"USD",totalMicroUsd:2_000_000,
      spendOrDeployAuthorized:false,proofOfProviderHardCutoff:false
    });
    const p=buildUsd2DisposableShadowPolicy(scope,"usd2_20261123");
    expect(p.totalMicroUsd).toBe(2_000_000);
    expect(COST_KINDS).toHaveLength(6);
    expect(ADDITIONAL_COST_KINDS).toHaveLength(4);
    expect(COST_KINDS.every(k=>p.maxByServiceMicroUsd[k]===2_000_000)).toBe(true);
    // These six maxima share ONE common ledger, never six grants of US$2.
  });
  test("an old caller cannot silently initialize US$2 plus one microUSD",async()=>{
    const db=new FakeDO();await initializeDisposableLease(db.asDO(),scope);
    const x=await claimDisposableLease(db.asDO(),{
      scopeHash:scope,owner:"1".repeat(16),claimId:"2".repeat(16),now:1000,ttlMs:5000});
    if(x.kind==="blocked")throw Error("FIXTURE_GRANT");
    const raised=buildUsd2DisposableShadowPolicy(scope,"usd2_20261123");
    raised.totalMicroUsd=2_000_001;
    await expect(initializeDisposableBudget(db.asDO(),x.grant,raised,1100))
      .rejects.toThrow("COST_EXPLICIT_USD_CAP_REQUIRED_OR_OVER_USD2");
  });
  test("all six categories share one exact upper bound and seventh charge fails",async()=>{
    const {db,grant,policy}=await setup();
    const a=await reserveDisposableExpense(db.asDO(),grant,policy,{
      operationId:"workers_ai_1",kind:"workers_ai",maxMicroUsd:1_500_000},1200);
    expect(a.kind).toBe("reserved");
    const b=await reserveDisposableExpense(db.asDO(),grant,policy,{
      operationId:"container_1",kind:"containers",maxMicroUsd:500_000},1300);
    expect(b.kind).toBe("reserved");
    expect((await inspectDisposableBudget(db.asDO()))?.exposureMicroUsd).toBe(2_000_000);
    await expect(reserveDisposableExpense(db.asDO(),grant,policy,{
      operationId:"tiny_overage",kind:"workers",maxMicroUsd:1},1400))
      .rejects.toThrow("COST_BUDGET_EXHAUSTED");
    expect((await inspectDisposableBudget(db.asDO()))?.goAuthorized).toBe(false);
  });
  test("ten simultaneous attempts cannot reserve ten US$0.30 portions under US$2",async()=>{
    const {db,grant,policy}=await setup();
    const claims=await Promise.allSettled(Array.from({length:10},(_,i)=>
      reserveDisposableExpense(db.asDO(),grant,policy,{
        operationId:"attempt_"+i,kind:"workers_ai",maxMicroUsd:300_000},1200)));
    expect(claims.filter(x=>x.status==="fulfilled")).toHaveLength(6);
    expect(claims.filter(x=>x.status==="rejected")).toHaveLength(4);
    expect((await inspectDisposableBudget(db.asDO()))?.exposureMicroUsd).toBe(1_800_000);
  });
  test("a synthetic quote of $2 exactly returns STOP, not GO",()=>{
    const q=empty();q.perServiceWorstCaseMicroUsd.workers_ai=1_300_000;
    q.perServiceWorstCaseMicroUsd.containers=500_000;
    q.additionalWorstCaseMicroUsd.storage=200_000;
    expect(evaluateUsd2ShadowQuote(q)).toMatchObject({
      decision:"STOP",shadowStatus:"WITHIN_USD2_UNVERIFIED",
      totalWorstCaseMicroUsd:2_000_000,providerDispatchAuthorized:false,
      providerHardCutoffVerified:false,operationalLeaseVerified:false
    });
  });
  test("unknown indirect costs, including storage or logs, cannot be priced as zero",()=>{
    const q=empty();q.additionalWorstCaseMicroUsd.observability=null;
    expect(evaluateUsd2ShadowQuote(q)).toMatchObject({
      decision:"STOP",shadowStatus:"UNQUOTED",totalWorstCaseMicroUsd:null
    });
  });
  test("a budget quote of USD2.000001, even in extra costs, fails offline",()=>{
    const q=empty();q.perServiceWorstCaseMicroUsd.openrouter=2_000_000;
    q.additionalWorstCaseMicroUsd.egress=1;
    expect(evaluateUsd2ShadowQuote(q)).toMatchObject({
      shadowStatus:"EXCEEDS_USD2",decision:"STOP",totalWorstCaseMicroUsd:2_000_001
    });
  });
  test("two independent DO ledgers cannot be certified as one $2 budget",()=>{
    const q=empty();q.plannedControlDOs=2;
    expect(evaluateUsd2ShadowQuote(q)).toMatchObject({
      decision:"STOP",shadowStatus:"MULTI_LEDGER_BYPASS",
      totalWorstCaseMicroUsd:null
    });
  });
  test("six separate caps are NOT an exemption from combined ceiling",()=>{
    const q=empty();for(const k of COST_KINDS)q.perServiceWorstCaseMicroUsd[k]=350_000;
    expect(evaluateUsd2ShadowQuote(q)).toMatchObject({
      decision:"STOP",shadowStatus:"EXCEEDS_USD2",totalWorstCaseMicroUsd:2_100_000
    });
  });
  test("invalid currency, forged category, negative/fractional values fail closed",()=>{
    const q=empty();
    expect(()=>evaluateUsd2ShadowQuote({...q,currency:"BRL" as "USD"}))
      .toThrow("USD2_QUOTE_INVALID");
    expect(()=>evaluateUsd2ShadowQuote({
      ...q,perServiceWorstCaseMicroUsd:{...q.perServiceWorstCaseMicroUsd,unknown_provider:0}
    })).toThrow("USD2_QUOTE_INVALID");
    for(const invalid of [-1,NaN,0.01,Number.MAX_SAFE_INTEGER+1]){
      const v=empty();v.additionalWorstCaseMicroUsd.unclassified=invalid;
      expect(()=>evaluateUsd2ShadowQuote(v)).toThrow("USD2_QUOTE_AMOUNT_INVALID");
    }
    expect(()=>buildUsd2DisposableShadowPolicy("b","usd2_20261123"))
      .toThrow("USD2_SHADOW_SCOPE_INVALID");
  });
  test("manually forged audit flags never become a live authorization",()=>{
    const q=empty();
    const forged={...q,hardCutoffVerified:true,exclusiveLiveLease:true,approvedByProvider:true};
    const d=evaluateUsd2ShadowQuote(forged);
    expect(d.decision).toBe("STOP");
    expect(d.providerDispatchAuthorized).toBe(false);
    expect(d.operationalLeaseVerified).toBe(false);
  });
});

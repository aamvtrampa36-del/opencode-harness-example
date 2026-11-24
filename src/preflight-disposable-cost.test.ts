import {describe,expect,test} from "bun:test";
import {initializeDisposableLease,claimDisposableLease,
  releaseUnusedDisposableLease,type PreflightLeaseGrant} from "./preflight-exclusive-lease";
import {COST_KINDS,initializeDisposableBudget,reserveDisposableExpense,
  armReservedDisposableExpense,cancelUnsentDisposableExpense,
  inspectDisposableBudget,F0_C10_GLOBAL_APPROVED_MICRO_USD,type ExpenseKind,type DisposableCostPolicy
} from "./preflight-disposable-cost";

class FakeDO {
  private rows=new Map<string,unknown>();
  private queue:Promise<void>=Promise.resolve();
  async get<T>(key:string){const v=this.rows.get(key);return v===undefined?undefined:structuredClone(v) as T;}
  async put<T>(key:string,value:T){this.rows.set(key,structuredClone(value));}
  async list<T>(o:{limit?:number;prefix?:string}={}):Promise<Map<string,T>>{
    return new Map([...this.rows].filter(([k])=>k.startsWith(o.prefix??""))
      .slice(0,o.limit??Infinity).map(([k,v])=>[k,structuredClone(v) as T]));
  }
  async transaction<T>(fn:(tx:FakeDO)=>Promise<T>){
    const prior=this.queue;let done!:()=>void;
    this.queue=new Promise<void>(r=>done=r);await prior;
    const stage=new FakeDO();stage.rows=new Map(structuredClone([...this.rows]));
    try{const res=await fn(stage);this.rows=stage.rows;return res;}
    finally{done();}
  }
  asDO(){return this as unknown as DurableObjectStorage;}
  restart(){const copy=new FakeDO();copy.rows=new Map(structuredClone([...this.rows]));return copy;}
}
const scope="a".repeat(64);
const policy=():DisposableCostPolicy=>({
  scopeHash:scope,policyRevision:"fixture1",totalMicroUsd:5000,
  maxByServiceMicroUsd:{
    workers_ai:5000,openrouter:1000,workers:1000,
    durable_objects:1000,containers:1000,github_actions:1000
  }
});
const make=async()=>{
  const db=new FakeDO();await initializeDisposableLease(db.asDO(),scope);
  const receipt=await claimDisposableLease(db.asDO(),{
    scopeHash:scope,owner:"1".repeat(16),claimId:"2".repeat(16),now:1000,ttlMs:5000});
  if(receipt.kind==="blocked")throw Error("FIXTURE_NO_LEASE");
  return {db,g:receipt.grant as PreflightLeaseGrant};
};
const reserve=async(db:FakeDO,g:PreflightLeaseGrant,operationId:string,maxMicroUsd=1500,now=1200,
  kind:ExpenseKind="workers_ai")=>
  reserveDisposableExpense(db.asDO(),g,policy(),{operationId,kind,maxMicroUsd},now);

describe("F0-C10/PREFLIGHT-02 fenced expense ceiling (OFFLINE; not provider cutoff)",()=>{
  test("a numeric USD cap and all six service categories are required",async()=>{
    const {db,g}=await make();
    await expect(initializeDisposableBudget(db.asDO(),g,
      {...policy(),totalMicroUsd:0},1100))
      .rejects.toThrow("COST_EXPLICIT_USD_CAP_REQUIRED");
    const broken=policy();delete (broken.maxByServiceMicroUsd as Record<string,number>).containers;
    await expect(initializeDisposableBudget(db.asDO(),g,broken,1100))
      .rejects.toThrow("COST_ALL_SIX_CATEGORIES_REQUIRED");
    expect(await initializeDisposableBudget(db.asDO(),g,policy(),1100))
      .toEqual({status:"initialized",providerCutoffProven:false});
    expect(await initializeDisposableBudget(db.asDO(),g,policy(),1110))
      .toMatchObject({status:"existing",providerCutoffProven:false});
  });
  test("ten concurrent reservations cannot exceed one fixed total, including unknown liability",async()=>{
    const {db,g}=await make();
    await initializeDisposableBudget(db.asDO(),g,policy(),1100);
    const claims=await Promise.allSettled(Array.from({length:10},(_,i)=>
      reserve(db,g,"charge_"+i)));
    expect(claims.filter(x=>x.status==="fulfilled")).toHaveLength(3);
    expect(claims.filter(x=>x.status==="rejected")).toHaveLength(7);
    expect(claims.filter(x=>x.status==="rejected").every(x=>
      String((x as PromiseRejectedResult).reason).includes("COST_BUDGET_EXHAUSTED"))).toBe(true);
    expect(await inspectDisposableBudget(db.asDO())).toMatchObject({
      totalMicroUsd:5000,exposureMicroUsd:4500,providerCutoffProven:false,goAuthorized:false
    });
  });
  test("hundred retries cannot mint a second local reservation or dispatch",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,policy(),1100);
    const receipts=await Promise.all(Array.from({length:100},()=>reserve(db,g,"native_submit")));
    expect(receipts.filter(x=>x.kind==="reserved")).toHaveLength(1);
    expect(receipts.filter(x=>x.kind==="reused")).toHaveLength(99);
    const arms=await Promise.all(Array.from({length:100},()=>
      armReservedDisposableExpense(db.asDO(),g,policy(),"native_submit",1300)));
    expect(arms.filter(x=>x.firstArmed)).toHaveLength(1);
    expect(arms.every(x=>x.providerDispatchAuthorized===false)).toBe(true);
    expect(arms.filter(x=>!x.firstArmed)).toHaveLength(99);
    expect(await inspectDisposableBudget(db.asDO()))
      .toMatchObject({exposureMicroUsd:1500,goAuthorized:false});
  });
  test("lost response and DO restart cannot free or resend a paid unknown",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,policy(),1100);
    await reserve(db,g,"inference");
    expect((await armReservedDisposableExpense(db.asDO(),g,policy(),"inference",1300)).firstArmed)
      .toBe(true);
    const restored=db.restart();
    const duplicate=await armReservedDisposableExpense(restored.asDO(),g,policy(),"inference",1400);
    expect(duplicate).toEqual({firstArmed:false,providerDispatchAuthorized:false,state:"unknown"});
    await expect(cancelUnsentDisposableExpense(restored.asDO(),g,policy(),"inference",1500))
      .rejects.toThrow("PREFLIGHT_LEASE_NOT_ACTIVE");
    await expect(reserve(restored,g,"other_charge",1000,1600))
      .rejects.toThrow("PREFLIGHT_LEASE_NOT_ACTIVE");
    expect(await inspectDisposableBudget(restored.asDO()))
      .toMatchObject({exposureMicroUsd:1500,providerCutoffProven:false});
  });
  test("only an unsent reservation can be cancelled and free quota",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,policy(),1100);
    await reserve(db,g,"unused",1000,1200,"containers");
    expect(await cancelUnsentDisposableExpense(db.asDO(),g,policy(),"unused",1300))
      .toEqual({reused:false});
    expect(await cancelUnsentDisposableExpense(db.asDO(),g,policy(),"unused",1310))
      .toEqual({reused:true});
    await expect(reserve(db,g,"unused",1000,1320,"containers"))
      .rejects.toThrow("COST_CANCELLED_ATTEMPT_CANNOT_RETRY");
    expect(await inspectDisposableBudget(db.asDO()))
      .toMatchObject({exposureMicroUsd:0});
    expect((await reserve(db,g,"different",1000,1330,"containers")).kind).toBe("reserved");
  });
  test("cannot raise budget or change pricing policy without rebuilding the isolated scope",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,policy(),1100);
    const raised=policy();raised.totalMicroUsd=6000;
    await expect(initializeDisposableBudget(db.asDO(),g,raised,1200))
      .rejects.toThrow("COST_POLICY_IMMUTABLE");
    const retagged=policy();retagged.policyRevision="newprice";
    await expect(reserveDisposableExpense(db.asDO(),g,retagged,
      {operationId:"native",kind:"workers_ai",maxMicroUsd:1500},1200))
      .rejects.toThrow("COST_POLICY_IMMUTABLE");
  });
  test("stale owner and released fence cannot incur new expense",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,policy(),1100);
    await releaseUnusedDisposableLease(db.asDO(),g,1200);
    await expect(reserve(db,g,"stale",1500,1300))
      .rejects.toThrow("PREFLIGHT_LEASE_NOT_ACTIVE");
    const newer=await claimDisposableLease(db.asDO(),{
      scopeHash:scope,owner:"3".repeat(16),claimId:"4".repeat(16),now:1400,ttlMs:5000});
    if(newer.kind==="blocked")throw Error("FIXTURE_SECOND_GRANT_FAILED");
    await expect(reserve(db,g,"replayed",1500,1500))
      .rejects.toThrow("PREFLIGHT_LEASE_STALE_FENCE");
    const latest=await reserve(db,newer.grant,"new_owner",1500,1500);
    expect(latest.kind).toBe("reserved");
  });
  test("a forged operation cannot bypass per-service ceiling or missing reservation",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,policy(),1100);
    await expect(reserve(db,g,"too_big",1500,1200,"containers"))
      .rejects.toThrow("COST_BUDGET_EXHAUSTED");
    await expect(armReservedDisposableExpense(db.asDO(),g,policy(),"missing",1250))
      .rejects.toThrow("COST_RESERVATION_MISSING");
    await reserve(db,g,"known",500);
    await expect(reserve(db,g,"known",550))
      .rejects.toThrow("COST_IDEMPOTENCY_CONFLICT");
    expect(await inspectDisposableBudget(db.asDO()))
      .toMatchObject({exposureMicroUsd:500,goAuthorized:false});
  });
  test("provider cutoff remains unproven even if all local tests pass",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,policy(),1100);
    await reserve(db,g,"native",1000);
    const receipt=await armReservedDisposableExpense(db.asDO(),g,policy(),"native",1300);
    expect(receipt).toEqual({firstArmed:true,providerDispatchAuthorized:false,state:"unknown"});
    const snap=await inspectDisposableBudget(db.asDO());
    expect(snap?.providerCutoffProven).toBe(false);
    expect(snap?.goAuthorized).toBe(false);
  });
});


describe("F0-C10/PREFLIGHT-03 — US$2 is a ceiling, never a promise of paid runtime",()=>{
  const usd2=():DisposableCostPolicy=>({
    scopeHash:scope,policyRevision:"fixture-usd2",
    totalMicroUsd:F0_C10_GLOBAL_APPROVED_MICRO_USD,
    // Test-only service maxima; there is NO operator-approved allocation.
    // A SINGLE DO must still enforce the aggregate ceiling.
    maxByServiceMicroUsd:{
      workers_ai:2_000_000,openrouter:2_000_000,workers:2_000_000,
      durable_objects:2_000_000,containers:2_000_000,github_actions:2_000_000
    }
  });
  test("exact ceiling US$2 is valid; US$2.000001 is rejected before any ledger write",async()=>{
    expect(F0_C10_GLOBAL_APPROVED_MICRO_USD).toBe(2_000_000);
    const {db,g}=await make();
    const raised=usd2();raised.totalMicroUsd=2_000_001;
    await expect(initializeDisposableBudget(db.asDO(),g,raised,1100))
      .rejects.toThrow("COST_EXPLICIT_USD_CAP_REQUIRED_OR_OVER_USD2");
    expect(await inspectDisposableBudget(db.asDO())).toBeNull();
    expect(await initializeDisposableBudget(db.asDO(),g,usd2(),1100))
      .toMatchObject({status:"initialized",providerCutoffProven:false});
  });
  test("six service categories share US$2 total; US$0.01 overrun denied",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,usd2(),1100);
    const costs=[
      {kind:"workers_ai" as const,operationId:"ai",maxMicroUsd:900_000},
      {kind:"openrouter" as const,operationId:"router",maxMicroUsd:400_000},
      {kind:"workers" as const,operationId:"worker",maxMicroUsd:250_000},
      {kind:"durable_objects" as const,operationId:"do",maxMicroUsd:150_000},
      {kind:"containers" as const,operationId:"container",maxMicroUsd:200_000},
      {kind:"github_actions" as const,operationId:"ci",maxMicroUsd:100_000},
    ];
    // Synthetic costs sum to US$2.00. Not a proposed service allocation.
    const receipts=await Promise.all(costs.map(intent=>
      reserveDisposableExpense(db.asDO(),g,usd2(),intent,1200)));
    expect(receipts.every(x=>x.kind==="reserved")).toBe(true);
    await expect(reserveDisposableExpense(db.asDO(),g,usd2(),
      {kind:"workers_ai",operationId:"cent_over",maxMicroUsd:10_000},1300))
      .rejects.toThrow("COST_BUDGET_EXHAUSTED");
    expect(await inspectDisposableBudget(db.asDO())).toMatchObject({
      totalMicroUsd:2_000_000,exposureMicroUsd:2_000_000,
      providerCutoffProven:false,goAuthorized:false
    });
  });
  test("failed or ambiguous receipts cannot free cost, extend cap, or unlock provider",async()=>{
    const {db,g}=await make();await initializeDisposableBudget(db.asDO(),g,usd2(),1100);
    await reserveDisposableExpense(db.asDO(),g,usd2(),
      {kind:"workers_ai",operationId:"native_unknown",maxMicroUsd:2_000_000},1200);
    const first=await armReservedDisposableExpense(db.asDO(),g,usd2(),"native_unknown",1300);
    expect(first).toEqual({firstArmed:true,providerDispatchAuthorized:false,state:"unknown"});
    const restarted=db.restart();
    expect(await armReservedDisposableExpense(restarted.asDO(),g,usd2(),
      "native_unknown",1400)).toEqual({firstArmed:false,providerDispatchAuthorized:false,state:"unknown"});
    await expect(cancelUnsentDisposableExpense(restarted.asDO(),g,usd2(),
      "native_unknown",1500)).rejects.toThrow();
    const increased=usd2();increased.totalMicroUsd=2_000_001;
    await expect(initializeDisposableBudget(restarted.asDO(),g,increased,1600))
      .rejects.toThrow("COST_EXPLICIT_USD_CAP_REQUIRED_OR_OVER_USD2");
    expect(await inspectDisposableBudget(restarted.asDO()))
      .toMatchObject({exposureMicroUsd:2_000_000,providerCutoffProven:false,goAuthorized:false});
  });
  test("different DO owners are NOT a common account ledger: illustrative RED design counterexample",async()=>{
    const one=await make(),two=await make();
    await initializeDisposableBudget(one.db.asDO(),one.g,usd2(),1100);
    await initializeDisposableBudget(two.db.asDO(),two.g,usd2(),1100);
    for(const x of [one,two])await reserveDisposableExpense(x.db.asDO(),x.g,usd2(),
      {kind:"workers_ai",operationId:"isolated",maxMicroUsd:2_000_000},1200);
    const a=await inspectDisposableBudget(one.db.asDO());
    const b=await inspectDisposableBudget(two.db.asDO());
    expect(a!.exposureMicroUsd+b!.exposureMicroUsd).toBe(4_000_000);
    // This proves why a per-DO limit cannot be called a real global hard cutoff.
    expect(a!.goAuthorized||b!.goAuthorized).toBe(false);
  });
});

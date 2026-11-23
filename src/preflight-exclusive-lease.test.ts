import {describe,expect,test} from "bun:test";
import {claimDisposableLease,initializeDisposableLease,renewDisposableLease,
  armDisposableExternalEffect,releaseUnusedDisposableLease,inspectDisposableLease,
  type PreflightLeaseGrant} from "./preflight-exclusive-lease";

/** Serialized, rollback-aware transaction simulator; not a real workerd DO. */
class FakeDO {
  private rows=new Map<string,unknown>();
  private tail:Promise<void>=Promise.resolve();
  async get<T>(key:string):Promise<T|undefined>{
    const value=this.rows.get(key);
    return value===undefined?undefined:structuredClone(value) as T;
  }
  async put<T>(key:string,value:T){this.rows.set(key,structuredClone(value));}
  async list<T>(opts:{limit?:number;prefix?:string}={}):Promise<Map<string,T>>{
    return new Map([...this.rows].filter(([k])=>k.startsWith(opts.prefix??""))
      .slice(0,opts.limit??Infinity).map(([k,v])=>[k,structuredClone(v) as T]));
  }
  async transaction<T>(fn:(tx:FakeDO)=>Promise<T>):Promise<T>{
    const prev=this.tail;let done!:()=>void;
    this.tail=new Promise<void>(r=>done=r);await prev;
    const draft=new FakeDO();draft.rows=new Map(structuredClone([...this.rows]));
    try{const res=await fn(draft);this.rows=draft.rows;return res;}finally{done();}
  }
  asDO(){return this as unknown as DurableObjectStorage;}
  snapshot(){return structuredClone([...this.rows]);}
  restart(){const copy=new FakeDO();copy.rows=new Map(this.snapshot());return copy;}
}
const scope="a".repeat(64),owner="1".repeat(16),actor="2".repeat(16);
const claim="3".repeat(16),second="4".repeat(16);
const init=async(db:FakeDO)=>initializeDisposableLease(db.asDO(),scope);
const acquire=async(db:FakeDO,o=owner,c=claim,now=1000)=>
  claimDisposableLease(db.asDO(),{scopeHash:scope,owner:o,claimId:c,now,ttlMs:5000});
function asGrant(result:Awaited<ReturnType<typeof acquire>>):PreflightLeaseGrant {
  if(result.kind==="blocked")throw Error("expected grant");
  return result.grant;
}
describe("F0-C10/PREFLIGHT-02 exclusive isolated DO lease (OFFLINE only)",()=>{
  test("bootstrap refuses any pre-existing project rows or different namespace",async()=>{
    const db=new FakeDO();
    await db.put("supervisor:task:legacy",{status:"running"});
    await expect(init(db)).rejects.toThrow("PREFLIGHT_NONEMPTY_STORAGE");
    expect(await db.get("preflight:isolated-scope:v1")).toBeUndefined();
    const fresh=new FakeDO();
    expect(await init(fresh)).toEqual({scopeHash:scope,status:"initialized",isolationProven:false});
    expect(await init(fresh)).toMatchObject({status:"existing"});
    await expect(initializeDisposableLease(fresh.asDO(),"b".repeat(64)))
      .rejects.toThrow("PREFLIGHT_SCOPE_NOT_INITIALIZED_OR_MISMATCHED");
  });
  test("ten competing claims serialize into exactly one holder, no phantom effects",async()=>{
    const db=new FakeDO();await init(db);
    const all=await Promise.all(Array.from({length:10},(_,i)=>
      acquire(db,i.toString(16).padStart(16,"0"),i.toString(16).padStart(16,"a"))));
    expect(all.filter(x=>x.kind==="granted")).toHaveLength(1);
    expect(all.filter(x=>x.kind==="blocked")).toHaveLength(9);
    expect(all.filter(x=>x.kind==="blocked").every(x=>x.reason==="LEASE_HELD")).toBe(true);
    expect((await inspectDisposableLease(db.asDO()))?.state).toBe("held");
  });
  test("idempotent claim and owner heartbeat preserve token/fence until explicit release",async()=>{
    const db=new FakeDO();await init(db);
    const a=asGrant(await acquire(db));
    const replay=asGrant(await acquire(db,owner,claim,1100));
    expect(replay.token).toBe(a.token);
    expect(replay.generation).toBe(1);
    const renewed=await renewDisposableLease(db.asDO(),a,1200,5000);
    expect(renewed.expiresAt).toBe(6200);
    expect(renewed.token).toBe(a.token);
    expect((await acquire(db,actor,second,1300)).kind).toBe("blocked");
    expect(await releaseUnusedDisposableLease(db.asDO(),renewed,1400))
      .toMatchObject({released:true,generation:1});
    const b=asGrant(await acquire(db,actor,second,1500));
    expect(b.generation).toBe(2);
    expect(b.token).not.toBe(a.token);
    await expect(releaseUnusedDisposableLease(db.asDO(),a,1600))
      .rejects.toThrow("PREFLIGHT_LEASE_STALE_FENCE");
  });
  test("loss of arm-response never grants duplicate dispatch or TTL takeover",async()=>{
    const db=new FakeDO();await init(db);const a=asGrant(await acquire(db));
    expect(await armDisposableExternalEffect(db.asDO(),a,"native_submit",1200))
      .toEqual({mayDispatch:true,state:"effect_unknown"});
    const restarted=db.restart();
    expect(await armDisposableExternalEffect(restarted.asDO(),a,"native_submit",1300))
      .toEqual({mayDispatch:false,state:"effect_unknown"});
    expect(await acquire(restarted,actor,second,10_000))
      .toEqual({kind:"blocked",reason:"EXTERNAL_EFFECT_UNKNOWN"});
    await expect(releaseUnusedDisposableLease(restarted.asDO(),a,1400))
      .rejects.toThrow("PREFLIGHT_NOT_QUIESCENT");
    await expect(renewDisposableLease(restarted.asDO(),a,1400,5000))
      .rejects.toThrow("PREFLIGHT_LEASE_NOT_ACTIVE");
    expect(await inspectDisposableLease(restarted.asDO()))
      .toMatchObject({generation:1,state:"effect_unknown",isolationProven:false});
  });
  test("expiry without a signed quiescence receipt is sticky (no TTL reclaim)",async()=>{
    const db=new FakeDO();await init(db);const a=asGrant(await acquire(db));
    expect(await acquire(db,actor,second,7000))
      .toEqual({kind:"blocked",reason:"LEASE_EXPIRED_UNFENCED"});
    expect(await acquire(db,owner,claim,7000))
      .toEqual({kind:"blocked",reason:"LEASE_EXPIRED_UNFENCED"});
    await expect(armDisposableExternalEffect(db.asDO(),a,"native_submit",7000))
      .rejects.toThrow("PREFLIGHT_LEASE_NOT_ACTIVE");
    await expect(releaseUnusedDisposableLease(db.asDO(),a,7000))
      .rejects.toThrow("PREFLIGHT_NOT_QUIESCENT");
  });
  test("two operations cannot both arm with one grant even within validity window",async()=>{
    const db=new FakeDO();await init(db);const a=asGrant(await acquire(db));
    const receipts=await Promise.all(Array.from({length:10},()=>armDisposableExternalEffect(db.asDO(),a,"native_submit",1200)));
    expect(receipts.filter(x=>x.mayDispatch)).toHaveLength(1);
    await expect(armDisposableExternalEffect(db.asDO(),a,"native_other",1250))
      .rejects.toThrow("PREFLIGHT_DIFFERENT_EFFECT_IN_QUARANTINE");
  });
  test("a bad generation, wrong scope, forged token, and backwards clock never mutate ledger",async()=>{
    const db=new FakeDO();await init(db);const a=asGrant(await acquire(db));
    for(const bad of [
      {...a,generation:2},{...a,scopeHash:"b".repeat(64)},
      {...a,token:"00000000-0000-4000-8000-000000000000"}
    ]) await expect(armDisposableExternalEffect(db.asDO(),bad,"native_submit",1100))
      .rejects.toThrow(/PREFLIGHT_/);
    await expect(renewDisposableLease(db.asDO(),a,999,5000))
      .rejects.toThrow("PREFLIGHT_LEASE_CLOCK_INVALID");
    expect((await inspectDisposableLease(db.asDO()))?.state).toBe("held");
  });
  test("lease ledger exposes no capability token to an unprivileged inspect",async()=>{
    const db=new FakeDO();await init(db);const a=asGrant(await acquire(db));
    const status=await inspectDisposableLease(db.asDO());
    expect(JSON.stringify(status)).not.toContain(a.token);
    expect(status).toMatchObject({isolationProven:false,ownerRecorded:true,generation:1});
  });
  test("rollback of failed storage transaction leaves no partial lease",async()=>{
    const db=new FakeDO();await init(db);
    await expect(db.transaction(async tx=>{await tx.put("preflight:lease:v1",{test:true});throw Error("SIMULATED_ABORT");}))
      .rejects.toThrow("SIMULATED_ABORT");
    expect(await db.get("preflight:lease:v1")).toBeUndefined();
    expect((await acquire(db)).kind).toBe("granted");
  });
});

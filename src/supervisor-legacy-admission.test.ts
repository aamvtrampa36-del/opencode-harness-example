import { describe, expect, test } from "bun:test";
import {
  reserveSupervisorAdmission, reserveSupervisorContinuation,
  supervisorBeginExternalEffect, supervisorAdmissionSlot
} from "./supervisor-admission";
import type { SupervisorTask } from "./supervisor-control";

/** Deliberately synthetic DO transaction double (no Cloudflare data or SDK). */
class MemoryDO {
  private rows = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.rows.get(key);
    return v === undefined ? undefined : structuredClone(v) as T;
  }
  async put<T>(key: string, value: T): Promise<void> { this.rows.set(key, structuredClone(value)); }
  async list<T>(opts: {prefix?: string; limit?: number} = {}): Promise<Map<string,T>> {
    const entries = [...this.rows.entries()].filter(([key])=>key.startsWith(opts.prefix ?? ""))
      .sort(([a],[b]) => a.localeCompare(b)).slice(0, opts.limit ?? Infinity)
      .map(([key,value])=>[key,structuredClone(value)] as [string,T]);
    return new Map(entries);
  }
  async transaction<T>(callback: (tx: MemoryDO) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let resolve!: () => void;
    this.tail = new Promise<void>(r=>{resolve=r;});
    await prior;
    const shadow = new MemoryDO();
    shadow.rows = new Map(structuredClone([...this.rows]));
    try { const v = await callback(shadow); this.rows = shadow.rows; return v; }
    finally { resolve(); }
  }
  asDO(): DurableObjectStorage { return this as unknown as DurableObjectStorage; }
}
const id = (n:number) => n.toString(16).padStart(16,"0");
const task = (n:number, status:SupervisorTask["status"]="preparing",
              managed=true):SupervisorTask=>({
  id:id(n), fingerprint:"f".repeat(64),createdAt:1,
  repository:"aamvtrampa36-del/opencode-harness-example",
  project:"supervised-"+id(n),branch:"opencode/staging-"+id(n),
  status,sessionCreationAttempted:false,
  ...(managed ? {sessionIdPolicy:"deterministic-v1" as const}:{}),
  ...(status!=="preparing" ? {session:"ses_legacy_"+id(n),
    operationId:"rc-start-"+id(n)}:{}),
  revision:0
});
const admit=(db:MemoryDO,n:number,now=1_000)=>
  reserveSupervisorAdmission(db.asDO(),task(n),now);

describe("F0-C10/R3-T03 legacy admission RED → GREEN (offline)",()=>{
  test("legacy RUNNING without slot must stop new start rather than count as zero",async()=>{
    const db=new MemoryDO();
    await db.put("supervisor:task:"+id(90),task(90,"running",false));
    expect(await admit(db,1)).toMatchObject({kind:"capacity",reason:"LEGACY_UNGOVERNED"});
    expect(await db.get("supervisor:task:"+id(1))).toBeUndefined();
  });
  test("nine reserved plus one unmanaged legacy must NOT grant a tenth managed slot",async()=>{
    const db=new MemoryDO();
    for(let n=1;n<=9;n++) expect((await admit(db,n)).kind).toBe("granted");
    await db.put("supervisor:task:"+id(90),task(90,"unknown",false));
    expect(await admit(db,10)).toMatchObject({kind:"capacity",reason:"LEGACY_UNGOVERNED"});
  });
  test("managed running without slot is inconsistent and must STOP",async()=>{
    const db=new MemoryDO();
    await db.put("supervisor:task:"+id(90),task(90,"running",true));
    expect(await admit(db,1)).toMatchObject({kind:"capacity",reason:"UNTRACKED_MANAGED_TASK"});
  });
  test("legacy continue without slot cannot submit another native turn",async()=>{
    const db=new MemoryDO();
    const old=task(90,"running",false);
    await db.put("supervisor:task:"+id(90),old);
    await expect(reserveSupervisorContinuation(db.asDO(),id(90),id(7),
      "a".repeat(64),"rc-turn-"+id(90)+"-"+id(7),1_000))
      .rejects.toThrow("SUPERVISOR_LEGACY_QUARANTINED");
    expect(await db.get("supervisor:turn:"+id(90)+":"+id(7))).toBeUndefined();
  });
  test("an expired effect_unknown remains occupied even after an old legacy is discovered",async()=>{
    const db=new MemoryDO();
    const first=await admit(db,1);
    if(first.kind!=="granted")throw Error("fixture");
    await supervisorBeginExternalEffect(db.asDO(),first.grant,"submit",1_001);
    await db.put("supervisor:task:"+id(90),task(90,"running",false));
    const unchanged=await admit(db,1,1_000_000);
    expect(unchanged).toMatchObject({kind:"reused",reason:"EFFECT_UNCONFIRMED"});
    expect((await supervisorAdmissionSlot(db.asDO(),id(1)))?.phase).toBe("effect_unknown");
  });
});

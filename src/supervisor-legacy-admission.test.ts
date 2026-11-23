import { describe, expect, test } from "bun:test";
import {
  reserveSupervisorAdmission, reserveSupervisorContinuation,
  supervisorBeginExternalEffect, supervisorConfirmExternalEffect,
  supervisorAdmissionSlot, inspectSupervisorAdmissionCapacity
} from "./supervisor-admission";
import { requireMeteredDiagnosticAdmission } from "./supervisor-legacy-capacity";
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

  test("status distinguishes 10 slots from unmeasured native operations",async()=>{
    const db=new MemoryDO();
    for(let n=1;n<=10;n++) expect((await admit(db,n)).kind).toBe("granted");
    const x=await inspectSupervisorAdmissionCapacity(db.asDO());
    expect(x).toMatchObject({activeSlots:10,capacity:10,
      possibleLegacyExecutions:0,inventoryComplete:true,stopReason:null,
      activeNativeOperations:null,nativeOperationsMeasured:false});
    expect(await admit(db,11)).toMatchObject({kind:"capacity",reason:"CAPACITY_EXHAUSTED"});
  });
  test("101 historical tasks exceed the bounded inventory: explicit STOP",async()=>{
    const db=new MemoryDO();
    for(let n=100;n<=200;n++) await db.put("supervisor:task:"+id(n),
      {...task(n,"cancelled",false),sessionCreationAttempted:false,
        session:undefined,operationId:undefined});
    expect((await inspectSupervisorAdmissionCapacity(db.asDO())).stopReason)
      .toBe("LEGACY_INVENTORY_INCOMPLETE");
    expect(await admit(db,1)).toMatchObject({kind:"capacity",
      reason:"LEGACY_INVENTORY_INCOMPLETE"});
  });
  test("staging diagnostic and G8/G9 retained state require explicit reconciliation",async()=>{
    for(const key of ["agent-check-v1","agent-check-openrouter-bun-v1",
                      "g8-live-agent-v1","g9-native-e2e-v2"]){
      const db=new MemoryDO();
      await db.put(key,{status:"running",session:"ses_unmetered"});
      expect(await admit(db,1)).toMatchObject({kind:"capacity",
        reason:"AUXILIARY_UNGOVERNED"});
    }
    expect(()=>requireMeteredDiagnosticAdmission(true))
      .toThrow("SUPERVISOR_UNMETERED_DIAGNOSTIC_DISABLED");
    expect(()=>requireMeteredDiagnosticAdmission(false)).not.toThrow();
  });
  test("terminal reclaim competing with a new start admits only one replacement",async()=>{
    const db=new MemoryDO();
    for(let n=1;n<=10;n++)expect((await admit(db,n)).kind).toBe("granted");
    const slot=await supervisorAdmissionSlot(db.asDO(),id(1));
    if(!slot)throw Error("fixture");
    const grant={id:id(1),token:slot.token,generation:slot.generation};
    await supervisorBeginExternalEffect(db.asDO(),grant,"submit",1001);
    await supervisorConfirmExternalEffect(db.asDO(),grant,"submit",{confirmed:true},1002);
    await db.put("supervisor:task:"+id(1),{
      ...task(1,"finished"),session:"ses_r2_"+id(1),operationId:"rc-start-"+id(1)
    });
    const t=id(70),op="rc-turn-"+id(1)+"-"+t;
    const [newStart,readmission]=await Promise.all([
      admit(db,11,1100),
      reserveSupervisorContinuation(db.asDO(),id(1),t,"c".repeat(64),op,1100)
    ]);
    const admitted=Number(newStart.kind==="granted")+Number(readmission.kind==="submit");
    expect(admitted).toBe(1);
    expect(newStart.kind==="capacity" || readmission.kind==="capacity").toBe(true);
    const after=await inspectSupervisorAdmissionCapacity(db.asDO());
    expect(after.activeSlots).toBe(10);
    expect(after.stopReason).toBeNull();
  });
  test("a cancel racing an unsettled turn never frees or resubmits that turn",async()=>{
    const db=new MemoryDO();const first=await admit(db,1);
    if(first.kind!=="granted")throw Error("fixture");
    await supervisorBeginExternalEffect(db.asDO(),first.grant,"submit",1001);
    await supervisorConfirmExternalEffect(db.asDO(),first.grant,"submit",{confirmed:true},1002);
    await db.put("supervisor:task:"+id(1),{
      ...task(1,"running"),session:"ses_r2_"+id(1),
      operationId:"rc-start-"+id(1)
    });
    const turn=id(21),op="rc-turn-"+id(1)+"-"+turn;
    expect((await reserveSupervisorContinuation(db.asDO(),id(1),turn,
      "a".repeat(64),op,1005)).kind).toBe("submit");
    const active=await db.get<SupervisorTask>("supervisor:task:"+id(1));
    await db.put("supervisor:task:"+id(1),{
      ...active!,status:"cancel_requested",cancelAmbiguous:true
    });
    expect((await reserveSupervisorContinuation(db.asDO(),id(1),turn,
      "a".repeat(64),op,999999)).kind).toBe("existing");
    await expect(reserveSupervisorContinuation(db.asDO(),id(1),id(22),
      "b".repeat(64),"rc-turn-"+id(1)+"-"+id(22),999999))
      .rejects.toThrow("SUPERVISOR_TURN_DENIED_TERMINAL_OR_CANCEL");
    expect((await supervisorAdmissionSlot(db.asDO(),id(1)))?.effect).toBe("turn_submit");
  });

  test("cached legacy finished is not native proof; known pre-create cancellation is exempt",async()=>{
    const unknownTerminal=new MemoryDO();
    await unknownTerminal.put("supervisor:task:"+id(90),task(90,"finished",false));
    expect(await admit(unknownTerminal,1)).toMatchObject({
      kind:"capacity",reason:"LEGACY_UNGOVERNED"
    });
    const safeNoEffect=new MemoryDO();
    await safeNoEffect.put("supervisor:task:"+id(90),{
      ...task(90,"cancelled",false),session:undefined,operationId:undefined,
      sessionCreationAttempted:false
    });
    expect((await admit(safeNoEffect,1)).kind).toBe("granted");
  });
});

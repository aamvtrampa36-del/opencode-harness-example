import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  reserveSupervisorAdmission, supervisorBeginExternalEffect,
  supervisorConfirmExternalEffect, supervisorAdmissionSlot,
  supervisorAdmissionAllowsContinuation, hasSupervisorAdmissionSlot,
  reconcileSupervisorCreatedSession, supervisorCommitCreatedSession, supervisorGrantStillOwned,
  reserveSupervisorContinuation, recordSupervisorContinuationReceipt,
  reconcileSupervisorTurnEffect
} from "./supervisor-admission";
import {
  r2SessionId, r2TurnAdmission, r2CancelledByReceipt,
  r2StatusWriteAllowed, r2PendingTurnReconcileAllowed, r3IsNativeSessionNotFound
} from "./supervisor-r2";
import { canConfirmSupervisorPreSessionCancellation, type SupervisorTask } from "./supervisor-control";

/** Single-process transaction model. It verifies the shared contract,
 * NOT real Durable Object restart, SDK behavior or production inference. */
class FakeDO {
  private rows = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.rows.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  async put<T>(key: string, value: T): Promise<void> { this.rows.set(key, structuredClone(value)); }
  async list<T>(opts: {prefix?:string;limit?:number} = {}):Promise<Map<string,T>> {
    const entries = [...this.rows.entries()]
      .filter(([key])=>key.startsWith(opts.prefix ?? ""))
      .sort(([a],[b])=>a.localeCompare(b))
      .slice(0,opts.limit ?? Infinity)
      .map(([key,value])=>[key,structuredClone(value)] as [string,T]);
    return new Map(entries);
  }
  async transaction<T>(callback: (tx: FakeDO) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    const staged = new FakeDO();
    staged.rows = new Map(structuredClone([...this.rows]));
    try {
      const answer = await callback(staged);
      this.rows = staged.rows;
      return answer;
    } finally { unlock(); }
  }
  asDO() { return this as unknown as DurableObjectStorage; }
}
const id = (n: number) => n.toString(16).padStart(16, "0");
function makeTask(n: number): SupervisorTask {
  const token = id(n);
  return { id: token, repository: "aamvtrampa36-del/opencode-harness-example",
    project: "supervised-" + token, branch: "opencode/staging-" + token,
    fingerprint: "a".repeat(64), createdAt: 1_000, status: "preparing",
    sessionCreationAttempted: false, sessionIdPolicy: "deterministic-v1", revision: 0 };
}
const grant = async (storage: FakeDO, n: number) => {
  const result = await reserveSupervisorAdmission(storage.asDO(), makeTask(n), 1_100);
  if (result.kind !== "granted") throw Error("EXPECTED_GRANT");
  return result.grant;
};

describe("F0-C10/R2-T11 T03 admission + T04 recovery contract (OFFLINE)", () => {
  test("ten distinct reservations use ten deterministic session identifiers", async () => {
    const db = new FakeDO();
    const permits = await Promise.all(Array.from({length:10},(_,i)=>grant(db,i+1)));
    expect(new Set(permits.map(x=>x.id)).size).toBe(10);
    expect(new Set(permits.map(x=>r2SessionId(x.id))).size).toBe(10);
    expect(await reserveSupervisorAdmission(db.asDO(),makeTask(11),1101))
      .toMatchObject({kind:"capacity",reason:"CAPACITY_EXHAUSTED"});
  });

  test("lost session-create receipt preserves effect_unknown and prevents a second grant", async () => {
    const db = new FakeDO(), g = await grant(db,1);
    await supervisorBeginExternalEffect(db.asDO(),g,"session_create",1101);
    const slot = await supervisorAdmissionSlot(db.asDO(),id(1));
    expect(slot?.effect).toBe("session_create");
    expect(supervisorAdmissionAllowsContinuation(slot)).toBe(false);
    expect(await reserveSupervisorAdmission(db.asDO(),makeTask(1),999_000))
      .toMatchObject({kind:"reused",reason:"EFFECT_UNCONFIRMED"});
    await expect(supervisorBeginExternalEffect(db.asDO(),g,"session_create",999_000))
      .rejects.toThrow("ADMISSION_FENCE_REJECTED");
    expect(r2SessionId(id(1))).toBe("ses_r2_"+id(1));
  });

  test("initial configuration cannot admit a continuation until submit is confirmed", async () => {
    const db = new FakeDO(), g = await grant(db,2);
    expect(supervisorAdmissionAllowsContinuation(await supervisorAdmissionSlot(db.asDO(),id(2)))).toBe(false);
    for (const effect of ["github_branch","session_create","configure"] as const) {
      await supervisorBeginExternalEffect(db.asDO(),g,effect,1101);
      expect(supervisorAdmissionAllowsContinuation(await supervisorAdmissionSlot(db.asDO(),id(2)))).toBe(false);
      await supervisorConfirmExternalEffect(db.asDO(),g,effect,{confirmed:true},1102);
    }
    await supervisorBeginExternalEffect(db.asDO(),g,"submit",1103);
    expect(supervisorAdmissionAllowsContinuation(await supervisorAdmissionSlot(db.asDO(),id(2)))).toBe(false);
    await supervisorConfirmExternalEffect(db.asDO(),g,"submit",{confirmed:true},1104);
    expect(supervisorAdmissionAllowsContinuation(await supervisorAdmissionSlot(db.asDO(),id(2)))).toBe(true);
    expect(supervisorAdmissionAllowsContinuation(undefined)).toBe(false); // legacy STOP
    expect(supervisorAdmissionAllowsContinuation(undefined, true)).toBe(false); // T03 managed slot lost
  });

  test("reclaimed terminal slot cannot reactivate a managed task without capacity", async () => {
    const db = new FakeDO(), g = await grant(db,1);
    for (const effect of ["github_branch","session_create","configure","submit"] as const) {
      await supervisorBeginExternalEffect(db.asDO(),g,effect,1101);
      await supervisorConfirmExternalEffect(db.asDO(),g,effect,{confirmed:true},1102);
    }
    const key = "supervisor:task:"+id(1);
    await db.transaction(async tx => {
      const first = await tx.get<SupervisorTask>(key);
      await tx.put(key, {...first!, status:"finished", session:r2SessionId(id(1))});
    });
    await grant(db,2); // T03 atomically reclaims terminal slot 1
    const oldSlot = await supervisorAdmissionSlot(db.asDO(),id(1));
    expect(oldSlot).toBeUndefined();
    expect(supervisorAdmissionAllowsContinuation(oldSlot,true)).toBe(false);
    expect(supervisorAdmissionAllowsContinuation(oldSlot,false)).toBe(false);
  });

  test("cancellation of a task with active admission slot cannot claim no session effect", async () => {
    const db = new FakeDO();
    await grant(db,3);
    const active = await db.transaction(async tx => hasSupervisorAdmissionSlot(tx as unknown as DurableObjectTransaction,id(3)));
    expect(active).toBe(true);
    expect(canConfirmSupervisorPreSessionCancellation({sessionCreationAttempted:false},active)).toBe(false);
  });

  test("turn admission and cancellation share a task cursor, and stale poll is fenced", () => {
    const operationId="rc-turn-"+id(4)+"-"+id(9);
    const base = { status:"running" as const, operationId, pendingTurn:{turnId:id(9),operationId} };
    expect(r2TurnAdmission(base,operationId)).toBe("retry");
    expect(r2TurnAdmission(base,"rc-turn-"+id(4)+"-"+id(8))).toBe("busy");
    expect(r2StatusWriteAllowed(base,operationId)).toBe(false);
    const cancellation = {...base,status:"cancel_requested" as const,cancelAmbiguous:true};
    expect(r2TurnAdmission(cancellation,operationId)).toBe("denied");
    expect(r2CancelledByReceipt(cancellation,operationId,{status:"unanswered",reason:"interrupted"})).toBe(false);
    expect(r2PendingTurnReconcileAllowed(cancellation,operationId,{status:"done"})).toBe(false);
  });

  test("native not_found never settles a pending turn; exact done is required", () => {
    const operationId="rc-turn-"+id(5)+"-"+id(9);
    const current = {status:"running" as const,operationId,pendingTurn:{turnId:id(9),operationId}};
    expect(r2PendingTurnReconcileAllowed(current,operationId,{status:"unanswered",reason:"not_found"})).toBe(false);
    expect(r2PendingTurnReconcileAllowed(current,operationId,undefined)).toBe(false);
    expect(r2PendingTurnReconcileAllowed(current,operationId,{status:"done"})).toBe(true);
    expect(r2StatusWriteAllowed({...current,pendingTurn:undefined},operationId)).toBe(true);
    expect(r2StatusWriteAllowed({...current,pendingTurn:undefined}, "rc-start-"+id(5))).toBe(false);
  });

  test("server wiring retains T03 fence, T04 journal and T08/T09 boundaries (structural)", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url),"utf8");
    for (const symbol of [
      "reserveSupervisorAdmission", "supervisorBeginExternalEffect",
      "supervisorAdmissionAllowsContinuation", "r2TurnJournalKey",
      "r2PendingTurnReconcileAllowed", "r2CancelledByReceipt",
      "SUPERVISOR_FORK_IDEMPOTENCY_UNSUPPORTED", "this.harness.create({ id: sessionId })",
      "publishSupervisedGithubDraft", "supervisedArtifactCapture"
    ]) expect(source.includes(symbol)).toBe(true);
    expect(source.includes("reserveSupervisorContinuation(")).toBe(true);
    expect(source.includes("reconcileSupervisorCreatedSession(")).toBe(true);
    expect(source.includes("supervisorCommitCreatedSession(")).toBe(true);
    expect(source.includes("reconcileSupervisorTurnEffect(tx, id")).toBe(true);
    const begin = source.indexOf('supervisorBeginExternalEffect(this.ctx.storage, grant, "session_create")');
    const create = source.indexOf("this.harness.create({ id: sessionId })");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(create);
  });
  test("lost session-create reply: positive exact ID transfers fence, stale owner cannot commit", async () => {
    const db = new FakeDO(), first = await grant(db, 21), sid = r2SessionId(id(21));
    await supervisorBeginExternalEffect(db.asDO(), first, "session_create", 1101);
    const key = "supervisor:task:" + id(21);
    await db.transaction(async tx => {
      const task = await tx.get<SupervisorTask>(key);
      await tx.put(key, {...task!, sessionCreationAttempted: true, status:"unknown"});
    });
    const observedSlot = await supervisorAdmissionSlot(db.asDO(),id(21));
    const recovered = await reconcileSupervisorCreatedSession(db.asDO(),id(21),sid,observedSlot!,1102);
    expect(recovered.kind).toBe("recovered");
    if (recovered.kind !== "recovered") return;
    expect(recovered.grant.token).not.toBe(first.token);
    expect(recovered.grant.generation).toBe(first.generation+1);
    expect(recovered.task).toMatchObject({session:sid,status:"preparing"});
    expect(await db.get("supervisor:session:"+sid)).toBe(id(21));
    await expect(supervisorCommitCreatedSession(db.asDO(),first,sid,1103))
      .rejects.toThrow("ADMISSION_FENCE_REJECTED");
    await expect(supervisorBeginExternalEffect(db.asDO(),first,"configure",1104))
      .rejects.toThrow("ADMISSION_FENCE_REJECTED");
    await supervisorBeginExternalEffect(db.asDO(),recovered.grant,"configure",1103);
    expect((await supervisorAdmissionSlot(db.asDO(),id(21)))?.effect).toBe("configure");
    const twice = await reconcileSupervisorCreatedSession(db.asDO(),id(21),sid,observedSlot!,1105);
    expect(twice.kind).toBe("stale");
  });

  test("original creator can commit exactly once under the initial token", async () => {
    const db=new FakeDO(), g=await grant(db,22), sid=r2SessionId(id(22));
    await supervisorBeginExternalEffect(db.asDO(),g,"session_create",1101);
    const key="supervisor:task:"+id(22);
    await db.transaction(async tx=>{
      const task=await tx.get<SupervisorTask>(key);
      await tx.put(key,{...task!,sessionCreationAttempted:true});
    });
    const result=await supervisorCommitCreatedSession(db.asDO(),g,sid,1102);
    expect(result.session).toBe(sid);
    expect((await supervisorAdmissionSlot(db.asDO(),id(22)))?.phase).toBe("reserved");
    await expect(supervisorCommitCreatedSession(db.asDO(),g,sid,1103))
      .rejects.toThrow("ADMISSION_FENCE_REJECTED");
  });

  test("missing marker, wrong session ID and foreign reverse mapping fail closed", async () => {
    const db=new FakeDO(),g=await grant(db,23),sid=r2SessionId(id(23));
    await supervisorBeginExternalEffect(db.asDO(),g,"session_create",1101);
    const slot=(await supervisorAdmissionSlot(db.asDO(),id(23)))!;
    expect((await reconcileSupervisorCreatedSession(db.asDO(),id(23),sid,slot,1102)).kind).toBe("stale");
    await expect(reconcileSupervisorCreatedSession(db.asDO(),id(23),"ses_r2_wrong",slot,1102))
      .rejects.toThrow("SESSION_RECONCILE_ID_MISMATCH");
    const key="supervisor:task:"+id(23);
    await db.transaction(async tx=>{
      const task=await tx.get<SupervisorTask>(key);
      await tx.put(key,{...task!,sessionCreationAttempted:true,status:"unknown"});
      await tx.put("supervisor:session:"+sid,id(99));
    });
    await expect(reconcileSupervisorCreatedSession(db.asDO(),id(23),sid,slot,1103))
      .rejects.toThrow("SESSION_RECONCILE_SCOPE_CONFLICT");
    expect((await supervisorAdmissionSlot(db.asDO(),id(23)))?.phase).toBe("effect_unknown");
  });

  test("one terminal task readmits to one slot with one turn intent", async () => {
    const db=new FakeDO(), g=await grant(db,31);
    await supervisorBeginExternalEffect(db.asDO(),g,"submit",1101);
    await supervisorConfirmExternalEffect(db.asDO(),g,"submit",{confirmed:true},1102);
    const key="supervisor:task:"+id(31),sid=r2SessionId(id(31));
    await db.transaction(async tx=>{
      const task=await tx.get<SupervisorTask>(key);
      await tx.put(key,{...task!,session:sid,status:"finished",
        operationId:"rc-start-"+id(31),revision:3});
    });
    const turnId=id(36),op="rc-turn-"+id(31)+"-"+turnId,hash="b".repeat(64);
    const [a,b]=await Promise.all([
      reserveSupervisorContinuation(db.asDO(),id(31),turnId,hash,op,1103),
      reserveSupervisorContinuation(db.asDO(),id(31),turnId,hash,op,1103)
    ]);
    expect([a.kind,b.kind].sort()).toEqual(["existing","submit"]);
    expect((await supervisorAdmissionSlot(db.asDO(),id(31)))?.effect).toBe("turn_submit");
    const r=await recordSupervisorContinuationReceipt(db.asDO(),id(31),turnId,op,{accepted:true},1104);
    expect(r.pendingTurn?.operationId).toBe(op);
    expect((await supervisorAdmissionSlot(db.asDO(),id(31)))?.phase).toBe("running");
    expect(await reconcileSupervisorTurnEffect(db.asDO(),id(31),op,
      {status:"unanswered",reason:"not_found"})).toBe(false);
    expect(await reconcileSupervisorTurnEffect(db.asDO(),id(31),op,
      {status:"done"})).toBe(false); // slot already acknowledged and running
    await expect(reserveSupervisorContinuation(db.asDO(),id(31),id(37),
      hash,"rc-turn-"+id(31)+"-"+id(37),1105)).rejects.toThrow("SUPERVISOR_TURN_IN_FLIGHT");
  });

  test("readmission refuses overflow after a reclaimed terminal slot is used", async () => {
    const db=new FakeDO();
    const grants=await Promise.all(Array.from({length:10},(_,i)=>grant(db,i+41)));
    for(let i=0;i<10;i++){
      const n=i+41, g=grants[i],sid=r2SessionId(id(n));
      await supervisorBeginExternalEffect(db.asDO(),g,"submit",1101);
      await supervisorConfirmExternalEffect(db.asDO(),g,"submit",{confirmed:true},1102);
      const key="supervisor:task:"+id(n);
      await db.transaction(async tx=>{
        const task=await tx.get<SupervisorTask>(key);
        await tx.put(key,{...task!,session:sid,status:i===0?"finished":"running",
          operationId:"rc-start-"+id(n),revision:2});
      });
    }
    await grant(db,55); // reclaims completed #41 and occupies the tenth slot
    const op="rc-turn-"+id(41)+"-"+id(63);
    const answer=await reserveSupervisorContinuation(db.asDO(),id(41),id(63),"c".repeat(64),op,1111);
    expect(answer).toMatchObject({kind:"capacity",reason:"CAPACITY_EXHAUSTED"});
    expect(await db.get("supervisor:turn:"+id(41)+":"+id(63))).toBeUndefined();
    expect((await supervisorAdmissionSlot(db.asDO(),id(41)))).toBeUndefined();
  });

  test("lost continuation receipt keeps unknown slot and never submits again", async () => {
    const db=new FakeDO(),g=await grant(db,71),sid=r2SessionId(id(71));
    await supervisorBeginExternalEffect(db.asDO(),g,"submit",1101);
    await supervisorConfirmExternalEffect(db.asDO(),g,"submit",{confirmed:true},1102);
    await db.transaction(async tx=>{
      const key="supervisor:task:"+id(71),task=await tx.get<SupervisorTask>(key);
      await tx.put(key,{...task!,session:sid,status:"finished",operationId:"rc-start-"+id(71),revision:2});
    });
    const t=id(72),op="rc-turn-"+id(71)+"-"+t,hash="d".repeat(64);
    expect((await reserveSupervisorContinuation(db.asDO(),id(71),t,hash,op,1103)).kind).toBe("submit");
    await recordSupervisorContinuationReceipt(db.asDO(),id(71),t,op,
      {error:"REPLY_LOST_AFTER_NATIVE_INBOX_COMMIT"},1104);
    expect((await supervisorAdmissionSlot(db.asDO(),id(71)))?.phase).toBe("effect_unknown");
    expect((await reserveSupervisorContinuation(db.asDO(),id(71),t,hash,op,999999)).kind).toBe("existing");
    expect(await reconcileSupervisorTurnEffect(db.asDO(),id(71),op,
      {status:"unanswered",reason:"not_found"})).toBe(false);
    expect((await supervisorAdmissionSlot(db.asDO(),id(71)))?.phase).toBe("effect_unknown");
    expect(await reconcileSupervisorTurnEffect(db.asDO(),id(71),op,{status:"done"})).toBe(true);
    expect((await supervisorAdmissionSlot(db.asDO(),id(71)))?.phase).toBe("running");
  });

  test("R3 RED/GREEN: late original SDK failure cannot overwrite transferred grant", async () => {
    const db = new FakeDO();
    const original = await grant(db, 81), session = r2SessionId(id(81));
    await supervisorBeginExternalEffect(db.asDO(), original, "session_create", 1_101);
    const key = "supervisor:task:" + id(81);
    await db.transaction(async tx => {
      const task = await tx.get<SupervisorTask>(key);
      await tx.put(key, { ...task!, sessionCreationAttempted: true });
    });
    const before = (await supervisorAdmissionSlot(db.asDO(), id(81)))!;
    const recovery = await reconcileSupervisorCreatedSession(
      db.asDO(), id(81), session, before, 1_102);
    expect(recovery.kind).toBe("recovered");
    expect(await db.transaction(tx => supervisorGrantStillOwned(tx.asDO() as any, original)))
      .toBe(false);
    if (recovery.kind !== "recovered") return;
    // Mirrors advanceSupervisedTask's guarded catch, with a real transactional
    // read of the ledger under the original grant.
    const staleWriter = async () => db.transaction(async tx => {
      const fresh = await tx.get<SupervisorTask>(key);
      if (!await supervisorGrantStillOwned(tx.asDO() as any, original)) return fresh;
      await tx.put(key, { ...fresh!, status: "failed" });
      return { ...fresh!, status: "failed" };
    });
    const settled = await staleWriter();
    expect(settled?.status).toBe("preparing");
    expect((await db.get<SupervisorTask>(key))?.session).toBe(session);
    expect((await db.get<SupervisorTask>(key))?.status).toBe("preparing");
    expect(await db.transaction(tx => supervisorGrantStillOwned(tx.asDO() as any, recovery.grant, 1_103)))
      .toBe(true);
    await expect(supervisorCommitCreatedSession(db.asDO(), original, session, 1_103))
      .rejects.toThrow("ADMISSION_FENCE_REJECTED");
  });

  test("R3 native get classification recognizes exact core/client tags, not transient errors", () => {
    expect(r3IsNativeSessionNotFound({ _tag: "Session.NotFoundError" })).toBe(true);
    expect(r3IsNativeSessionNotFound({ _tag: "SessionNotFoundError" })).toBe(true);
    for (const input of [undefined, new Error("not found"), {status:404},
      {_tag:"TransientNetworkError"}, {_tag:"not_found"}, {_tag:"Session.NotFoundError2"}])
      expect(r3IsNativeSessionNotFound(input)).toBe(false);
  });

});

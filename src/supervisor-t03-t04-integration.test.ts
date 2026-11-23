import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  reserveSupervisorAdmission, supervisorBeginExternalEffect,
  supervisorConfirmExternalEffect, supervisorAdmissionSlot,
  supervisorAdmissionAllowsContinuation, hasSupervisorAdmissionSlot
} from "./supervisor-admission";
import {
  r2SessionId, r2TurnAdmission, r2CancelledByReceipt,
  r2StatusWriteAllowed, r2PendingTurnReconcileAllowed
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
    expect(supervisorAdmissionAllowsContinuation(undefined)).toBe(true); // legacy compatibility
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
    expect(supervisorAdmissionAllowsContinuation(oldSlot,false)).toBe(true);
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
    expect(source.includes("supervisorAdmissionSlot(tx, id)")).toBe(true);
    const begin = source.indexOf('supervisorBeginExternalEffect(this.ctx.storage, grant, "session_create")');
    const create = source.indexOf("this.harness.create({ id: sessionId })");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(create);
  });
});

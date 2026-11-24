import { describe, expect, test } from "bun:test";
import { reserveSupervisorAdmission, supervisorBeginExternalEffect,
  supervisorConfirmExternalEffect, supervisorAdmissionSlot, hasSupervisorAdmissionSlot,
  reconcileSupervisorSubmittedEffect, type StartGrant } from "./supervisor-admission";
import type { SupervisorTask } from "./supervisor-control";
import { PILOT_CLAIM, parsePilotApproval, evidenceFromClaim, type PilotApproval, type PilotClaim } from "./pilot-authorization";

/** Test double with serialized, rollback-capable durable transactions. */
class DurableFake {
  private rows = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  public writes = 0;
  async transaction<T>(fn: (tx: DurableFake) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const snapshot = new Map(this.rows);
    const staged = new DurableFake();
    staged.rows = snapshot;
    try {
      const result = await fn(staged);
      this.rows = staged.rows;
      this.writes++;
      return result;
    } finally { release(); }
  }
  async get<T>(key: string): Promise<T | undefined> { return this.rows.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.rows.set(key, structuredClone(value)); }
  async delete(key: string) { return this.rows.delete(key); }
  async list<T>(opts: {prefix?:string;limit?:number} = {}):Promise<Map<string,T>> {
    const entries = [...this.rows.entries()]
      .filter(([key])=>key.startsWith(opts.prefix ?? ""))
      .sort(([a],[b])=>a.localeCompare(b))
      .slice(0,opts.limit ?? Infinity)
      .map(([key,value])=>[key,structuredClone(value)] as [string,T]);
    return new Map(entries);
  }

  snapshot() { return structuredClone([...this.rows]); }
  restore(snapshot: [string, unknown][]) { this.rows = new Map(structuredClone(snapshot)); }
  asDO() { return this as unknown as DurableObjectStorage; }
}
const id = (n: number) => n.toString(16).padStart(16, "0");
const task = (n: number, fingerprint = "a".repeat(64)): SupervisorTask => ({
  id: id(n), repository: "aamvtrampa36-del/opencode-harness-example",
  project: "supervised-" + id(n), branch: "opencode/staging-" + id(n),
  fingerprint, createdAt: 100, status: "preparing", sessionCreationAttempted: false, sessionIdPolicy: "deterministic-v1"
});
const granted = (v: Awaited<ReturnType<typeof reserveSupervisorAdmission>>): StartGrant => {
  if (v.kind !== "granted") throw Error("test fixture expected grant");
  return v.grant;
};
const at = (s: DurableFake, n: number, clock = 1000) =>
  reserveSupervisorAdmission(s.asDO(), task(n), clock);
const begin = (s: DurableFake, g: StartGrant, effect: "github_branch" | "session_create" | "configure" | "submit", now = 1001) =>
  supervisorBeginExternalEffect(s.asDO(), g, effect, now);
const ack = (s: DurableFake, g: StartGrant, effect: "github_branch" | "session_create" | "configure" | "submit", now = 1002) =>
  supervisorConfirmExternalEffect(s.asDO(), g, effect, {confirmed:true}, now);

describe("F0-C10/R2-T03 durable admission (Cloudflare transaction interface, offline)", () => {
  test("ten distinct simultaneous requests get 10 slots, eleventh is rejected without any record", async () => {
    const s = new DurableFake();
    const results = await Promise.all(Array.from({length:10},(_,i)=>at(s,i+1)));
    expect(results.every(x=>x.kind==="granted")).toBe(true);
    expect((await at(s,11))).toMatchObject({kind:"capacity",reason:"CAPACITY_EXHAUSTED"});
    expect(await s.get("supervisor:task:" + id(11))).toBeUndefined();
    const ledger = await s.get<{slots:Record<string,unknown>}>("supervisor:admission:v1");
    expect(Object.keys(ledger!.slots)).toHaveLength(10);
  });
  test("two competing callers with identical requestId can never hold two grants", async () => {
    const s = new DurableFake();
    const [a,b] = await Promise.all([at(s,1),at(s,1)]);
    expect([a.kind,b.kind].sort()).toEqual(["granted","reused"]);
    expect(s.snapshot().filter(([key])=>key==="supervisor:task:"+id(1))).toHaveLength(1);
  });
  test("100 retries preserve identity and reject a changed digest", async () => {
    const s = new DurableFake();
    const responses = await Promise.all(Array.from({length:100},()=>at(s,1)));
    expect(responses.filter(x=>x.kind==="granted")).toHaveLength(1);
    await expect(reserveSupervisorAdmission(s.asDO(),task(1,"b".repeat(64)),1001))
      .rejects.toThrow("requestId usado con otra tarea");
  });
  test("expired unused reservation can be reclaimed with higher fenced generation", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    const b = granted(await at(s,1,61001));
    expect(b.generation).toBe(2);
    expect(b.token).not.toBe(a.token);
    await expect(begin(s,a,"github_branch",61002)).rejects.toThrow("ADMISSION_FENCE_REJECTED");
    await begin(s,b,"github_branch",61002);
    await ack(s,b,"github_branch",61003);
  });
  test("an expired effect intent is sticky, never licenses another external call", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    await begin(s,a,"session_create");
    const b = await at(s,1,1_000_000);
    expect(b).toMatchObject({kind:"reused",reason:"EFFECT_UNCONFIRMED"});
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.phase).toBe("effect_unknown");
    await expect(begin(s,a,"session_create",1_000_000)).rejects.toThrow("ADMISSION_FENCE_REJECTED");
  });
  test("durable restart with lost response preserves the unknown marker and request mapping", async () => {
    const old = new DurableFake();
    const a = granted(await at(old,1));
    await begin(old,a,"submit");
    const restarted = new DurableFake();
    restarted.restore(old.snapshot());
    const next = await at(restarted,1,1_000_000);
    expect(next).toMatchObject({kind:"reused",reason:"EFFECT_UNCONFIRMED"});
    expect(await restarted.get("supervisor:task:"+id(1))).toMatchObject({fingerprint:"a".repeat(64)});
  });
  test("configuration and submit have separate write-ahead intents and verified acknowledgments", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    for (const effect of ["github_branch","session_create","configure"] as const) {
      await begin(s,a,effect);
      expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.effect).toBe(effect);
      await ack(s,a,effect);
    }
    await begin(s,a,"submit");
    await expect(supervisorConfirmExternalEffect(s.asDO(),a,"configure",{confirmed:true}))
      .rejects.toThrow("ADMISSION_FENCE_REJECTED");
    await ack(s,a,"submit");
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.phase).toBe("running");
  });
  test("a receipt with confirmed=false never transitions to running", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    await begin(s,a,"submit");
    await expect(supervisorConfirmExternalEffect(s.asDO(),a,"submit",{confirmed:false}))
      .rejects.toThrow("ADMISSION_RECEIPT_UNCONFIRMED");
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.phase).toBe("effect_unknown");
  });
  test("confirmed terminal task frees capacity on next admission; unknown does not", async () => {
    const s = new DurableFake();
    const grants:StartGrant[]=[];
    for (let i=1;i<=10;i++) grants.push(granted(await at(s,i)));
    await begin(s,grants[0],"submit");await ack(s,grants[0],"submit");
    await s.put("supervisor:task:"+id(1),{...task(1),status:"finished"});
    await begin(s,grants[1],"submit"); // remains uncertain
    await s.put("supervisor:task:"+id(2),{...task(2),status:"failed"});
    expect((await at(s,11)).kind).toBe("granted");
    expect(await supervisorAdmissionSlot(s.asDO(),id(1))).toBeUndefined();
    expect((await supervisorAdmissionSlot(s.asDO(),id(2)))?.phase).toBe("effect_unknown");
    expect((await at(s,12)).kind).toBe("capacity");
  });
  test("legacy preparing task without ledger slot is reused but never restarted", async () => {
    const s = new DurableFake();
    await s.put("supervisor:task:"+id(1),task(1));
    expect(await at(s,1)).toMatchObject({kind:"reused",reason:"LEGACY_RECONCILE_REQUIRED"});
    expect(await supervisorAdmissionSlot(s.asDO(),id(1))).toBeUndefined();
  });
  test("cancel check sees the slot in the same durable transaction", async () => {
    const s = new DurableFake();
    await at(s,1);
    const active = await s.transaction(tx=>hasSupervisorAdmissionSlot(tx as unknown as DurableObjectTransaction,id(1)));
    expect(active).toBe(true);
  });
  test("rejected effect generation, wrong receipt, and invalid ledger never fail open", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    await expect(begin(s,{...a,token:crypto.randomUUID()},"submit")).rejects.toThrow("ADMISSION_FENCE_REJECTED");
    await s.put("supervisor:admission:v1",{version:77,slots:{}});
    await expect(at(s,2)).rejects.toThrow("ADMISSION_LEDGER_INVALID");
  });
  test("1→2→4→10 admission levels are not permanently capped at 2", async () => {
    for (const count of [1,2,4,10]) {
      const s = new DurableFake();
      const receipts = await Promise.all(Array.from({length:count},(_,i)=>at(s,i+1)));
      expect(receipts.filter(x=>x.kind==="granted")).toHaveLength(count);
    }
  });

  test("native not_found cannot resolve an uncertain submit, done receipt can without replay", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    await s.put("supervisor:task:"+id(1),{...task(1),operationId:"rc-start-"+id(1)});
    await begin(s,a,"submit");
    expect(await reconcileSupervisorSubmittedEffect(s.asDO(),id(1),"rc-start-"+id(1),
      {status:"unanswered",reason:"not_found"})).toBe(false);
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.phase).toBe("effect_unknown");
    expect(await reconcileSupervisorSubmittedEffect(s.asDO(),id(1),"rc-start-"+id(2),
      {status:"done"})).toBe(false);
    expect(await reconcileSupervisorSubmittedEffect(s.asDO(),id(1),"rc-start-"+id(1),
      {status:"done"})).toBe(true);
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.phase).toBe("running");
  });
});

test("pilot authorization is single-use, exact-release, fingerprint and process bound",async()=>{
  const s=new DurableFake(), now=1000, instance="12345678-1234-1234-1234-123456789abc", objectId="a".repeat(64);
  const candidate={...task(50),createdAt:now,model:"cloudflare" as const,pilotInstance:instance};
  const receipt="b".repeat(64), release="c".repeat(40);
  const approval:PilotApproval={schema:"pilot-release-v1",environment:"staging",requestId:candidate.id,releaseSha:release,fingerprint:candidate.fingerprint,notBefore:now-1,expiresAt:now+1800000,ciRun:"1234",approvalRef:"synthetic-test-only",residualRisk:"accepted-bounded-trial",plannedOtherMicroUsd:500000,
    evidence:{sdkOffline:receipt,routeControls:receipt,closeControls:receipt,billingHeadroom:receipt,freeInputBound:receipt,glmInputBound:receipt},
    inputBounds:{free:{maxWireBytes:10000,maxInputTokens:64000,receipt},glm:{maxWireBytes:10000,maxInputTokens:64000,receipt}}};
  expect(parsePilotApproval(undefined,release,candidate.id,now)).toBeUndefined();
  expect(parsePilotApproval(JSON.stringify(approval),"d".repeat(40),candidate.id,now)).toBeUndefined();
  expect(parsePilotApproval(JSON.stringify({...approval,inputBounds:{}}),release,candidate.id,now)).toBeUndefined();
  const claim:PilotClaim={approval,instance,objectId,startedAt:now};
  await expect(reserveSupervisorAdmission(s.asDO(),candidate,now)).rejects.toThrow("PILOT_AUTHORIZATION_REQUIRED");
  await expect(reserveSupervisorAdmission(s.asDO(),{...candidate,fingerprint:"e".repeat(64)},now,undefined,claim)).rejects.toThrow("PILOT_AUTHORIZATION_INVALID");
  const other=new DurableFake();await at(other,1,now);
  await expect(reserveSupervisorAdmission(other.asDO(),candidate,now,undefined,claim)).rejects.toThrow("PILOT_EXCLUSIVE_SLOT_REQUIRED");
  const result=await Promise.allSettled([reserveSupervisorAdmission(s.asDO(),candidate,now,undefined,claim),reserveSupervisorAdmission(s.asDO(),candidate,now,undefined,claim)]);
  expect(result.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(await s.get(PILOT_CLAIM)).toEqual(claim);
  expect(evidenceFromClaim(claim,approval,instance,objectId,candidate,now+100)).toBeDefined();
  expect(evidenceFromClaim(claim,approval,crypto.randomUUID(),objectId,candidate,now+100)).toBeUndefined();
  expect(evidenceFromClaim(claim,approval,instance,objectId,candidate,now+900000)).toBeUndefined();
  await expect(at(s,51,now+10)).rejects.toThrow("PILOT_EXCLUSIVE_LANE");
});

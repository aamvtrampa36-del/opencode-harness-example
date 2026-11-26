import { describe, expect, test } from "bun:test";
import { assertRecoveryWorkAllowed, recoveryMode, recoveryHttpAllowed, assertRecoveryWorkflowAllowed, recoveryCloseAllowed } from "./metralla-m08-recovery-mode";
import { reserveSupervisorAdmission, supervisorBeginExternalEffect,
  supervisorConfirmExternalEffect, supervisorAdmissionSlot, hasSupervisorAdmissionSlot,
  reconcileSupervisorSubmittedEffect, supervisorGrantStillOwned, reserveSupervisorContinuation, inspectSupervisorAdmissionCapacity, type StartGrant } from "./supervisor-admission";
import type { SupervisorTask } from "./supervisor-control";
import { PILOT_CLAIM, parsePilotApproval, evidenceFromClaim, type PilotApproval, type PilotClaim } from "./pilot-authorization";
import { PILOT_PRICING_REVISION } from "./supervisor-inference-budget";
import { reconcileHistoricalSupervisor } from "./supervisor-admission";
import { reconciliationDigest,type NativeQuiescence, CONSUMED_PILOT_ID, retiredHistoricalTask, inspectConsumedPilot, archiveConsumedPilot, type ConsumedArchive, type ConsumedEvidence, type ConsumedClosure, type ConsumedAuthorization } from "./supervisor-reconciliation";

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
  async list<T>(opts: {prefix?:string;limit?:number;startAfter?:string} = {}):Promise<Map<string,T>> {
    const entries = [...this.rows.entries()]
      .filter(([key])=>key.startsWith(opts.prefix ?? "")&&(!opts.startAfter||key>opts.startAfter))
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
  test("P03 two distinct contenders for the last slot reserve exactly one", async () => {
    const s = new DurableFake();
    for (let i=1;i<=9;i++) granted(await at(s,i));
    expect((await inspectSupervisorAdmissionCapacity(s.asDO())).activeSlots).toBe(9);
    const results = await Promise.all([at(s,10),at(s,11)]);
    expect(results.map(x=>x.kind).sort()).toEqual(["capacity","granted"]);
    const loser = results[0].kind === "capacity" ? 10 : 11;
    expect(await s.get("supervisor:task:"+id(loser))).toBeUndefined();
    expect(await supervisorAdmissionSlot(s.asDO(),id(loser))).toBeUndefined();
    expect((await inspectSupervisorAdmissionCapacity(s.asDO())).activeSlots).toBe(10);
  });
  test("P03 ten contenders for two free slots have no rejected task rows", async () => {
    const s = new DurableFake();
    for (let i=1;i<=8;i++) granted(await at(s,i));
    expect((await inspectSupervisorAdmissionCapacity(s.asDO())).activeSlots).toBe(8);
    const results = await Promise.all(Array.from({length:10},(_,i)=>at(s,i+9)));
    expect(results.filter(x=>x.kind==="granted")).toHaveLength(2);
    expect(results.filter(x=>x.kind==="capacity")).toHaveLength(8);
    for (let i=0;i<10;i++) if (results[i].kind === "capacity") {
      expect(await s.get("supervisor:task:"+id(i+9))).toBeUndefined();
      expect(await supervisorAdmissionSlot(s.asDO(),id(i+9))).toBeUndefined();
    }
    expect((await inspectSupervisorAdmissionCapacity(s.asDO())).activeSlots).toBe(10);
  });
  test("P03 expired reserved writer is fenced even before regrant", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    const owned = (g: StartGrant, now: number) => s.transaction(tx=>
      supervisorGrantStillOwned(tx as unknown as DurableObjectTransaction,g,now));
    expect(await owned(a,60999)).toBe(true);
    expect(await owned(a,61000)).toBe(false);
    const b = granted(await at(s,1,61000));
    expect(await owned(a,61001)).toBe(false);
    expect(await owned(b,61001)).toBe(true);
  });
  test("P03 expiry does not release an uncertain effect or invalidate its positive receipt", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    await begin(s,a,"submit");
    expect(await s.transaction(tx=>supervisorGrantStillOwned(
      tx as unknown as DurableObjectTransaction,a,1_000_000))).toBe(true);
    expect(await at(s,1,1_000_000)).toMatchObject({kind:"reused",reason:"EFFECT_UNCONFIRMED"});
    await ack(s,a,"submit",1_000_001);
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.phase).toBe("running");
  });
  test("P03 expired reservation cannot be regranted after cancellation intent", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    await s.put("supervisor:task:"+id(1),{...task(1),status:"cancel_requested"});
    const before = s.snapshot();
    expect(await at(s,1,61000)).toMatchObject({kind:"reused",reason:"ADMISSION_START_NOT_ACTIVE"});
    expect(s.snapshot()).toEqual(before);
    await expect(begin(s,a,"github_branch",61001)).rejects.toThrow("ADMISSION_FENCE_REJECTED");
    expect(s.snapshot()).toEqual(before);
  });
  test("P03 wrong fence, pending turn and ambiguous cancellation cannot write effect intent", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    const before = s.snapshot();
    await expect(begin(s,{...a,token:crypto.randomUUID()},"submit")).rejects.toThrow("ADMISSION_FENCE_REJECTED");
    expect(s.snapshot()).toEqual(before);
    for (const extra of [{cancelAmbiguous:true},{pendingTurn:{turnId:id(2),operationId:"rc-turn-"+id(1)+"-"+id(2)}}]) {
      await s.put("supervisor:task:"+id(1),{...task(1),...extra});
      const snapshot = s.snapshot();
      await expect(begin(s,a,"submit")).rejects.toThrow("ADMISSION_FENCE_REJECTED");
      expect(s.snapshot()).toEqual(snapshot);
    }
  });
  test("P03 pilot candidate without server claim leaves no reservation or task", async () => {
    const s = new DurableFake();
    const before = s.snapshot();
    await expect(reserveSupervisorAdmission(s.asDO(),{...task(1),pilotInstance:crypto.randomUUID()},1000))
      .rejects.toThrow("PILOT_AUTHORIZATION_REQUIRED");
    expect(s.snapshot()).toEqual(before);
  });
  test("P03 crossed native operation cannot allocate or duplicate a turn", async () => {
    const s = new DurableFake();
    const a = granted(await at(s,1));
    await begin(s,a,"submit"); await ack(s,a,"submit");
    await s.put("supervisor:task:"+id(1),{...task(1),status:"running",session:"ses_r2_"+id(1),operationId:"rc-start-"+id(1)});
    const before=s.snapshot(), t=id(2), hash="a".repeat(64), op="rc-turn-"+id(1)+"-"+t;
    await expect(reserveSupervisorContinuation(s.asDO(),id(1),t,hash,"rc-turn-"+id(3)+"-"+t,1003)).rejects.toThrow("SUPERVISOR_TURN_INPUT_INVALID");
    expect(s.snapshot()).toEqual(before);
    const replies=await Promise.all([reserveSupervisorContinuation(s.asDO(),id(1),t,hash,op,1003),reserveSupervisorContinuation(s.asDO(),id(1),t,hash,op,1003)]);
    expect(replies.map(x=>x.kind).sort()).toEqual(["existing","submit"]);
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.effect).toBe("turn_submit");
  });
  test("P03 pending turn with missing journal cannot be submitted again",async()=>{
    const s=new DurableFake(), a=granted(await at(s,1)), t=id(2), op="rc-turn-"+id(1)+"-"+t;
    await begin(s,a,"submit"); await ack(s,a,"submit");
    await s.put("supervisor:task:"+id(1),{...task(1),status:"running",session:"ses_r2_"+id(1),operationId:op,pendingTurn:{turnId:t,operationId:op}});
    const before=s.snapshot();
    await expect(reserveSupervisorContinuation(s.asDO(),id(1),t,"a".repeat(64),op,1003)).rejects.toThrow("SUPERVISOR_TURN_JOURNAL_MISSING");
    expect(s.snapshot()).toEqual(before);
  });
  test("P03 archived pilot frees only its accounting slot, preserves claim and denies replay",async()=>{
    const s=new DurableFake(), pid=CONSUMED_PILOT_ID, now=2_000_000, h="a".repeat(64), sh="b".repeat(40), uuid="11111111-1111-4111-8111-111111111111";
    const claim={approval:{schema:"pilot-release-v2",environment:"staging",requestId:pid,releaseSha:sh,sourceCommit:sh,sourceTree:sh,fingerprint:h},instance:uuid,objectId:h,startedAt:10};
    const job={...task(1),id:pid,project:"supervised-"+pid,branch:"opencode/staging-"+pid,fingerprint:h,createdAt:10,pilotInstance:uuid,status:"cancel_requested",cancelAmbiguous:true};
    const tk="supervisor:task:"+pid, ak="supervisor:consumed-pilot:archive:v1:"+pid;
    await s.put(PILOT_CLAIM,claim);await s.put(tk,job);
    await s.put("supervisor:admission:v1",{version:1,slots:{[pid]:{token:uuid,generation:2,expiresAt:5,phase:"effect_unknown",effect:"github_branch"}}});
    expect((await inspectSupervisorAdmissionCapacity(s.asDO())).activeSlots).toBe(1);
    expect(await retiredHistoricalTask(s.asDO(),pid)).toBe(false);
    const identity=await inspectConsumedPilot(s.asDO());
    const evidence:ConsumedEvidence={identity,kind:"absent",authoritativeNegative:true,complete:true,writerDrained:true,observedAt:now-1,receiptDigest:h};
    const closure:ConsumedClosure={snapshotDigest:identity.snapshotDigest,evidenceDigest:await reconciliationDigest(evidence),observedAt:now,drainReceipt:h,closureReceipt:h,budgetReceipt:h,noOutstandingEffects:true,writerFenced:true};
    const auth:ConsumedAuthorization={action:"archive-consumed-pilot-and-release-reservation",environment:"staging",snapshotDigest:identity.snapshotDigest,evidenceDigest:closure.evidenceDigest,closureDigest:await reconciliationDigest(closure),approvalRef:"offline-fixture-only",notBefore:now-100,expiresAt:now+1000};
    await archiveConsumedPilot(s.asDO(),evidence,closure,auth,async()=>true,()=>now);
    expect(await inspectSupervisorAdmissionCapacity(s.asDO())).toMatchObject({activeSlots:0,stopReason:null});
    expect(await retiredHistoricalTask(s.asDO(),pid)).toBe(true);
    expect(await s.get(PILOT_CLAIM)).toEqual(claim); expect(await s.get(tk)).toEqual(job);
    await expect(reserveSupervisorAdmission(s.asDO(),{...task(1),id:pid,project:job.project,branch:job.branch},now)).rejects.toThrow("PILOT_NO_REPLAY");
    expect((await at(s,99,now)).kind).toBe("granted");
    const archive=await s.get<ConsumedArchive>(ak);
    if(!archive)throw Error("fixture archive missing");
    await s.put(ak,{...archive,digest:"0".repeat(64)});
    await expect(retiredHistoricalTask(s.asDO(),pid)).rejects.toThrow("P03_CONSUMED_ARCHIVE_INVALID");
    await expect(inspectSupervisorAdmissionCapacity(s.asDO())).rejects.toThrow("P03_CONSUMED_ARCHIVE_INVALID");
    await s.put(ak,archive);await s.put(tk,{...job,revision:8});
    await expect(at(s,100,now)).rejects.toThrow("P03_CONSUMED_ARCHIVE_INVALID");
    expect(await s.get("supervisor:task:"+id(100))).toBeUndefined();
  });
  test("P03 invalid clock cannot write intent or receipt",async()=>{
    const s=new DurableFake(), a=granted(await at(s,1)), before=s.snapshot();
    await expect(begin(s,a,"submit",NaN)).rejects.toThrow("ADMISSION_CLOCK_INVALID");
    expect(s.snapshot()).toEqual(before);
    await begin(s,a,"submit");
    const intent=s.snapshot();
    await expect(ack(s,a,"submit",NaN)).rejects.toThrow("ADMISSION_CLOCK_INVALID");
    expect(s.snapshot()).toEqual(intent);
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
    await s.put("supervisor:task:"+id(1),{...task(1),session:"ses_r2_"+id(1),operationId:"rc-start-"+id(1)});
    await begin(s,a,"submit");
    expect(await reconcileSupervisorSubmittedEffect(s.asDO(),id(1),"rc-start-"+id(1),
      {status:"unanswered",reason:"not_found"})).toBe(false);
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.phase).toBe("effect_unknown");
    expect(await reconcileSupervisorSubmittedEffect(s.asDO(),id(1),"rc-start-"+id(2),
      {status:"done"})).toBe(false);
    const before=s.snapshot();
    for(const receipt of [{status:"unanswered"},{status:"unanswered",reason:"other"},{status:"done",reason:"not_found"}] as const)
      expect(await reconcileSupervisorSubmittedEffect(s.asDO(),id(1),"rc-start-"+id(1),receipt)).toBe(false);
    expect(await reconcileSupervisorSubmittedEffect(s.asDO(),id(1),"rc-start-"+id(1),{status:"done"},"ses_other")).toBe(false);
    expect(s.snapshot()).toEqual(before);
    expect(await reconcileSupervisorSubmittedEffect(s.asDO(),id(1),"rc-start-"+id(1),
      {status:"done"},"ses_r2_"+id(1))).toBe(true);
    expect((await supervisorAdmissionSlot(s.asDO(),id(1)))?.phase).toBe("running");
  });
});

test("pilot authorization is single-use, exact-release, fingerprint and process bound",async()=>{
  const s=new DurableFake(), now=1000, instance="12345678-1234-1234-1234-123456789abc", objectId="a".repeat(64);
  const candidate={...task(50),createdAt:now,model:"cloudflare" as const,pilotInstance:instance};
  const receipt="b".repeat(64), release="c".repeat(40);
  const approval:PilotApproval={schema:"pilot-release-v2",environment:"staging",requestId:candidate.id,releaseSha:release,sourceCommit:release,sourceTree:"d".repeat(40),containerImageDigest:"sha256:"+receipt,reconciliationDigest:receipt,fingerprint:candidate.fingerprint,notBefore:now-1,expiresAt:now+1800000,ciRun:"1234",approvalRef:"synthetic-test-only",residualRisk:"accepted-bounded-trial",plannedOtherMicroUsd:500000,
    evidence:{sdkOffline:receipt,routeControls:receipt,closeControls:receipt,billingHeadroom:receipt,freeZeroPrice:receipt,glmBillingBound:receipt},
    pricingRevision:PILOT_PRICING_REVISION,maxWireBytes:10000,
    billingReview:{basis:"previous-cycle-proxy",cycleStart:now-100,observedThrough:now-200,observedDurationGbSeconds:50000,sharedAndLagMarginGbSeconds:30000,pilotAllowanceGbSeconds:2000}};
  expect(parsePilotApproval(undefined,release,candidate.id,now)).toBeUndefined();
  expect(parsePilotApproval(JSON.stringify(approval),"d".repeat(40),candidate.id,now)).toBeUndefined();
  expect(parsePilotApproval(JSON.stringify({...approval,schema:"pilot-release-v1"}),release,candidate.id,now)).toBeUndefined();
  expect(parsePilotApproval(JSON.stringify({...approval,pricingRevision:"unknown"}),release,candidate.id,now)).toBeUndefined();
  expect(parsePilotApproval(JSON.stringify({...approval,billingReview:{...approval.billingReview,observedDurationGbSeconds:399999}}),release,candidate.id,now)).toBeUndefined();
  expect(parsePilotApproval(JSON.stringify({...approval,billingReview:{...approval.billingReview,observedThrough:now+1}}),release,candidate.id,now)).toBeUndefined();
  expect(parsePilotApproval(JSON.stringify({...approval,evidence:{...approval.evidence,glmBillingBound:""}}),release,candidate.id,now)).toBeUndefined();
  const claim:PilotClaim={approval,instance,objectId,startedAt:now};
  await expect(reserveSupervisorAdmission(s.asDO(),candidate,now)).rejects.toThrow("PILOT_AUTHORIZATION_REQUIRED");
  await expect(reserveSupervisorAdmission(s.asDO(),{...candidate,fingerprint:"e".repeat(64)},now,undefined,claim)).rejects.toThrow("PILOT_AUTHORIZATION_INVALID");
  const native:NativeQuiescence={schema:"native-quiescence-v1",ids:[],digest:await reconciliationDigest([]),observedAt:now};
  const maintenance={schema:"r4-reconciliation-v1" as const,environment:"staging" as const,releaseSha:release,requestId:candidate.id,
    approvalRef:"synthetic-maintenance",externalDrainReceipt:receipt,drainedAt:now-1,notBefore:now-1,expiresAt:now+1800000};
  const reconciled=await reconcileHistoricalSupervisor(s.asDO(),maintenance,objectId,async()=>native,()=>now);
  approval.reconciliationDigest=reconciled.digest;
  const other=new DurableFake();await at(other,1,now);
  await expect(reserveSupervisorAdmission(other.asDO(),candidate,now,undefined,claim,native)).rejects.toThrow("PILOT_EXCLUSIVE_SLOT_REQUIRED");
  const result=await Promise.allSettled([reserveSupervisorAdmission(s.asDO(),candidate,now,undefined,claim,native),reserveSupervisorAdmission(s.asDO(),candidate,now,undefined,claim,native)]);
  expect(result.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(await s.get(PILOT_CLAIM)).toEqual(claim);
  expect(evidenceFromClaim(claim,approval,instance,objectId,candidate,now+100)).toBeDefined();
  expect(evidenceFromClaim(claim,approval,crypto.randomUUID(),objectId,candidate,now+100)).toBeUndefined();
  expect(evidenceFromClaim(claim,approval,instance,objectId,candidate,now+900000)).toBeUndefined();
  await expect(at(s,51,now+10)).rejects.toThrow("PILOT_EXCLUSIVE_LANE");
});

describe("M08 recovery variant preserves durable effects across release switch",()=>{
  const env={OPENCODE_M08_RECOVERY_MODE:"true"};
  test("reserved and effect-unknown slots survive incarnation; new and repeated starts denied before transaction",async()=>{
    const first=new DurableFake();
    const a=granted(await at(first,1));granted(await at(first,2));
    await begin(first,a,"github_branch");
    const original=first.snapshot(),next=new DurableFake();next.restore(original);
    for(const n of [1,2,3])await expect((async()=>{assertRecoveryWorkAllowed(env);return at(next,n,1000000);})()).rejects.toThrow("M08_RECOVERY_NEW_EFFECT_FORBIDDEN");
    expect(next.snapshot()).toEqual(original);
    expect((await supervisorAdmissionSlot(next.asDO(),id(1)))?.phase).toBe("effect_unknown");
    expect((await supervisorAdmissionSlot(next.asDO(),id(2)))?.phase).toBe("reserved");
    expect(await next.get("supervisor:task:"+id(3))).toBeUndefined();
    // Positive receipt still uses the identical durable transaction and grant.
    await ack(next,a,"github_branch",1000001);
    expect((await supervisorAdmissionSlot(next.asDO(),id(1)))?.effect).toBeUndefined();
    expect((await supervisorAdmissionSlot(next.asDO(),id(2)))?.phase).toBe("reserved");
  });
  test("fail-closed ingress, retained authorized reconciliation and no automatic close",()=>{
    expect(recoveryMode({})).toBe(false);expect(recoveryMode({OPENCODE_M08_RECOVERY_MODE:"false"})).toBe(false);
    expect(recoveryMode({OPENCODE_M08_RECOVERY_MODE:"typo"})).toBe(true);
    expect(()=>assertRecoveryWorkAllowed({})).not.toThrow();
    for(const action of ["start","recovery_drill","joint_cleanup","external_backup_drill","session_backup_drill",null])expect(()=>assertRecoveryWorkflowAllowed(env,action)).toThrow();
    for(const action of ["status","cancel","metralla_native_evidence","metralla_inspect_consumed","metralla_archive_consumed","metralla_normal_close","metralla_request_close"])expect(()=>assertRecoveryWorkflowAllowed(env,action)).not.toThrow();
    const path="/api/supervisor/v1/tasks/"+id(1);
    expect(recoveryHttpAllowed("GET",path)).toBe(true);expect(recoveryHttpAllowed("POST",path+"/cancel")).toBe(true);
    for(const [method,p] of [["POST","/api/supervisor/v1/tasks"],["GET","/api/dev/download/foo"],["POST","/agents/x"],["GET",path+"/cancel"],["POST",path+"/other"],["POST",path+"/cancel/"]])expect(recoveryHttpAllowed(method,p)).toBe(false);
    expect(recoveryCloseAllowed(env,false,false)).toBe(false);expect(recoveryCloseAllowed(env,true,true)).toBe(false);
    expect(recoveryCloseAllowed(env,true,false)).toBe(true);expect(recoveryCloseAllowed({},false,true)).toBe(true);
  });
});

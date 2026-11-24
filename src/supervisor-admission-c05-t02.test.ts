import { test } from "bun:test";
import assert from "node:assert/strict";
import { reserveSupervisorAdmission, supervisorBeginExternalEffect, supervisorConfirmExternalEffect,
  supervisorAdmissionSlot, reconcileSupervisorSubmittedEffect, reconcileSupervisorCreatedSession,
  supervisorVerifyReadOnlySource, supervisorBeginReadOnlyEffect, supervisorConfirmReadOnlyEffect,
  reconcileSupervisorReadOnlyImport, supervisorRecordReadOnlyFailure, inspectSupervisorReadOnlyAdmission,
  type StartGrant, type ReadOnlyStartEffect, type ReadOnlyEffectReceipt } from "./supervisor-admission";
import { supervisorTaskKey, supervisorStartOperationId, type SupervisorTask } from "./supervisor-control";
import { r2SessionId } from "./supervisor-r2";
import { scopeStorageKey } from "./project-scope";

class DurableFake {
  private rows = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  public writes = 0;
  async transaction<T>(fn: (tx: DurableFake) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const snapshot = new Map(this.snapshot());
    const staged = new DurableFake();
    staged.rows = snapshot;
    try {
      const result = await fn(staged);
      this.rows = staged.rows;
      this.writes++;
      return result;
    } finally { release(); }
  }
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.rows.get(key)) as T | undefined; }
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

const PINS={commit:"a".repeat(40),tree:"b".repeat(40)};
const REPO="aamvtrampa36-del/opencode-harness-example";
const id=(n:number)=>n.toString(16).padStart(16,"0");
const candidate=(n=1):SupervisorTask=>({
  id:id(n),repository:REPO,project:"supervised-"+id(n),branch:"",
  fingerprint:"c".repeat(64),status:"preparing",createdAt:1000,
  sessionIdPolicy:"deterministic-v1",sessionCreationAttempted:false,mode:"read_only",sourceCommit:PINS.commit,sourceTree:PINS.tree
} as SupervisorTask);
const stages:ReadOnlyStartEffect[]=["project_reserve","container_import","session_create",
  "scope_bind","configure_agent","configure_model","submit"];
function evidence(effect:ReadOnlyStartEffect,n=1):ReadOnlyEffectReceipt {
  const task=candidate(n),sid=r2SessionId(task.id);
  const common={effect,project:task.project,repository:task.repository};
  if(effect==="project_reserve")return common;
  if(effect==="container_import")return {...common,...PINS,files:3,sha256:"d".repeat(64)};
  if(effect==="configure_agent")return {...common,sessionId:sid,agent:"build"};
  if(effect==="configure_model")return {...common,sessionId:sid,model:"economy"};
  if(effect==="submit")return {...common,sessionId:sid,operationId:supervisorStartOperationId(task.id),accepted:true};
  return {...common,sessionId:sid};
}
async function setup(n=1) {
  const store=new DurableFake(),task=candidate(n);
  const r=await reserveSupervisorAdmission(store.asDO(),task,1000,PINS);
  if(r.kind!=="granted")throw Error("fixture grant");
  return {store,task,grant:r.grant};
}
async function verify(store:DurableFake,grant:StartGrant,now=1001) {
  return supervisorVerifyReadOnlySource(store.asDO(),grant,{repo:REPO,...PINS},now);
}
async function advance(store:DurableFake,grant:StartGrant,count:number) {
  for(let i=0;i<count;i++){
    const effect=stages[i];
    await supervisorBeginReadOnlyEffect(store.asDO(),grant,effect,1002+i*2);
    if(effect==="scope_bind")await store.put(scopeStorageKey(r2SessionId(grant.id)),{
      project:"supervised-"+grant.id,repository:REPO});
    await supervisorConfirmReadOnlyEffect(store.asDO(),grant,evidence(effect),1003+i*2);
  }
}
async function current(store:DurableFake,grant:StartGrant) {
  const task=await store.get<SupervisorTask>(supervisorTaskKey(grant.id));
  if(!task)throw Error("fixture task");
  return task;
}
async function slotOf(store:DurableFake,grant:StartGrant) {
  const slot=await supervisorAdmissionSlot(store.asDO(),grant.id);
  if(!slot)throw Error("fixture slot");
  return slot;
}

test("ordinary admission stays compatible, read_only pins mandatory and duplicate identity stable",async()=>{
  const {store,task,grant}=await setup();
  const reused=await reserveSupervisorAdmission(store.asDO(),task,1001,PINS);
  assert.equal(reused.kind,"reused");
  const changed={...PINS,tree:"e".repeat(40)};
  await assert.rejects(reserveSupervisorAdmission(store.asDO(),task,1001,changed),/READ_ONLY_SOURCE_PIN_MISMATCH/);
  await assert.rejects(reserveSupervisorAdmission(store.asDO(),{...task,sourceTree:changed.tree},1001,changed),/READ_ONLY_ADMISSION_IDENTITY_CONFLICT/);
  await assert.rejects(reserveSupervisorAdmission(store.asDO(),candidate(2),1001),/PINS_REQUIRED/);
  await assert.rejects(supervisorBeginExternalEffect(store.asDO(),grant,"github_branch",1001),/TRANSACTION_REQUIRED/);
  const ordinary={...candidate(2),branch:"normal-branch",mode:undefined,sourceCommit:undefined,sourceTree:undefined};
  const r=await reserveSupervisorAdmission(store.asDO(),ordinary,1001);
  if(r.kind!=="granted")throw Error("ordinary grant");
  await supervisorBeginExternalEffect(store.asDO(),r.grant,"github_branch",1002);
  await supervisorConfirmExternalEffect(store.asDO(),r.grant,"github_branch",{confirmed:true},1003);
  assert.equal((await slotOf(store,r.grant)).phase,"reserved");
});
test("wrong source and premature import cannot create an intent; expired owner cannot persist GET",async()=>{
  const {store,task,grant}=await setup();
  await assert.rejects(supervisorVerifyReadOnlySource(store.asDO(),grant,{repo:REPO,...PINS,tree:"e".repeat(40)},1001),/PIN_MISMATCH/);
  await assert.rejects(supervisorBeginReadOnlyEffect(store.asDO(),grant,"container_import",1001),/EFFECT_ORDER/);
  const r=await reserveSupervisorAdmission(store.asDO(),task,62000,PINS);
  if(r.kind!=="granted")throw Error("regrant");
  assert.equal(r.grant.generation,2);
  await assert.rejects(verify(store,grant,62001),/FENCE/);
  assert.equal((await verify(store,r.grant,62001)).baseCommit,PINS.commit);
  assert.equal((await inspectSupervisorReadOnlyAdmission(store.asDO(),task.id))?.sourceVerifiedAt,62001);
});
test("all seven effects are ordered, exact and use one slot",async()=>{
  const {store,task,grant}=await setup();
  await verify(store,grant);
  await assert.rejects(supervisorBeginReadOnlyEffect(store.asDO(),grant,"configure_agent",1002),/EFFECT_ORDER/);
  await advance(store,grant,3);
  await supervisorBeginReadOnlyEffect(store.asDO(),grant,"scope_bind",1010);
  await assert.rejects(supervisorConfirmReadOnlyEffect(store.asDO(),grant,evidence("scope_bind"),1011),/SCOPE_CONFLICT/);
  assert.equal((await slotOf(store,grant)).phase,"effect_unknown");
  await store.put(scopeStorageKey(r2SessionId(task.id)),{project:task.project,repository:REPO});
  await supervisorConfirmReadOnlyEffect(store.asDO(),grant,evidence("scope_bind"),1011);
  for(const effect of stages.slice(4)){
    await supervisorBeginReadOnlyEffect(store.asDO(),grant,effect,1012);
    await supervisorConfirmReadOnlyEffect(store.asDO(),grant,evidence(effect),1013);
  }
  const j=await inspectSupervisorReadOnlyAdmission(store.asDO(),task.id);
  assert.deepEqual(j?.receipts.map(r=>r.evidence.effect),stages);
  assert.equal(j?.pending,undefined);
  assert.equal((await slotOf(store,grant)).phase,"running");
  assert.equal((await current(store,grant)).operationId,supervisorStartOperationId(task.id));
});
test("wrong imported tree or digest rolls back receipt, slot remains ambiguous",async()=>{
  const {store,grant}=await setup();await verify(store,grant);await advance(store,grant,1);
  await supervisorBeginReadOnlyEffect(store.asDO(),grant,"container_import",1010);
  for(const bad of [{...evidence("container_import"),tree:"e".repeat(40)},{...evidence("container_import"),sha256:"bad"}])
    await assert.rejects(supervisorConfirmReadOnlyEffect(store.asDO(),grant,bad,1011),/IMPORT_RECEIPT_INVALID/);
  assert.equal((await slotOf(store,grant)).phase,"effect_unknown");
  assert.equal((await inspectSupervisorReadOnlyAdmission(store.asDO(),grant.id))?.receipts.length,1);
});
test("loss before/after every RPC: journal survives restart; TTL and duplicate cannot replay",async()=>{
  for(let i=0;i<stages.length;i++){
    const {store,task,grant}=await setup();await verify(store,grant);await advance(store,grant,i);
    const effect=stages[i];await supervisorBeginReadOnlyEffect(store.asDO(),grant,effect,1040);
    const restarted=new DurableFake();restarted.restore(store.snapshot());
    assert.equal((await supervisorRecordReadOnlyFailure(restarted.asDO(),grant,1041))?.status,"unknown");
    const r=await reserveSupervisorAdmission(restarted.asDO(),task,999999,PINS);
    if(r.kind!=="reused")throw Error("ambiguous effect replayed");
    assert.equal(r.reason,"EFFECT_UNCONFIRMED");
    assert.equal((await slotOf(restarted,grant)).effect,effect);
    assert.equal((await inspectSupervisorReadOnlyAdmission(restarted.asDO(),task.id))?.pending?.effect,effect);
    await assert.rejects(supervisorBeginReadOnlyEffect(restarted.asDO(),grant,effect,999999),/FENCE/);
  }
});
test("exact import reconciliation transfers generation and rejects old owner receipts/failure",async()=>{
  const {store,grant}=await setup();await verify(store,grant);await advance(store,grant,1);
  await supervisorBeginReadOnlyEffect(store.asDO(),grant,"container_import",1010);
  const expected=await slotOf(store,grant);
  await assert.rejects(reconcileSupervisorReadOnlyImport(store.asDO(),grant.id,expected,{...evidence("container_import"),tree:"e".repeat(40)},1011),/IMPORT_RECEIPT_INVALID/);
  const r=await reconcileSupervisorReadOnlyImport(store.asDO(),grant.id,expected,evidence("container_import"),1012);
  if(!r)throw Error("missing recovery");
  assert.equal(r.grant.generation,2);
  await assert.rejects(supervisorConfirmReadOnlyEffect(store.asDO(),grant,evidence("container_import"),1013),/FENCE/);
  await supervisorRecordReadOnlyFailure(store.asDO(),grant,1013);
  assert.equal((await current(store,r.grant)).status,"preparing");
  await supervisorBeginReadOnlyEffect(store.asDO(),r.grant,"session_create",1014);
});
test("exact session recovery journals receipt atomically and fences old creator",async()=>{
  const {store,grant}=await setup();await verify(store,grant);await advance(store,grant,2);
  await supervisorBeginReadOnlyEffect(store.asDO(),grant,"session_create",1010);
  assert.equal((await current(store,grant)).sessionCreationAttempted,true);
  const expected=await slotOf(store,grant);
  await assert.rejects(reconcileSupervisorCreatedSession(store.asDO(),grant.id,"ses_wrong",expected,1011),/ID_MISMATCH/);
  const r=await reconcileSupervisorCreatedSession(store.asDO(),grant.id,r2SessionId(grant.id),expected,1012);
  if(r.kind!=="recovered")throw Error("reconcile");
  assert.equal(r.grant.generation,2);
  assert.equal((await inspectSupervisorReadOnlyAdmission(store.asDO(),grant.id))?.receipts.length,3);
  await assert.rejects(supervisorConfirmReadOnlyEffect(store.asDO(),grant,evidence("session_create"),1013),/FENCE/);
  await supervisorRecordReadOnlyFailure(store.asDO(),grant,1013);
  assert.equal((await current(store,r.grant)).session,r2SessionId(grant.id));
});
test("cancellation before or after intent cannot advance and submit acceptance stays ambiguous",async()=>{
  const first=await setup();await verify(first.store,first.grant);
  await first.store.put(supervisorTaskKey(first.grant.id),{...await current(first.store,first.grant),status:"cancel_requested"});
  await assert.rejects(supervisorBeginReadOnlyEffect(first.store.asDO(),first.grant,"project_reserve",1010),/FENCE/);
  const second=await setup();await verify(second.store,second.grant);await advance(second.store,second.grant,6);
  await supervisorBeginReadOnlyEffect(second.store.asDO(),second.grant,"submit",1040);
  await second.store.put(supervisorTaskKey(second.grant.id),{...await current(second.store,second.grant),status:"cancelled"});
  await supervisorConfirmReadOnlyEffect(second.store.asDO(),second.grant,evidence("submit"),1041);
  const t=await current(second.store,second.grant);
  assert.equal(t.status,"cancelled");assert.equal(t.cancelAmbiguous,true);
  await reserveSupervisorAdmission(second.store.asDO(),candidate(2),999999,PINS);
  assert.equal((await slotOf(second.store,second.grant)).phase,"running");
});
test("native submit recovery requires exact ID and positive terminal receipt",async()=>{
  const {store,grant}=await setup();await verify(store,grant);await advance(store,grant,6);
  await supervisorBeginReadOnlyEffect(store.asDO(),grant,"submit",1040);
  assert.equal(await reconcileSupervisorSubmittedEffect(store.asDO(),grant.id,"rc-start-"+id(2),{status:"done"}),false);
  assert.equal(await reconcileSupervisorSubmittedEffect(store.asDO(),grant.id,supervisorStartOperationId(grant.id),{status:"unanswered",reason:"not_found"}),false);
  assert.equal(await reconcileSupervisorSubmittedEffect(store.asDO(),grant.id,supervisorStartOperationId(grant.id),{status:"done"}),true);
  assert.equal((await inspectSupervisorReadOnlyAdmission(store.asDO(),grant.id))?.receipts.at(-1)?.evidence.nativeStatus,"done");
});
test("ten read_only reservations and duplicate calls share global capacity",async()=>{
  const store=new DurableFake();
  const all=await Promise.all(Array.from({length:10},(_,i)=>reserveSupervisorAdmission(store.asDO(),candidate(i+1),1000,PINS)));
  assert.equal(all.filter(r=>r.kind==="granted").length,10);
  const eleventh=await reserveSupervisorAdmission(store.asDO(),candidate(11),1001,PINS);
  assert.equal(eleventh.kind,"capacity");
  assert.equal((await reserveSupervisorAdmission(store.asDO(),candidate(1),1001,PINS)).kind,"reused");
  assert.equal(await store.get(supervisorTaskKey(id(11))),undefined);
});

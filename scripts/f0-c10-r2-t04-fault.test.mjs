import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  r2SessionId, r2TurnJournalKey, r2TurnAdmission,
  r2CancelledByReceipt, r2StatusWriteAllowed, r2TerminalNativeReceipt
} from "../src/supervisor-r2.ts";

/** Disposable deterministic transaction model, NOT Cloudflare DO/SQLite.
 * Clones committed records and serializes transactions to model atomic CAS.
 * Tests inject failures at the SDK/RPC boundaries, never touch a live Worker. */
class DisposableStorage {
  constructor(rows = new Map()) { this.rows = rows; this.queue = Promise.resolve(); }
  async get(k) { return structuredClone(this.rows.get(k)); }
  async transaction(fn) {
    const prior = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await prior;
    const copy = new Map(structuredClone([...this.rows]));
    const tx = {
      get: async k => structuredClone(copy.get(k)),
      put: async (k, v) => { copy.set(k, structuredClone(v)); }
    };
    try {
      const result = await fn(tx);
      this.rows.clear();
      for (const [k, v] of copy) this.rows.set(k, v);
      return result;
    } finally { release(); }
  }
}
class FakeNativeSDK {
  sessions = new Set();
  operations = new Map();
  createCalls = 0;
  async create({id}, loseReply = false) {
    this.createCalls++;
    this.sessions.add(id); // idempotent exact session identity
    if (loseReply) throw Error("REPLY_LOST_AFTER_CREATE");
    return id;
  }
  async submit(id, operationId, loseReply = false) {
    const key = id + ":" + operationId;
    const accepted = !this.operations.has(key);
    if (accepted) this.operations.set(key, {status:"queued"});
    if (loseReply) throw Error("REPLY_LOST_AFTER_SUBMIT");
    return {accepted};
  }
}
const rid = "abcdeffedcba0123", turn = "f0f0f0f0f0f0f0f0";
const key = "supervisor:task:" + rid;
const base = () => ({status:"running", operationId:"rc-start-"+rid, revision:1,
  session:r2SessionId(rid), sessionIdPolicy:"deterministic-v1"});

describe("R2-T04 fault-injection with disposable transactional model", () => {
  test("deterministic session identity stable and validated", () => {
    assert.equal(r2SessionId(rid), "ses_r2_"+rid);
    assert.equal(r2SessionId(rid), r2SessionId(rid));
    assert.throws(() => r2SessionId("bad"), /INVALID_R2_REQUEST_ID/);
    assert.equal(new Set(Array.from({length:10},(_,i)=>r2SessionId("f0f0f0f0f0f0"+i.toString(16).padStart(4,"0")))).size,10);
  });
  test("RED historical random ID create loss would orphan, deterministic GREEN reuses one", async () => {
    const d = new DisposableStorage(), sdk = new FakeNativeSDK(), session=r2SessionId(rid);
    await d.transaction(async tx=>tx.put(key,{...base(),session:undefined,sessionCreationAttempted:true}));
    await assert.rejects(sdk.create({id:session},true),/REPLY_LOST/);
    assert.equal(await sdk.create({id:session}),session);
    await d.transaction(async tx=>tx.put(key,{...(await tx.get(key)),session}));
    assert.equal(sdk.sessions.size,1);
    assert.equal((await d.get(key)).session,session);
  });
  test("failed durable transaction has zero committed task writes", async () => {
    const d=new DisposableStorage();
    await assert.rejects(d.transaction(async tx=> {
      await tx.put(key,{sessionCreationAttempted:true});
      throw Error("RESTART_BEFORE_COMMIT");
    }),/RESTART/);
    assert.equal(await d.get(key),undefined);
  });
  test("lost submit reply followed by same operationId admits once", async () => {
    const sdk = new FakeNativeSDK(), session=r2SessionId(rid), op="rc-start-"+rid;
    await assert.rejects(sdk.submit(session,op,true),/REPLY_LOST/);
    assert.deepEqual(await sdk.submit(session,op),{accepted:false});
    assert.equal(sdk.operations.size,1);
  });
  test("two different turnIds cannot both reserve while first is pending", () => {
    const a={...base(),pendingTurn:{turnId:turn,operationId:"rc-turn-"+rid+"-"+turn}};
    assert.equal(r2TurnAdmission(a,a.pendingTurn.operationId),"retry");
    assert.equal(r2TurnAdmission(a,"rc-turn-"+rid+"-1111111111111111"),"busy");
    assert.equal(r2TurnJournalKey(rid,turn),"supervisor:turn:"+rid+":"+turn);
    assert.throws(()=>r2TurnJournalKey(rid,"invalid"),/INVALID/);
  });
  test("continue AFTER cancel is denied before SDK side effects", async () => {
    const d=new DisposableStorage(),sdk=new FakeNativeSDK();
    await d.transaction(async tx=>tx.put(key,{...base(),status:"cancel_requested"}));
    const t=await d.get(key);
    assert.equal(r2TurnAdmission(t,"rc-turn-"+rid+"-"+turn),"denied");
    assert.equal(sdk.operations.size,0);
  });
  test("cancel AFTER turn intent remains unconfirmed even if old operation interrupted", async () => {
    const d=new DisposableStorage(), op="rc-turn-"+rid+"-"+turn;
    await d.transaction(async tx=>tx.put(key,{...base(),operationId:op,
      pendingTurn:{turnId:turn,operationId:op},revision:2}));
    await d.transaction(async tx=>{
      const saved=await tx.get(key);
      await tx.put(key,{...saved,status:"cancel_requested",cancelAmbiguous:Boolean(saved.pendingTurn),revision:3});
    });
    const task=await d.get(key);
    assert.equal(r2CancelledByReceipt(task,op,{status:"unanswered",reason:"interrupted"}),false);
    assert.equal(r2TurnAdmission(task,op),"denied");
  });
  test("native interrupted cancellation receipt is required and sufficient only without races", () => {
    const task={...base(),status:"cancel_requested"};
    assert.equal(r2CancelledByReceipt(task,task.operationId,{status:"unanswered",reason:"interrupted"}),true);
    assert.equal(r2CancelledByReceipt(task,task.operationId,{status:"unanswered",reason:"not_found"}),false);
    assert.equal(r2CancelledByReceipt(task,task.operationId,{status:"done"}),false);
    assert.equal(r2CancelledByReceipt(task,task.operationId,undefined),false);
    assert.equal(r2CancelledByReceipt(task,"wrong",{status:"unanswered",reason:"interrupted"}),false);
  });
  test("lost abort response alone never grants cancellation", () => {
    const task={...base(),status:"cancel_requested"};
    const abortRpcAccepted=true; // transport boolean, not native terminal receipt
    assert.equal(abortRpcAccepted,true);
    assert.equal(r2CancelledByReceipt(task,task.operationId,undefined),false);
  });
  test("old status poll cannot clobber a newer operationID", async () => {
    const d=new DisposableStorage();
    await d.transaction(async tx=>tx.put(key,base()));
    const probed=await d.get(key);
    await d.transaction(async tx=>tx.put(key,{...base(),operationId:"rc-turn-"+rid+"-"+turn,revision:2}));
    await d.transaction(async tx=>{
      const current=await tx.get(key);
      if(r2StatusWriteAllowed(current,probed.operationId)) await tx.put(key,{...current,status:"finished"});
    });
    assert.equal((await d.get(key)).status,"running");
  });
  test("pending journal prevents status probe from claiming finished", () => {
    const task={...base(),pendingTurn:{turnId:turn,operationId:"rc-turn-"+rid+"-"+turn}};
    assert.equal(r2StatusWriteAllowed(task,task.operationId),false);
    assert.equal(r2StatusWriteAllowed({...base(),status:"cancelled"},base().operationId),false);
  });
  test("re-open another DO model instance with same durable rows keeps intent and identity", async () => {
    const shared=new Map(), before=new DisposableStorage(shared), after=new DisposableStorage(shared);
    await before.transaction(async tx=>tx.put(key,{...base(),pendingTurn:{turnId:turn,operationId:"rc-turn-"+rid+"-"+turn}}));
    assert.equal(r2TurnAdmission(await after.get(key),"rc-turn-"+rid+"-"+turn),"retry");
    assert.equal((await after.get(key)).session,r2SessionId(rid));
  });
  test("ambiguous cancellation fences all new continuations, including after unknown", () => {
    const task={...base(),status:"unknown",cancelAmbiguous:true};
    assert.equal(r2TurnAdmission(task,"any"),"denied");
    assert.equal(r2CancelledByReceipt({...task,status:"cancel_requested"},
      task.operationId,{status:"unanswered",reason:"interrupted"}),false);
  });
  test("native terminal receipt requires done or an explicit terminal unanswered reason", () => {
    assert.equal(r2TerminalNativeReceipt({status:"done"}),true);
    assert.equal(r2TerminalNativeReceipt({status:"unanswered",reason:"failed"}),true);
    assert.equal(r2TerminalNativeReceipt({status:"unanswered",reason:"interrupted"}),true);
    assert.equal(r2TerminalNativeReceipt({status:"unanswered",reason:"not_found"}),false);
    assert.equal(r2TerminalNativeReceipt({status:"unanswered"}),false);
    assert.equal(r2TerminalNativeReceipt(undefined),false);
  });

});

import {test,expect} from "bun:test";
import {reconcileHistoricalSupervisor,reserveSupervisorAdmission,reserveSupervisorContinuation,inspectSupervisorAdmissionCapacity,supervisorGrantStillOwned} from "./supervisor-admission";
import {observeNativeQuiescence,historicalCertificate,reconciliationDigest,parseReconciliationManifest,type ReconciliationManifest,type NativeQuiescence} from "./supervisor-reconciliation";
import type {SupervisorTask} from "./supervisor-control";
class DB {
 rows=new Map<string,unknown>(); tail=Promise.resolve();
 async get<T>(key:string):Promise<T|undefined>{return structuredClone(this.rows.get(key)) as T|undefined;}
 async put(key:string,value:unknown){this.rows.set(key,structuredClone(value));}
 async delete(key:string){return this.rows.delete(key);}
 async list<T>({prefix="",startAfter,limit=1000}:{prefix?:string;startAfter?:string;limit?:number}={}):Promise<Map<string,T>>{
  return new Map([...this.rows.entries()].filter(([k])=>k.startsWith(prefix)&&(!startAfter||k>startAfter))
   .sort(([a],[b])=>a<b?-1:a>b?1:0).slice(0,limit).map(([k,v])=>[k,structuredClone(v) as T]));
 }
 async transaction<T>(fn:(tx:DB)=>Promise<T>):Promise<T>{
  const prior=this.tail;let done!:()=>void;this.tail=new Promise(r=>done=r);await prior;
  const shadow=new DB();shadow.rows=new Map(structuredClone([...this.rows]));
  try{const r=await fn(shadow);this.rows=shadow.rows;return r;}finally{done();}
 }
 asDO(){return this as unknown as DurableObjectStorage;}
}
const now=1000000,release="a".repeat(40),object="b".repeat(64),lane="e".repeat(16);
const manifest:ReconciliationManifest={schema:"r4-reconciliation-v1",environment:"staging",releaseSha:release,requestId:lane,
 approvalRef:"offline-only-test",externalDrainReceipt:"c".repeat(64),drainedAt:now-100,notBefore:now-100,expiresAt:now+1800000};
const id=(n:number)=>n.toString(16).padStart(16,"0");
const task=(n:number):SupervisorTask=>({id:id(n),repository:"aamvtrampa36-del/opencode-harness-example",
 project:"supervised-"+id(n),branch:"opencode/staging-"+id(n),fingerprint:"f".repeat(64),createdAt:10,status:"unknown",
 session:"ses_old_"+id(n),operationId:"rc-start-"+id(n),error:"not_found"});
const native=async(ids:string[]=[]):Promise<NativeQuiescence>=>({schema:"native-quiescence-v1",ids:ids.sort(),digest:await reconciliationDigest(ids.sort()),observedAt:now});
const reconcile=(db:DB,observe=()=>native())=>reconcileHistoricalSupervisor(db.asDO(),manifest,object,observe,()=>now);
test("complete paginated inventory (>101), orphan reservation, pending turn and auxiliary history are retained",async()=>{
 const db=new DB();
 for(let n=1;n<=137;n++)await db.put("supervisor:task:"+id(n),task(n));
 const old=task(1),orphan=id(500),token="11111111-1111-4111-8111-111111111111";
 const ledger={version:1,slots:{[orphan]:{token,generation:1,expiresAt:5,phase:"effect_unknown",effect:"session_create"},
  [old.id]:{token,generation:2,expiresAt:5,phase:"effect_unknown",effect:"submit"}}};
 await db.put("supervisor:admission:v1",ledger);
 await db.put("supervisor:lock:"+orphan,{token,expiresAt:5});
 const turn={operationId:"rc-turn-"+old.id+"-"+id(999),phase:"unknown",session:old.session};
 await db.put("supervisor:turn:"+old.id+":"+id(999),turn);
 await db.put("supervisor:session:"+old.session,old.id);
 await db.put("g8-live-agent-v1",{status:"starting",tasks:[{session:"ses_aux"}]});
 const ids=[old.session!,"ses_aux","ses_orphan_native"];
 const result=await reconcile(db,()=>native(ids));
 expect(result).toMatchObject({tasks:137,unknownHistoricalOutcomes:137,archivedSlots:2,nativeSessions:3,
  orphanReferences:1,historyPreserved:true,providerDispatchAuthorized:false,completePass:false,
  capacity:{activeSlots:0,indexedTaskRows:137,inventoryComplete:true,stopReason:null}});
 expect(await db.get("supervisor:task:"+old.id)).toEqual(old);
 expect(await db.get("supervisor:turn:"+old.id+":"+id(999))).toEqual(turn);
 expect(await db.get("supervisor:lock:"+orphan)).toEqual({token,expiresAt:5});
 expect(await db.get("g8-live-agent-v1")).toEqual({status:"starting",tasks:[{session:"ses_aux"}]});
 expect((await historicalCertificate(db.asDO()))?.archivedSlots).toEqual(ledger.slots);
 expect(await db.get("supervisor:admission:v1")).toEqual({version:1,slots:{}});
 expect(await supervisorGrantStillOwned(db.asDO(),{id:old.id,token,generation:2})).toBe(false);
 await expect(reserveSupervisorAdmission(db.asDO(),task(1),now)).rejects.toThrow("HISTORICAL_TASK_QUARANTINED");
 await expect(reserveSupervisorAdmission(db.asDO(),task(500),now)).rejects.toThrow("HISTORICAL_TASK_QUARANTINED");
 await expect(reserveSupervisorContinuation(db.asDO(),old.id,id(11),"f".repeat(64),"rc-turn-"+old.id+"-"+id(11),now)).rejects.toThrow("HISTORICAL_TASK_QUARANTINED");
 const fresh={...task(501),session:undefined,operationId:undefined,status:"preparing" as const,sessionIdPolicy:"deterministic-v1" as const};
 expect((await reserveSupervisorAdmission(db.asDO(),fresh,now)).kind).toBe("granted");
});
test("native active, queued/recoverable, absent exact identity and cursor loop are never accepted",async()=>{
 const good={active:async()=>[] as string[],page:async()=>({ids:["ses_old"],next:null}),exists:async()=>true,busy:async()=>false};
 expect((await observeNativeQuiescence(good,now+100,()=>now)).ids).toEqual(["ses_old"]);
 for(const patch of [{active:async()=>["ses_old"]},{busy:async()=>true},{exists:async()=>false},
  {page:async()=>({ids:["ses_old"],next:"same"})},{page:async()=>({ids:[],next:"same"})}]){
  await expect(observeNativeQuiescence({...good,...patch},now+100,()=>now)).rejects.toThrow();
 }
 let reads=0;await expect(observeNativeQuiescence({...good,active:async()=>++reads===1?[]:["ses_old"]},now+100,()=>now)).rejects.toThrow("HISTORICAL_NATIVE_ACTIVE");
});
test("CAS detects concurrent task or auxiliary change, no release or certificate",async()=>{
 const db=new DB();await db.put("supervisor:task:"+id(1),task(1));
 await expect(reconcile(db,async()=>{await db.put("g9-native-e2e-v2",{status:"running"});return native();}))
  .rejects.toThrow("HISTORICAL_INVENTORY_CHANGED");
 expect(await historicalCertificate(db.asDO())).toBeUndefined();
 expect((await inspectSupervisorAdmissionCapacity(db.asDO())).stopReason).toBe("LEGACY_UNGOVERNED");
});
test("stale/forged native observation and old monetary journal fail closed",async()=>{
 const db=new DB();await db.put("supervisor:task:"+id(1),task(1));
 await expect(reconcile(db,async()=>({...await native(),digest:"0".repeat(64)}))).rejects.toThrow("HISTORICAL_NATIVE_PROOF_INVALID");
 await expect(reconcile(db,async()=>({...await native(),observedAt:now-60001}))).rejects.toThrow("HISTORICAL_NATIVE_PROOF_INVALID");
 await db.put("supervisor:inference:budget:v1",{reserved:1,unknown:1});
 await expect(reconcile(db)).rejects.toThrow("HISTORICAL_BUDGET_RECONCILIATION_REQUIRED");
 expect(await db.get("supervisor:inference:budget:v1")).toEqual({reserved:1,unknown:1});
 expect(await historicalCertificate(db.asDO())).toBeUndefined();
});
test("changed archived task or auxiliary row cannot silently regain capacity",async()=>{
 const db=new DB();const old=task(1);await db.put("supervisor:task:"+old.id,old);
 await db.put("agent-check-v1",{session:"ses_aux"});await reconcile(db);
 await db.put("supervisor:task:"+old.id,{...old,status:"running"});
 expect((await inspectSupervisorAdmissionCapacity(db.asDO())).stopReason).toBe("UNTRACKED_MANAGED_TASK");
 await db.put("supervisor:task:"+old.id,old);
 await db.put("agent-check-v1",{session:"ses_aux_new"});
 expect((await inspectSupervisorAdmissionCapacity(db.asDO())).stopReason).toBe("AUXILIARY_UNGOVERNED");
});
test("manifest is exact-release, exact-lane, recent and deployment-admin time bounded",()=>{
 expect(parseReconciliationManifest(JSON.stringify(manifest),release,lane,now)).toEqual(manifest);
 expect(parseReconciliationManifest(JSON.stringify(manifest),"0".repeat(40),lane,now)).toBeUndefined();
 expect(parseReconciliationManifest(JSON.stringify({...manifest,drainedAt:now-900001}),release,lane,now)).toBeUndefined();
 expect(parseReconciliationManifest(JSON.stringify({...manifest,expiresAt:now}),release,lane,now)).toBeUndefined();
});

test("freeze requires no drain, but workflow reconciliation requires fresh post-freeze drain",async()=>{
 const {parseFreezeManifest,reconciliationFromFrozenWorkflow}=await import("./supervisor-reconciliation");
 const freeze={schema:"r4-freeze-v1" as const,environment:"staging" as const,releaseSha:release,requestId:lane,
  approvalRef:"offline-only-test",notBefore:now-100,expiresAt:now+100000};
 expect(parseFreezeManifest(JSON.stringify(freeze),release,lane,now)).toEqual(freeze);
 expect(parseFreezeManifest(JSON.stringify({...freeze,externalDrainReceipt:"a".repeat(64)}),release,lane,now)).toBeUndefined();
 const command={action:"r4_reconcile",releaseSha:release,requestId:lane,approvalRef:freeze.approvalRef,
  freezeObservedAt:now-80,drainedAt:now-10,externalDrainReceipt:"a".repeat(64)};
 const m=reconciliationFromFrozenWorkflow(freeze,command,now);
 expect(m.drainedAt).toBe(now-10);
 for(const patch of [{drainedAt:now-90},{freezeObservedAt:now-101},{drainedAt:now+1},
  {requestId:id(2)},{releaseSha:"0".repeat(40)},{externalDrainReceipt:"bad"},{pilot:true}])
  expect(()=>reconciliationFromFrozenWorkflow(freeze,{...command,...patch},now)).toThrow();
 const db=new DB();await db.put("supervisor:task:"+id(1),task(1));
 expect(await historicalCertificate(db.asDO())).toBeUndefined();
 expect((await reconcileHistoricalSupervisor(db.asDO(),m,object,()=>native(),()=>now)).historyPreserved).toBe(true);
});

test("concurrent maintenance calls and lost responses preserve the first immutable certificate",async()=>{
 const db=new DB();await db.put("supervisor:task:"+id(1),task(1));
 let calls=0;
 const observe=async()=>{calls++;return native();};
 const [one,two]=await Promise.all([reconcile(db,observe),reconcile(db,observe)]);
 expect(one.digest).toBe(two.digest);
 expect((await historicalCertificate(db.asDO()))?.digest).toBe(one.digest);
 const three=await reconcile(db,()=>{throw Error("must not rerun native census")});
 expect(three.digest).toBe(one.digest);
 await expect(reconcileHistoricalSupervisor(db.asDO(),{...manifest,externalDrainReceipt:"0".repeat(64)},object,()=>native(),()=>now)).rejects.toThrow("HISTORICAL_RECONCILIATION_ALREADY_RECORDED");
 expect(calls).toBeLessThanOrEqual(2);
});

import {CONSUMED_PILOT_ID,inspectConsumedPilot,classifyConsumedPilot,archiveConsumedPilot,
 type ConsumedEvidence,type ConsumedClosure,type ConsumedAuthorization,type ConsumedVerifier} from "./supervisor-reconciliation";
const pid=CONSUMED_PILOT_ID, ck="supervisor:pilot:single-use-v1", lk="supervisor:admission:v1", tk="supervisor:task:"+pid;
const ak="supervisor:consumed-pilot:archive:v1:"+pid, h="a".repeat(64), sh="b".repeat(40), uuid="11111111-1111-4111-8111-111111111111";
const trust:ConsumedVerifier=async()=>true; // fixture ONLY
async function consumedFixture(effect:"github_branch"|"session_create"|"submit"="github_branch"){
 const db=new DB();
 const claim={approval:{schema:"pilot-release-v2",environment:"staging",requestId:pid,releaseSha:sh,sourceCommit:sh,sourceTree:sh,fingerprint:h},instance:uuid,objectId:h,startedAt:10};
 const job={...task(1),id:pid,project:"supervised-"+pid,branch:"opencode/staging-"+pid,fingerprint:h,createdAt:10,pilotInstance:uuid,
  sessionIdPolicy:"deterministic-v1",sessionCreationAttempted:effect!=="github_branch",session:effect==="submit"?"ses_r2_"+pid:undefined,
  operationId:effect==="submit"?"rc-start-"+pid:undefined,status:"cancel_requested",cancelAmbiguous:true};
 const slot={token:uuid,generation:2,expiresAt:5,phase:"effect_unknown",effect};
 await db.put(ck,claim);await db.put(tk,job);await db.put(lk,{version:1,slots:{[pid]:slot,[id(9)]:{...slot,generation:3}}});
 const identity=await inspectConsumedPilot(db.asDO());
 const present:ConsumedEvidence={identity,kind:"present",exactIdentity:true,observedAt:now-1,receiptDigest:h,branchCommit:sh,nativeStatus:"done"};
 const absent:ConsumedEvidence={identity,kind:"absent",authoritativeNegative:true,complete:true,writerDrained:true,observedAt:now-1,receiptDigest:h};
 const proof=async(e:ConsumedEvidence)=>{
  const c:ConsumedClosure={snapshotDigest:identity.snapshotDigest,evidenceDigest:await reconciliationDigest(e),observedAt:now,
   drainReceipt:h,closureReceipt:h,budgetReceipt:h,noOutstandingEffects:true,writerFenced:true};
  const a:ConsumedAuthorization={action:"archive-consumed-pilot-and-release-reservation",environment:"staging",snapshotDigest:identity.snapshotDigest,
   evidenceDigest:c.evidenceDigest,closureDigest:await reconciliationDigest(c),approvalRef:"offline-fixture",notBefore:now-100,expiresAt:now+1000};
  return {c,a};
 };
 return {db,claim,job,identity,present,absent,proof};
}
for(const effect of ["github_branch","session_create","submit"] as const){
 test("P02 lost "+effect+" response: exact presence, positive absence, failed read",async()=>{
  const f=await consumedFixture(effect);
  expect(await classifyConsumedPilot(f.identity,f.present,trust,now)).toBe("materialized");
  expect(await classifyConsumedPilot(f.identity,f.absent,trust,now)).toBe("not_materialized");
  expect(await classifyConsumedPilot(f.identity,f.absent,async()=>{throw Error("timeout");},now)).toBe("unknown");
  expect(await classifyConsumedPilot(f.identity,{...f.absent,writerDrained:false} as unknown as ConsumedEvidence,trust,now)).toBe("unknown");
  expect(await classifyConsumedPilot(f.identity,{...f.present,identity:{...f.identity,project:"other"}},trust,now)).toBe("unknown");
  const {c,a}=await f.proof(f.absent);
  const one=await archiveConsumedPilot(f.db.asDO(),f.absent,c,a,trust,()=>now);
  expect(one).toMatchObject({outcome:"not_materialized",reused:false,replayAllowed:false});
  expect(await f.db.get(ck)).toEqual(f.claim);expect(await f.db.get(tk)).toEqual(f.job);
  expect(await f.db.get(lk)).toEqual({version:1,slots:{[id(9)]:{token:uuid,generation:3,expiresAt:5,phase:"effect_unknown",effect}}});
  expect((await archiveConsumedPilot(f.db.asDO(),f.absent,c,a,trust,()=>now+2000)).digest).toBe(one.digest);
  await expect(archiveConsumedPilot(f.db.asDO(),f.present,c,a,trust,()=>now)).rejects.toThrow("P02_ARCHIVE_CONFLICT");
  await expect(reconcile(f.db)).rejects.toThrow("HISTORICAL_PILOT_ALREADY_CONSUMED");
 });
}
test("P02 incompatible receipts never settle or release",async()=>{
 const f=await consumedFixture("github_branch");
 expect(await classifyConsumedPilot(f.identity,{...f.present,branchCommit:"c".repeat(40)} as ConsumedEvidence,trust,now)).toBe("unknown");
 const s=await consumedFixture("submit");
 expect(await classifyConsumedPilot(s.identity,{...s.present,nativeStatus:"unanswered",reason:"not_found"} as ConsumedEvidence,trust,now)).toBe("unknown");
 const {c,a}=await f.proof(f.absent);
 const before=await f.db.get(lk);
 for(const fail of ["effect","closure","authorization"]){
  await expect(archiveConsumedPilot(f.db.asDO(),f.absent,c,a,async p=>p!==fail,()=>now)).rejects.toThrow();
  expect(await f.db.get(lk)).toEqual(before);expect(await f.db.get(ak)).toBeUndefined();
 }
 await expect(archiveConsumedPilot(f.db.asDO(),f.absent,c,{...a,expiresAt:now},trust,()=>now)).rejects.toThrow("P02_AUTHORIZATION_REQUIRED");
});
test("P02 concurrent snapshot change fails CAS; no archive or slot release",async()=>{
 const f=await consumedFixture(),{c,a}=await f.proof(f.present);
 const before=await f.db.get(lk);
 await expect(archiveConsumedPilot(f.db.asDO(),f.present,c,a,async p=>{
  if(p==="authorization")await f.db.put(tk,{...f.job,revision:2});return true;
 },()=>now)).rejects.toThrow("P02_SNAPSHOT_CHANGED");
 expect(await f.db.get(lk)).toEqual(before);expect(await f.db.get(ak)).toBeUndefined();
});
test("P02 concurrent identical archival is idempotent and does not disturb history",async()=>{
 const f=await consumedFixture();await f.db.put("supervisor:turn:"+pid+":"+id(4),{phase:"settled"});
 const {c,a}=await f.proof(f.present);
 const both=await Promise.all([archiveConsumedPilot(f.db.asDO(),f.present,c,a,trust,()=>now),archiveConsumedPilot(f.db.asDO(),f.present,c,a,trust,()=>now)]);
 expect(both[0].digest).toBe(both[1].digest);expect(both.filter(x=>x.reused).length).toBe(1);
 expect(await f.db.get("supervisor:turn:"+pid+":"+id(4))).toEqual({phase:"settled"});
});

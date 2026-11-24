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

/**
 * R4 historical quiescence, distinct from a historical success/terminal receipt.
 * Only the frozen Staging supervisor can collect native evidence. No caller can
 * submit an idle flag, delete sessions, rewrite task outcomes or replay effects.
 */
import type {SupervisorTask} from "./supervisor-control";
const ID=/^[a-f0-9]{16}$/, SHA=/^[a-f0-9]{40}$/, HASH=/^[a-f0-9]{64}$/;
const SESSION=/^ses[A-Za-z0-9_]{1,64}$/;
const PAGE=32, MAX_TASKS=1024, MAX_ROWS=4096, MAX_NATIVE=512;
export const HISTORICAL_POINTER="supervisor:historical-quarantine:latest-v1";
const PREFIX="supervisor:historical-quarantine:v1:";
export const HISTORICAL_AUX_KEYS=["agent-check-v1","agent-check-openrouter-bun-v1","g8-live-agent-v1",
  "g9-native-e2e-v2","g9-selfdev-v1"] as const;
const AUX_PROOF_KEYS=[...HISTORICAL_AUX_KEYS,"agent-check-result-v1","agent-check-openrouter-bun-result-v1"];
const PREFIXES=["supervisor:task:","supervisor:turn:","supervisor:session:","supervisor:lock:",
  "supervisor:read-only-start:v1:","g8-scope:"];
type Reader=Pick<DurableObjectStorage,"get"|"list">;
function require(v:unknown,label:string):asserts v{if(!v)throw Error(label);}
const hex=(v:unknown,n:number)=>typeof v==="string"&&v.length===n&&/^[a-f0-9]+$/.test(v);
const canonical=(x:unknown):unknown=>{
 if(Array.isArray(x))return x.map(canonical);
 if(x&&typeof x==="object")return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical((x as Record<string,unknown>)[k])]));
 return x;
};
export async function reconciliationDigest(x:unknown):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify(canonical(x)));
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
}
/** A deployment-admin freeze grants NO reconciliation or inference authority.
 * Its expiry never automatically reopens admission; the lane remains locked
 * until a separately authorized version change. */
export type FreezeManifest={schema:"r4-freeze-v1";environment:"staging";releaseSha:string;
 requestId:string;approvalRef:string;notBefore:number;expiresAt:number};
export function parseFreezeManifest(raw:unknown,release:string,lane:string,now=Date.now()):FreezeManifest|undefined{
 if(typeof raw!=="string"||raw.length>4096||!SHA.test(release)||!ID.test(lane))return;
 try{
  const m=JSON.parse(raw) as FreezeManifest;
  if(m?.schema!=="r4-freeze-v1"||m.environment!=="staging"||m.releaseSha!==release||m.requestId!==lane||
    Object.keys(m).sort().join(",")!=="approvalRef,environment,expiresAt,notBefore,releaseSha,requestId,schema"||
    typeof m.approvalRef!=="string"||m.approvalRef.length<8||m.approvalRef.length>160||
    ![m.notBefore,m.expiresAt].every(Number.isSafeInteger)||m.notBefore<0||m.notBefore>now||
    m.expiresAt<=now||m.expiresAt>now+60*60_000)return;
  return m;
 }catch{return undefined;}
}
export type DrainCommand={action:"r4_reconcile";releaseSha:string;requestId:string;approvalRef:string;
 freezeObservedAt:number;drainedAt:number;externalDrainReceipt:string};
export function reconciliationFromFrozenWorkflow(freeze:FreezeManifest,raw:unknown,now=Date.now()):ReconciliationManifest{
 require(parseFreezeManifest(JSON.stringify(freeze),freeze.releaseSha,freeze.requestId,now),"HISTORICAL_FREEZE_REQUIRED");
 const c=raw as DrainCommand;
 require(c&&typeof c==="object"&&Object.keys(c).sort().join(",")===
  "action,approvalRef,drainedAt,externalDrainReceipt,freezeObservedAt,releaseSha,requestId"&&
  c.action==="r4_reconcile"&&c.releaseSha===freeze.releaseSha&&c.requestId===freeze.requestId&&c.approvalRef===freeze.approvalRef&&
  Number.isSafeInteger(c.freezeObservedAt)&&Number.isSafeInteger(c.drainedAt)&&c.freezeObservedAt>=freeze.notBefore&&
  c.drainedAt>=c.freezeObservedAt&&c.drainedAt<=now&&now-c.drainedAt<=15*60_000&&
  typeof c.externalDrainReceipt==="string"&&HASH.test(c.externalDrainReceipt),"HISTORICAL_POST_FREEZE_DRAIN_REQUIRED");
 const m:ReconciliationManifest={schema:"r4-reconciliation-v1",environment:"staging",releaseSha:freeze.releaseSha,
  requestId:freeze.requestId,approvalRef:freeze.approvalRef,notBefore:freeze.notBefore,expiresAt:freeze.expiresAt,
  drainedAt:c.drainedAt,externalDrainReceipt:c.externalDrainReceipt};
 require(parseReconciliationManifest(JSON.stringify(m),m.releaseSha,m.requestId,now),"HISTORICAL_POST_FREEZE_DRAIN_REQUIRED");
 return m;
}
export type ReconciliationManifest={schema:"r4-reconciliation-v1";environment:"staging";releaseSha:string;
 requestId:string;approvalRef:string;externalDrainReceipt:string;drainedAt:number;notBefore:number;expiresAt:number};
export function parseReconciliationManifest(raw:unknown,release:string,lane:string,now=Date.now()):ReconciliationManifest|undefined{
 if(typeof raw!=="string"||raw.length>4096||!SHA.test(release)||!ID.test(lane))return;
 try{
  const m=JSON.parse(raw) as ReconciliationManifest;
  if(m?.schema!=="r4-reconciliation-v1"||m.environment!=="staging"||m.releaseSha!==release||m.requestId!==lane||
    typeof m.approvalRef!=="string"||m.approvalRef.length<8||m.approvalRef.length>160||
    typeof m.externalDrainReceipt!=="string"||!HASH.test(m.externalDrainReceipt)||
    ![m.drainedAt,m.notBefore,m.expiresAt].every(Number.isSafeInteger)||m.drainedAt<0||
    m.drainedAt>now||now-m.drainedAt>15*60_000||m.notBefore>now||m.notBefore<0||
    m.expiresAt<=now||m.expiresAt>now+60*60_000)return;
  return m;
 }catch{return undefined;}
}
export async function* historicalPages<T>(reader:Reader,prefix:string,max=MAX_ROWS):AsyncGenerator<[string,T]>{
 let after:string|undefined,total=0;
 for(;;){
  const rows=await reader.list<T>({prefix,limit:PAGE,...(after?{startAfter:after}:{})});
  require(rows.size<=PAGE,"HISTORICAL_PAGE_OVERSIZED");
  for(const [key,value] of rows){
   require(key.startsWith(prefix)&&(!after||key>after),"HISTORICAL_CURSOR_INVALID");
   after=key;require(++total<=max,"HISTORICAL_INVENTORY_LIMIT");yield [key,value];
  }
  if(rows.size<PAGE)return;
 }
}
export type HistoricalSnapshot={digest:string;taskDigests:Record<string,string>;auxDigests:Record<string,string>;
 ids:string[];sessionIds:string[];rows:number;tasks:number;unknownTasks:number;orphanReferences:number};
export async function captureHistoricalSnapshot(reader:Reader):Promise<HistoricalSnapshot>{
 const entries:[string,string][]=[];const taskDigests:Record<string,string>={},auxDigests:Record<string,string>={};
 const ids=new Set<string>(),sessions=new Set<string>();let unknownTasks=0;
 const add=(key:string,digest:string)=>{require(entries.length<MAX_ROWS,"HISTORICAL_INVENTORY_LIMIT");entries.push([key,digest]);};
 for(const prefix of PREFIXES){
  for await(const [key,value] of historicalPages<unknown>(reader,prefix,prefix==="supervisor:task:"?MAX_TASKS:MAX_ROWS)){
   const d=await reconciliationDigest(value);add(key,d);
   const tail=key.slice(prefix.length);
   if(prefix==="supervisor:task:"){
    const task=value as SupervisorTask;
    require(ID.test(tail)&&task?.id===tail,"HISTORICAL_TASK_INVALID");
    taskDigests[tail]=d;ids.add(tail);
    if(task.session!==undefined&&task.session!==null){require(SESSION.test(task.session),"HISTORICAL_SESSION_INVALID");sessions.add(task.session);}
    if(!["finished","failed","cancelled","unanswered"].includes(task.status)||task.pendingTurn||task.cancelAmbiguous)unknownTasks++;
   }else if(prefix==="supervisor:session:"){
    require(SESSION.test(tail)&&typeof value==="string"&&ID.test(value),"HISTORICAL_SESSION_MAPPING_INVALID");
    sessions.add(tail);ids.add(value);
   }else if(prefix==="g8-scope:"){
    require(SESSION.test(tail),"HISTORICAL_SCOPE_INVALID");sessions.add(tail);
   }else{
    const id=tail.split(":")[0];require(ID.test(id),"HISTORICAL_JOURNAL_ID_INVALID");ids.add(id);
   }
  }
 }
 for(const key of AUX_PROOF_KEYS){
  const value=await reader.get(key);
  if(value!==undefined){
   const d=await reconciliationDigest(value);add(key,d);auxDigests[key]=d;
   const a=value as {session?:unknown;tasks?:unknown};
   if(typeof a?.session==="string"&&SESSION.test(a.session))sessions.add(a.session);
   if(Array.isArray(a?.tasks))for(const t of a.tasks)if(typeof t?.session==="string"&&SESSION.test(t.session))sessions.add(t.session);
  }
 }
 require(ids.size<=MAX_TASKS&&sessions.size<=MAX_ROWS,"HISTORICAL_INVENTORY_LIMIT");
 const taskIds=Object.keys(taskDigests);
 return {digest:await reconciliationDigest(entries),taskDigests,auxDigests,ids:[...ids].sort(),sessionIds:[...sessions].sort(),
  rows:entries.length,tasks:taskIds.length,unknownTasks,orphanReferences:[...ids].filter(id=>!Object.hasOwn(taskDigests,id)).length};
}
export type NativePage={ids:string[];next?:string|null};
export type NativeQuiescence={schema:"native-quiescence-v1";ids:string[];digest:string;observedAt:number};
export async function observeNativeQuiescence(read:{
 active:()=>Promise<string[]>;page:(cursor?:string)=>Promise<NativePage>;
 exists:(id:string)=>Promise<boolean>;busy:(id:string)=>Promise<boolean>;
},deadline:number,clock=Date.now):Promise<NativeQuiescence>{
 const check=()=>require(clock()<deadline,"HISTORICAL_NATIVE_PROBE_DEADLINE");
 check();require((await read.active()).length===0,"HISTORICAL_NATIVE_ACTIVE");
 const ids=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined;
 for(;;){
  check();const p=await read.page(cursor);check();
  require(Array.isArray(p.ids)&&p.ids.length<=100,"HISTORICAL_NATIVE_PAGE_INVALID");
  for(const id of p.ids){
   check();require(SESSION.test(id)&&!ids.has(id)&&ids.size<MAX_NATIVE,"HISTORICAL_NATIVE_INVENTORY_INVALID");
   ids.add(id);
   // A session handle itself does not prove existence. Exact SDK GET must
   // succeed; busy() includes active, inbox and unsettled-on-restart work.
   require(await read.exists(id)===true,"HISTORICAL_NATIVE_IDENTITY_UNKNOWN");
   require(await read.busy(id)===false,"HISTORICAL_NATIVE_BUSY_OR_UNKNOWN");
  }
  if(p.next===undefined||p.next===null)break;
  require(typeof p.next==="string"&&p.next.length>0&&p.next.length<=4096&&!cursors.has(p.next)&&p.ids.length>0,
    "HISTORICAL_NATIVE_CURSOR_INVALID");cursors.add(p.next);cursor=p.next;
  require(cursors.size<=MAX_NATIVE,"HISTORICAL_NATIVE_INVENTORY_INVALID");
 }
 check();require((await read.active()).length===0,"HISTORICAL_NATIVE_ACTIVE");check();
 const ordered=[...ids].sort();
 return {schema:"native-quiescence-v1",ids:ordered,digest:await reconciliationDigest(ordered),observedAt:clock()};
}
export async function validNativeQuiescence(n:NativeQuiescence,now:number,minAt=0):Promise<boolean>{
 return !!n&&n.schema==="native-quiescence-v1"&&Number.isSafeInteger(n.observedAt)&&n.observedAt>=minAt&&
  n.observedAt<=now&&now-n.observedAt<=60_000&&Array.isArray(n.ids)&&n.ids.length<=MAX_NATIVE&&
  n.ids.every(id=>SESSION.test(id))&&new Set(n.ids).size===n.ids.length&&
  await reconciliationDigest([...n.ids].sort())===n.digest;
}
export type HistoricalCertificate={schema:"r4-historical-quarantine-v1";manifest:ReconciliationManifest;
 supervisorObject:string;observedAt:number;nativeDigest:string;nativeSessions:number;missingReferencedSessions:number;
 snapshotDigest:string;taskDigests:Record<string,string>;auxDigests:Record<string,string>;retiredIds:string[];
 archivedSlots:Record<string,unknown>;rows:number;tasks:number;unknownTasks:number;orphanReferences:number;digest:string};
export async function historicalCertificate(reader:Pick<Reader,"get">):Promise<HistoricalCertificate|undefined>{
 const pointer=await reader.get<string>(HISTORICAL_POINTER);
 if(pointer===undefined)return;
 require(typeof pointer==="string"&&HASH.test(pointer),"HISTORICAL_CERTIFICATE_CORRUPT");
 const cert=await reader.get<HistoricalCertificate>(PREFIX+pointer);
 require(cert?.schema==="r4-historical-quarantine-v1"&&cert.digest===pointer&&Array.isArray(cert.retiredIds)&&
   cert.retiredIds.length<=MAX_TASKS&&cert.retiredIds.every(id=>ID.test(id))&&cert.taskDigests&&cert.auxDigests,
   "HISTORICAL_CERTIFICATE_CORRUPT");
 const {digest,...body}=cert;
 require(await reconciliationDigest(body)===digest,"HISTORICAL_CERTIFICATE_CORRUPT");return cert;
}
export async function retiredHistoricalTask(reader:Pick<Reader,"get">,id:string):Promise<boolean>{
 if((await historicalCertificate(reader))?.retiredIds.includes(id))return true;
 if(id!==CONSUMED_PILOT_ID||await reader.get(CONSUMED_ARCHIVE_KEY)===undefined)return false;
 const ledger=await reader.get<ConsumedLedger>(CONSUMED_LEDGER_KEY);
 require(ledger?.version===1&&ledger.slots&&typeof ledger.slots==="object"&&!Array.isArray(ledger.slots),"P03_CONSUMED_ARCHIVE_INVALID");
 return consumedArchiveExempts(reader,ledger.slots);
}
export async function writeHistoricalCertificate(tx:DurableObjectTransaction,manifest:ReconciliationManifest,objectId:string,
 snap:HistoricalSnapshot,native:NativeQuiescence,slots:Record<string,unknown>,now=Date.now()):Promise<HistoricalCertificate>{
 require(parseReconciliationManifest(JSON.stringify(manifest),manifest.releaseSha,manifest.requestId,now)&&hex(objectId,64),
   "HISTORICAL_MAINTENANCE_AUTHORIZATION_REQUIRED");
 require(await validNativeQuiescence(native,now,manifest.drainedAt),"HISTORICAL_NATIVE_PROOF_INVALID");
 const prior=await historicalCertificate(tx);
 const retiredIds=[...new Set([...snap.ids,...Object.keys(slots),...(prior?.retiredIds??[])])].sort();
 require(retiredIds.length<=MAX_TASKS&&retiredIds.every(id=>ID.test(id))&&!retiredIds.includes(manifest.requestId),
   "HISTORICAL_PILOT_ID_ALREADY_USED");
 const known=new Set(native.ids);
 require(!known.has("ses_r2_"+manifest.requestId),"HISTORICAL_PILOT_SESSION_ALREADY_USED");
 const body:Omit<HistoricalCertificate,"digest">={schema:"r4-historical-quarantine-v1",manifest,supervisorObject:objectId,
   observedAt:native.observedAt,nativeDigest:native.digest,nativeSessions:native.ids.length,
   missingReferencedSessions:snap.sessionIds.filter(id=>!known.has(id)).length,snapshotDigest:snap.digest,
   taskDigests:snap.taskDigests,auxDigests:snap.auxDigests,retiredIds,archivedSlots:slots,
   rows:snap.rows,tasks:snap.tasks,unknownTasks:snap.unknownTasks,orphanReferences:snap.orphanReferences};
 const cert={...body,digest:await reconciliationDigest(body)};
 // Preserve prior certificates and original slot token/generation/effect;
 // remove only accounting ownership from the active ledger, never history.
 require(new TextEncoder().encode(JSON.stringify(cert)).length<=120*1024,"HISTORICAL_CERTIFICATE_LIMIT");
 if(await tx.get(PREFIX+cert.digest)===undefined)await tx.put(PREFIX+cert.digest,cert);
 await tx.put(HISTORICAL_POINTER,cert.digest);return cert;
}
export function publicHistoricalCertificate(c:HistoricalCertificate){
 return {schema:c.schema,digest:c.digest,releaseSha:c.manifest.releaseSha,requestId:c.manifest.requestId,
  observedAt:c.observedAt,nativeSessions:c.nativeSessions,missingReferencedSessions:c.missingReferencedSessions,
  rows:c.rows,tasks:c.tasks,unknownHistoricalOutcomes:c.unknownTasks,orphanReferences:c.orphanReferences,
  retiredTaskIds:c.retiredIds.length,archivedSlots:Object.keys(c.archivedSlots).length,historyPreserved:true,
  scope:"fixed-supervisor-do-only",historicalOutcomesResolved:false,providerDispatchAuthorized:false,completePass:false};
}

/** Metralla P02: one consumed pilot only. No HTTP route, RPC, provider dispatch
 * or replay. M09 must supply server-owned verifiers after independently draining
 * writers. Evidence digests bind exact observations; hashes alone are not proof.
 * External verifiers run OUTSIDE the DO transaction; the final snapshot CAS and
 * archive/ledger mutation share a transaction. No second scheduler or ledger. */
import type {PilotClaim} from "./pilot-authorization";
import type {AdmissionSlot} from "./supervisor-admission";
import {r2SessionId,r2TerminalNativeReceipt} from "./supervisor-r2";
export const CONSUMED_PILOT_ID="42574cb3f5ee0cbf";
const CONSUMED_CLAIM_KEY="supervisor:pilot:single-use-v1";
const CONSUMED_LEDGER_KEY="supervisor:admission:v1";
const CONSUMED_TASK_KEY="supervisor:task:"+CONSUMED_PILOT_ID;
const CONSUMED_ARCHIVE_KEY="supervisor:consumed-pilot:archive:v1:"+CONSUMED_PILOT_ID;
type ConsumedEffect="github_branch"|"session_create"|"submit";
type ConsumedLedger={version:1;slots:Record<string,AdmissionSlot>};
type ConsumedSnapshot={claim:PilotClaim;task:SupervisorTask;slot:AdmissionSlot;contextDigest:string};
export type ConsumedIdentity={requestId:string;repository:string;project:string;branch:string;sessionId:string;operationId:string;
 objectId:string;releaseSha:string;sourceCommit:string;sourceTree:string;effect:ConsumedEffect;snapshotDigest:string};
export type ConsumedEvidence={identity:ConsumedIdentity;observedAt:number;receiptDigest:string}&(
 {kind:"unavailable"}|{kind:"absent";authoritativeNegative:true;complete:true;writerDrained:true}|
 {kind:"present";exactIdentity:true;branchCommit?:string;nativeStatus?:"done"|"unanswered";reason?:string});
export type ConsumedClosure={snapshotDigest:string;evidenceDigest:string;observedAt:number;drainReceipt:string;closureReceipt:string;
 budgetReceipt:string;noOutstandingEffects:true;writerFenced:true};
export type ConsumedAuthorization={action:"archive-consumed-pilot-and-release-reservation";environment:"staging";
 snapshotDigest:string;evidenceDigest:string;closureDigest:string;approvalRef:string;notBefore:number;expiresAt:number};
export type ConsumedArchive={schema:"metralla-consumed-pilot-v1";identity:ConsumedIdentity;snapshot:ConsumedSnapshot;
 evidence:ConsumedEvidence;closure:ConsumedClosure;authorization:ConsumedAuthorization;
 outcome:"materialized"|"not_materialized";replayAllowed:false;digest:string};
export type ConsumedVerifier=(purpose:"effect"|"closure"|"authorization",value:ConsumedEvidence|ConsumedClosure|ConsumedAuthorization)=>Promise<boolean>;
const consumedFresh=(t:number,now:number)=>Number.isSafeInteger(now)&&Number.isSafeInteger(t)&&t>=0&&t<=now&&now-t<=60_000;
const consumedUuid=(x:unknown)=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
async function consumedLoad(tx:Pick<DurableObjectTransaction,"get">){
 const claim=await tx.get<PilotClaim>(CONSUMED_CLAIM_KEY),task=await tx.get<SupervisorTask>(CONSUMED_TASK_KEY);
 const ledger=await tx.get<ConsumedLedger>(CONSUMED_LEDGER_KEY);
 require(claim&&task&&ledger?.version===1&&ledger.slots&&typeof ledger.slots==="object"&&!Array.isArray(ledger.slots)&&
  Object.keys(ledger.slots).length<=10&&Object.keys(ledger.slots).every(k=>ID.test(k)),"P02_LEDGER_OR_CLAIM_INVALID");
 const archive=await tx.get<ConsumedArchive>(CONSUMED_ARCHIVE_KEY);
 const contextDigest=await reconciliationDigest({
  historicalPointer:await tx.get(HISTORICAL_POINTER)??null,
  budget:await tx.get("supervisor:inference:budget:v1")??null,
  lock:await tx.get("supervisor:lock:"+CONSUMED_PILOT_ID)??null,
  sessionOwner:await tx.get("supervisor:session:"+r2SessionId(CONSUMED_PILOT_ID))??null
 });
 return {claim,task,ledger,archive,contextDigest};
}
async function consumedIdentity(s:ConsumedSnapshot):Promise<ConsumedIdentity>{
 const {claim:c,task:t,slot}=s,a=c.approval,id=CONSUMED_PILOT_ID;
 require(a?.schema==="pilot-release-v2"&&a.environment==="staging"&&a.requestId===id&&t.id===id&&
  t.repository==="aamvtrampa36-del/opencode-harness-example"&&t.branch==="opencode/staging-"+id&&t.project==="supervised-"+id&&
  t.fingerprint===a.fingerprint&&hex(a.fingerprint,64)&&hex(c.objectId,64)&&hex(a.releaseSha,40)&&hex(a.sourceCommit,40)&&hex(a.sourceTree,40)&&
  t.createdAt===c.startedAt&&t.pilotInstance===c.instance&&consumedUuid(c.instance)&&t.sessionIdPolicy==="deterministic-v1"&&!t.forkedFrom&&!t.mode,
  "P02_CLAIM_IDENTITY");
 require(slot?.phase==="effect_unknown"&&consumedUuid(slot.token)&&Number.isSafeInteger(slot.generation)&&slot.generation>0&&
  Number.isSafeInteger(slot.expiresAt)&&(slot.effect==="github_branch"||slot.effect==="session_create"||slot.effect==="submit"),"P02_SLOT_IDENTITY");
 const sessionId=r2SessionId(id),operationId="rc-start-"+id;
 require(["unknown","cancel_requested","preparing"].includes(t.status)&&!t.pendingTurn&&(!t.session||t.session===sessionId)&&
  (!t.operationId||t.operationId===operationId),"P02_TASK_CURSOR");
 require(slot.effect!=="github_branch"||(!t.session&&!t.operationId&&t.sessionCreationAttempted===false),"P02_BRANCH_CURSOR");
 require(slot.effect!=="session_create"||(t.sessionCreationAttempted===true&&!t.operationId),"P02_SESSION_CURSOR");
 require(slot.effect!=="submit"||(t.session===sessionId&&t.operationId===operationId),"P02_SUBMIT_CURSOR");
 return {requestId:id,repository:t.repository,project:t.project,branch:t.branch,sessionId,operationId,objectId:c.objectId,
  releaseSha:a.releaseSha,sourceCommit:a.sourceCommit,sourceTree:a.sourceTree,effect:slot.effect,snapshotDigest:await reconciliationDigest(s)};
}
export async function inspectConsumedPilot(storage:DurableObjectStorage):Promise<ConsumedIdentity>{
 return storage.transaction(async tx=>{
  const r=await consumedLoad(tx);require(!r.archive,"P02_ALREADY_ARCHIVED");
  return consumedIdentity({claim:r.claim,task:r.task,slot:r.ledger.slots[CONSUMED_PILOT_ID],contextDigest:r.contextDigest});
 });
}
async function consumedTrusted(verify:ConsumedVerifier,purpose:Parameters<ConsumedVerifier>[0],value:Parameters<ConsumedVerifier>[1]){
 try{return await verify(purpose,structuredClone(value))===true;}catch{return false;}
}
export async function classifyConsumedPilot(i:ConsumedIdentity,e:ConsumedEvidence,verify:ConsumedVerifier,now:number):
 Promise<"materialized"|"not_materialized"|"unknown">{
 if(!e||await reconciliationDigest(e.identity)!==await reconciliationDigest(i)||!consumedFresh(e.observedAt,now)||
  !hex(e.receiptDigest,64)||e.kind==="unavailable"||!await consumedTrusted(verify,"effect",e))return "unknown";
 if(e.kind==="absent")return e.authoritativeNegative===true&&e.complete===true&&e.writerDrained===true?"not_materialized":"unknown";
 if(e.kind!=="present"||e.exactIdentity!==true||e.reason==="not_found")return "unknown";
 if(i.effect==="github_branch"&&e.branchCommit!==i.sourceCommit)return "unknown";
 if(i.effect==="submit"&&(!e.nativeStatus||!r2TerminalNativeReceipt({status:e.nativeStatus,reason:e.reason})))return "unknown";
 return "materialized";
}
function consumedWindow(a:ConsumedAuthorization,now:number){
 return a.action==="archive-consumed-pilot-and-release-reservation"&&a.environment==="staging"&&
  Number.isSafeInteger(a.notBefore)&&Number.isSafeInteger(a.expiresAt)&&a.notBefore>=0&&a.notBefore<=now&&now<a.expiresAt&&
  a.expiresAt-now<=3600_000&&typeof a.approvalRef==="string"&&a.approvalRef.length>=8&&a.approvalRef.length<=160;
}
/** Private receipt, not a public payload: contains original claim and fencing token.
 * Idempotent after a lost transaction response; conflicting receipt fails closed.
 * P03 must retain consumed-ID prohibition and honor the archived digest in admission;
 * releasing accounting ownership is not proof of successful pilot or runtime closure. */
export async function archiveConsumedPilot(storage:DurableObjectStorage,evidence:ConsumedEvidence,closure:ConsumedClosure,
 authorization:ConsumedAuthorization,verify:ConsumedVerifier,clock=Date.now):Promise<{digest:string;outcome:ConsumedArchive["outcome"];reused:boolean;replayAllowed:false}>{
 const e=structuredClone(evidence),c=structuredClone(closure),a=structuredClone(authorization),id=CONSUMED_PILOT_ID;
 const same=async(x:unknown,y:unknown)=>await reconciliationDigest(x)===await reconciliationDigest(y);
 const replay=async(r:Awaited<ReturnType<typeof consumedLoad>>)=>{
  if(!r.archive)return;
  const {digest,...body}=r.archive;
  require(body.schema==="metralla-consumed-pilot-v1"&&body.replayAllowed===false&&hex(digest,64)&&digest===await reconciliationDigest(body)&&
   !r.ledger.slots[id]&&await same(r.claim,body.snapshot.claim)&&await same(r.task,body.snapshot.task)&&
   await same(e,body.evidence)&&await same(c,body.closure)&&await same(a,body.authorization),"P02_ARCHIVE_CONFLICT");
  return {digest,outcome:body.outcome,reused:true,replayAllowed:false as const};
 };
 const before=await storage.transaction(consumedLoad),old=await replay(before);if(old)return old;
 const s={claim:before.claim,task:before.task,slot:before.ledger.slots[id],contextDigest:before.contextDigest};
 const i=await consumedIdentity(s),now=clock(),outcome=await classifyConsumedPilot(i,e,verify,now);
 require(outcome!=="unknown","P02_EFFECT_UNKNOWN");
 const ed=await reconciliationDigest(e),cd=await reconciliationDigest(c);
 require(c.snapshotDigest===i.snapshotDigest&&c.evidenceDigest===ed&&consumedFresh(c.observedAt,now)&&c.observedAt>=e.observedAt&&
  [c.drainReceipt,c.closureReceipt,c.budgetReceipt].every(x=>hex(x,64))&&c.noOutstandingEffects===true&&c.writerFenced===true&&
  await consumedTrusted(verify,"closure",c),"P02_CLOSURE_REQUIRED");
 require(consumedWindow(a,now)&&a.snapshotDigest===i.snapshotDigest&&a.evidenceDigest===ed&&a.closureDigest===cd&&
  await consumedTrusted(verify,"authorization",a),"P02_AUTHORIZATION_REQUIRED");
 const body:Omit<ConsumedArchive,"digest">={schema:"metralla-consumed-pilot-v1",identity:i,snapshot:s,evidence:e,closure:c,authorization:a,outcome,replayAllowed:false};
 const digest=await reconciliationDigest(body),archive={...body,digest};
 require(new TextEncoder().encode(JSON.stringify(archive)).length<=120*1024,"P02_ARCHIVE_LIMIT");
 return storage.transaction(async tx=>{
  const r=await consumedLoad(tx),prior=await replay(r);if(prior)return prior;
  require(consumedWindow(a,clock())&&consumedFresh(e.observedAt,clock())&&consumedFresh(c.observedAt,clock()),"P02_PROOF_EXPIRED");
  require(await same(s,{claim:r.claim,task:r.task,slot:r.ledger.slots[id],contextDigest:r.contextDigest}),"P02_SNAPSHOT_CHANGED");
  const slots={...r.ledger.slots};delete slots[id];
  await tx.put(CONSUMED_ARCHIVE_KEY,archive);
  await tx.put(CONSUMED_LEDGER_KEY,{...r.ledger,slots});
  return {digest,outcome,reused:false,replayAllowed:false};
 });
}

/** P02 archive is private, immutable accounting evidence. Never infer an
 * exemption from terminal text, age, or a missing slot alone. */
export async function consumedArchiveExempts(tx:Pick<DurableObjectStorage,"get">,slots:Record<string,unknown>):Promise<boolean>{
  const id=CONSUMED_PILOT_ID;
  const archive=await tx.get<ConsumedArchive>("supervisor:consumed-pilot:archive:v1:"+id);
  if(archive===undefined)return false;
  if(!archive||typeof archive!=="object")throw Error("P03_CONSUMED_ARCHIVE_INVALID");
  const {digest,...body}=archive;
  const task=await tx.get<SupervisorTask>("supervisor:task:"+id);
  const claim=await tx.get("supervisor:pilot:single-use-v1");
  if(!task||!claim||Object.hasOwn(slots,id)||body.schema!=="metralla-consumed-pilot-v1"||body.replayAllowed!==false||
    body.identity?.requestId!==id||body.snapshot?.task?.id!==id||body.snapshot?.claim?.approval?.requestId!==id||
    body.snapshot?.slot?.phase!=="effect_unknown"||body.closure?.noOutstandingEffects!==true||body.closure?.writerFenced!==true||
    !["materialized","not_materialized"].includes(body.outcome)||typeof digest!=="string"||!/^[a-f0-9]{64}$/.test(digest)||
    await reconciliationDigest(body)!==digest||await reconciliationDigest(task)!==await reconciliationDigest(body.snapshot.task)||
    await reconciliationDigest(claim)!==await reconciliationDigest(body.snapshot.claim))throw Error("P03_CONSUMED_ARCHIVE_INVALID");
  return true;
}


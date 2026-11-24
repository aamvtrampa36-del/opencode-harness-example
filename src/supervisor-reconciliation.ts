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
 return (await historicalCertificate(reader))?.retiredIds.includes(id)??false;
}
export async function writeHistoricalCertificate(tx:DurableObjectTransaction,manifest:ReconciliationManifest,objectId:string,
 snap:HistoricalSnapshot,native:NativeQuiescence,slots:Record<string,unknown>,now=Date.now()):Promise<HistoricalCertificate>{
 require(parseReconciliationManifest(JSON.stringify(manifest),manifest.releaseSha,manifest.requestId,now)&&hex(objectId,64),
   "HISTORICAL_MAINTENANCE_AUTHORIZATION_REQUIRED");
 require(native.schema==="native-quiescence-v1"&&native.observedAt>=manifest.drainedAt&&native.observedAt<=now&&
   now-native.observedAt<=60_000&&Array.isArray(native.ids)&&native.ids.length<=MAX_NATIVE&&native.ids.every(id=>SESSION.test(id))&&
   new Set(native.ids).size===native.ids.length&&await reconciliationDigest([...native.ids].sort())===native.digest,
   "HISTORICAL_NATIVE_PROOF_INVALID");
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

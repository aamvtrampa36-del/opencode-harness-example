import type { SupervisorTask } from "./supervisor-control";
import { eventProjection, directoryProjection, type EventRow, type ProjectedSource, type Scope } from "./metralla-m02-projection";
const PREFIX="supervisor:projection:v1:task:";
const EVENT="supervisor:projection:v1:event:";
const MAX_EVENTS=512;
const ID=/^[a-f0-9]{16}$/;
const SESSION=/^ses[A-Za-z0-9_]{1,64}$/;
const STATUS=new Set(["preparing","running","finished","failed","unanswered","cancel_requested","cancelled","unknown"]);
const natural=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
export type TaskProjection={id:string;session:string|null;status:SupervisorTask["status"];createdAt:number;revision:number;seq:number;coverage:boolean};
type Read=Pick<DurableObjectTransaction,"get">;
type Write=Pick<DurableObjectTransaction,"get"|"put">;
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
function key(id:string){check(ID.test(id),"PROJECTION_TASK_ID");return PREFIX+id;}
function eventKey(id:string,seq:number){return EVENT+id+":"+String(seq).padStart(6,"0");}
function decode(x:unknown,id:string):TaskProjection{
 const p=x as TaskProjection;
 check(p&&Object.keys(p).length===7&&p.id===id&&natural(p.createdAt)&&natural(p.revision)&&natural(p.seq)&&p.seq<=MAX_EVENTS&&typeof p.coverage==="boolean"&&
   (p.session===null||typeof p.session==="string"&&SESSION.test(p.session))&&STATUS.has(p.status),"PROJECTION_ROW_INVALID");return p;
}
/** Only first-generation normal tasks admitted with immutable server pin are indexed.
 * Never fabricate pre-upgrade coverage. Caller must already own the task transaction.
 * All task writers use this single seam; status and event projection commit together. */
export async function putProjectedSupervisorTask(tx:Write,taskKey:string,task:SupervisorTask){
 check(taskKey==="supervisor:task:"+task.id&&ID.test(task.id),"PROJECTION_TASK_SCOPE");
 if(!task.githubSource){await tx.put(taskKey,task);return;}
 const old=await tx.get<SupervisorTask>(taskKey),raw=await tx.get<unknown>(key(task.id));
 const previous=raw===undefined?undefined:decode(raw,task.id);
 const session=task.session??null;
 check(natural(task.createdAt)&&(session===null||SESSION.test(session))&&STATUS.has(task.status),"PROJECTION_TASK_INVALID");
 // Coverage starts at admission. If a preexisting task has no row or a
 // missed write is detected, retain the task but mark projection unknown.
 const aligned=previous&&old&&previous.status===old.status&&previous.session===(old.session??null)&&previous.createdAt===old.createdAt;
 const coverage=previous ? previous.coverage&&Boolean(aligned)&&previous.seq<MAX_EVENTS : old===undefined;
 const revision=(previous?.revision??-1)+1,seq=coverage?(previous?.seq??0)+1:(previous?.seq??0);
 check(natural(revision),"PROJECTION_REVISION_EXHAUSTED");
 const row:TaskProjection={id:task.id,session,status:task.status,createdAt:task.createdAt,revision,seq,coverage};
 if(coverage){
  const event=eventProjection({seq,type:"supervisor.logical."+task.status});
  check(await tx.get(eventKey(task.id,seq))===undefined,"PROJECTION_EVENT_REPLAY");
  await tx.put(eventKey(task.id,seq),event);
 }
 await tx.put(key(task.id),row);await tx.put(taskKey,task);
}
export async function readTaskProjection(storage:Read,id:string):Promise<TaskProjection>{
 const raw=await storage.get<unknown>(key(id));if(raw===undefined)throw Error("PROJECTION_COVERAGE_UNKNOWN");
 const p=decode(raw,id);check(p.coverage,"PROJECTION_COVERAGE_UNKNOWN");return p;
}
export async function projectedTaskDirectory(storage:Pick<DurableObjectStorage,"list">,limit=100){
 check(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,"PROJECTION_DIRECTORY_LIMIT");
 const rows=await storage.list<unknown>({prefix:PREFIX,limit:limit+1});
 check(rows.size<=limit+1,"PROJECTION_DIRECTORY_UNBOUNDED");
 const selected=[...rows].slice(0,limit).map(([k,v])=>decode(v,k.slice(PREFIX.length)));
 const entries=selected.filter(p=>p.coverage&&p.session).map(p=>directoryProjection({key:"supervisor:task:"+p.id,session:p.session!,status:p.status,createdAt:p.createdAt}));
 return {entries,limited:rows.size>limit,coverageUnknown:selected.some(p=>!p.coverage),historicalCoverage:false as const};
}
export function logicalEventSource(storage:Read,task:TaskProjection,expected:Scope):ProjectedSource<EventRow>{
 check(task.coverage&&task.session===expected.session&&expected.view==="progress","PROJECTION_SCOPE");
 return {async next(scope,after,maxBytes,signal){
  check(!signal.aborted&&scope.principal===expected.principal&&scope.workspace===expected.workspace&&scope.session===expected.session&&scope.view==="progress","PROJECTION_SCOPE");
  const n=Number(after||0);check(natural(n)&&n<=task.seq,"PROJECTION_CURSOR_RANGE");
  if(n===task.seq)return {kind:"end"};
  const raw=await storage.get<EventRow>(eventKey(task.id,n+1));
  check(!signal.aborted&&raw&&raw.seq===n+1,"PROJECTION_SEQUENCE_GAP");
  const row=eventProjection(raw);check(row.type.startsWith("supervisor.logical."),"PROJECTION_EVENT_SOURCE");
  if(new TextEncoder().encode(JSON.stringify(row)).byteLength>maxBytes)return {kind:"oversize"};
  return {kind:"row",row};
 }};
}
export async function importProjectionCursorKey(raw:unknown){
 check(typeof raw==="string"&&/^[a-f0-9]{64}$/.test(raw)&&!/^0{64}$/.test(raw),"PROJECTION_CURSOR_KEY_UNAVAILABLE");
 return crypto.subtle.importKey("raw",Uint8Array.from(raw.match(/../g)!,v=>parseInt(v,16)),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}

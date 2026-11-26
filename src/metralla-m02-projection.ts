/** P07 candidate, independent of P06. Source must project in storage BEFORE deserialization.
 * No fallback to full storage.list(), history(), or log() is allowed. */
export type Scope = Readonly<{principal:string; workspace:string; view:"directory"|"progress"; session:string}>;
export type Limits = Readonly<{rows:number; bytes:number; ms:number}>;
export type DirectoryRow = {key:string;session:string;status:string;createdAt:number};
export type EventRow = {seq:number;type:string};
export type Next<T> = {kind:"row";row:T}|{kind:"end"}|{kind:"oversize"};
export interface ProjectedSource<T> {
  /** Must apply scope, stable exclusive order, LIMIT 1, fixed-column projection,
   * byte cap and abort at the storage boundary. Never hydrate original payloads.
   * Errors/abort are NOT end. No background prefetch. */
  next(scope:Scope, after:string, maxBytes:number, signal:AbortSignal):Promise<Next<T>>;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {fatal:true});
const short = (v:unknown,max=128): v is string => typeof v==="string" && v.length>0 && v.length<=max && /^[A-Za-z0-9_.:@-]+$/.test(v);
const natural = (v:unknown):v is number => typeof v==="number" && Number.isSafeInteger(v) && v>=0;
const hex=(v:Uint8Array)=>Array.from(v,b=>b.toString(16).padStart(2,"0")).join("");
const unhex=(v:string)=>{if(v.length%2||!/^[a-f0-9]+$/.test(v)) throw Error("CURSOR_INVALID");return Uint8Array.from(v.match(/../g)!,x=>parseInt(x,16));};
function scopeKey(s:Scope){
  if(!short(s.principal)||!short(s.workspace)||!short(s.session)||!(["directory","progress"] as const).includes(s.view))throw Error("SCOPE_INVALID");
  return JSON.stringify([s.principal,s.workspace,s.view,s.session]);
}
function validateAfter(s:Scope,after:string){
  if(after==="")return;
  if(s.view==="directory" ? !/^supervisor:task:[a-f0-9]{16}$/.test(after) : !/^[1-9][0-9]{0,15}$/.test(after)||!Number.isSafeInteger(Number(after)))throw Error("CURSOR_INVALID");
}
/** Key must come from trusted backend key management, not request input. */
export async function signCursor(scope:Scope,after:string,key:CryptoKey){
  validateAfter(scope,after);
  const scopeDigest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(scopeKey(scope)))));
  const body=encoder.encode(JSON.stringify([scopeDigest,after]));
  return `${hex(body)}.${hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,body)))}`;
}
export async function readCursor(scope:Scope,token:string|undefined,key:CryptoKey):Promise<string>{
  const expected=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(scopeKey(scope)))));
  if(token===undefined)return "";
  if(typeof token!=="string"||token.length>2048)throw Error("CURSOR_INVALID");
  try {
    const pieces=token.split(".");if(pieces.length!==2||pieces[1].length!==64)throw Error();
    const body=unhex(pieces[0]);
    if(!await crypto.subtle.verify("HMAC",key,unhex(pieces[1]),body))throw Error();
    const value=JSON.parse(decoder.decode(body));
    if(!Array.isArray(value)||value.length!==2||value[0]!==expected||typeof value[1]!=="string")throw Error();
    validateAfter(scope,value[1]);return value[1];
  }catch{throw Error("CURSOR_INVALID");}
}
const statuses=new Set(["preparing","running","cancel_requested","unknown","finished","cancelled","failed","unanswered"]);
/** Only fixed fields survive; reject invalid or oversized fields before encoding. */
export function directoryProjection(raw:DirectoryRow):DirectoryRow{
  if(!raw||typeof raw.key!=="string"||!/^supervisor:task:[a-f0-9]{16}$/.test(raw.key)||!short(raw.session,67)||!/^ses[A-Za-z0-9_]{1,64}$/.test(raw.session)||typeof raw.status!=="string"||raw.status.length>32||!statuses.has(raw.status)||!natural(raw.createdAt))throw Error("PROJECTION_INVALID");
  return {key:raw.key,session:raw.session,status:raw.status,createdAt:raw.createdAt};
}
export function eventProjection(raw:EventRow):EventRow{
  if(!raw||!natural(raw.seq)||raw.seq<1||!short(raw.type,100))throw Error("PROJECTION_INVALID");
  return {seq:raw.seq,type:raw.type};
}
function validateLimits(l:Limits){if(!natural(l.rows)||l.rows<1||l.rows>200||!natural(l.bytes)||l.bytes<2||l.bytes>65536||!natural(l.ms)||l.ms<1||l.ms>2000)throw Error("LIMIT_INVALID");}
export type Stop = "end"|"rows"|"bytes"|"time"|"oversize";
/** Byte accounting covers JSON array of projections, NOT full RPC envelope. */
async function page<T>(source:ProjectedSource<T>,scope:Scope,key:CryptoKey,cursor:string|undefined,limits:Limits,project:(v:T)=>T,position:(v:T)=>string){
  validateLimits(limits);const deadline=performance.now()+limits.ms;
  let after=await readCursor(scope,cursor,key);
  if(scope.view==="directory" ? scope.session!=="directory" : !/^ses[A-Za-z0-9_]{1,64}$/.test(scope.session))throw Error("SCOPE_INVALID");
  const from=after;const rows:T[]=[];let bytes=2;let stop:Stop="rows";
  while(rows.length<limits.rows){
    const left=deadline-performance.now();if(left<=0){stop="time";break;}
    const budget=limits.bytes-bytes-(rows.length?1:0);if(budget<=0){stop="bytes";break;}
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let next:Next<T>|undefined;
    try{
      next=await Promise.race([source.next(scope,after,budget,controller.signal),new Promise<undefined>(resolve=>{timer=setTimeout(()=>{resolve(undefined);controller.abort();},left);})]);
    }finally{if(timer!==undefined)clearTimeout(timer);}
    if(!next||performance.now()>=deadline){controller.abort();stop="time";break;}
    if(next.kind==="end"){stop="end";break;}
    if(next.kind==="oversize"){stop="oversize";break;}
    if(next.kind!=="row")throw Error("PROJECTION_INVALID");
    const row=project(next.row);const pos=position(row);validateAfter(scope,pos);
    if(scope.view==="progress" ? Number(pos)<=Number(after||0) : pos<=after)throw Error("PROJECTION_ORDER_INVALID");
    if(scope.view==="progress" && Number(pos)!==Number(after||0)+1)throw Error("PROJECTION_SEQUENCE_GAP");
    const size=encoder.encode(JSON.stringify(row)).byteLength;
    if(size>budget){stop="bytes";break;} // do not advance rejected row
    rows.push(row);bytes+=size+(rows.length>1?1:0);after=pos;
  }
  return {rows,bytes,from,stop,complete:stop==="end",cursor:stop==="end"?null:await signCursor(scope,after,key)};
}
export function projectedDirectory(source:ProjectedSource<DirectoryRow>,scope:Scope,key:CryptoKey,cursor:string|undefined,limits:Limits){
  if(scope.view!=="directory")throw Error("SCOPE_INVALID");
  return page(source,scope,key,cursor,limits,directoryProjection,r=>r.key);
}
export function projectedProgress(source:ProjectedSource<EventRow>,scope:Scope,key:CryptoKey,cursor:string|undefined,limits:Limits){
  if(scope.view!=="progress")throw Error("SCOPE_INVALID");
  return page(source,scope,key,cursor,limits,eventProjection,r=>String(r.seq));
}

/** Candidate adapter for a fixed-column side projection in the existing SQLite DO.
 * No access to SDK private tables. Caller must attest coverage from an atomic
 * writer/backfill; the adapter refuses incomplete coverage, not an empty page.
 * DDL/backfill and production integration are intentionally NOT applied by P07.
 */
export type ProjectionQuery = (sql:string, bindings:readonly (string|number)[]) => readonly Record<string,unknown>[];
export function sqliteProjectionSource<T extends DirectoryRow|EventRow>(view:Scope["view"],query:ProjectionQuery,hasCoverage:(scope:Scope)=>boolean):ProjectedSource<T>{
  return {async next(scope,after,maxBytes,signal){
    if(scope.view!==view||signal.aborted)throw Error("PROJECTION_SOURCE_UNAVAILABLE");
    if(!hasCoverage(scope))throw Error("PROJECTION_COVERAGE_UNKNOWN");
    const directory=view==="directory";
    // Fixed-column projection and byte gate happen within SQL; only a single
    // bounded JSON projection (or its oversize marker) crosses into JS.
    const sql=directory?`WITH candidate AS (SELECT CASE WHEN length(CAST(task_key AS BLOB)) <= 32 AND length(CAST(session_id AS BLOB)) <= 67 AND length(CAST(status AS BLOB)) <= 32 THEN json_object('key', task_key, 'session', session_id, 'status', status, 'createdAt', created_at) ELSE NULL END AS p FROM metralla_directory_projection WHERE principal = ? AND workspace = ? AND task_key > ? ORDER BY task_key LIMIT 1) SELECT CASE WHEN length(CAST(p AS BLOB)) <= ? THEN p ELSE NULL END AS projection FROM candidate`:
      `WITH candidate AS (SELECT CASE WHEN length(CAST(event_type AS BLOB)) <= 100 THEN json_object('seq', seq, 'type', event_type) ELSE NULL END AS p FROM metralla_event_projection WHERE principal = ? AND workspace = ? AND session_id = ? AND seq > ? ORDER BY seq LIMIT 1) SELECT CASE WHEN length(CAST(p AS BLOB)) <= ? THEN p ELSE NULL END AS projection FROM candidate`;
    const bindings=directory?[scope.principal,scope.workspace,after,maxBytes]:[scope.principal,scope.workspace,scope.session,Number(after||0),maxBytes];
    const rows=query(sql,bindings);
    if(signal.aborted)throw Error("PROJECTION_SOURCE_UNAVAILABLE");
    if(rows.length>1)throw Error("PROJECTION_SOURCE_UNBOUNDED");
    if(!rows.length)return {kind:"end"};
    const p=rows[0].projection;
    if(p===null)return {kind:"oversize"};
    if(typeof p!=="string"||p.length>maxBytes||encoder.encode(p).byteLength>maxBytes)throw Error("PROJECTION_SOURCE_UNBOUNDED");
    return {kind:"row",row:JSON.parse(p) as T};
  }};
}

/** Shape matches existing SupervisorToolCounts; persist using existing CAS.
 * A gap, mismatch or inconsistent counters is never a completed result. */
export type ProjectedCounts={cursor:number;toolCalls:number;completedTools:number;failedTools:number};
export function foldProjectedCounts(prior:ProjectedCounts,page:{from:string;rows:readonly EventRow[];complete:boolean}){
  const valid=(m:ProjectedCounts)=>!!m&&[m.cursor,m.toolCalls,m.completedTools,m.failedTools].every(natural)&&m.completedTools+m.failedTools<=m.toolCalls;
  if(!valid(prior)||typeof page.from!=="string"||page.from!==String(prior.cursor||"")||page.rows.length>200)throw Error("PROJECTION_CHECKPOINT_MISMATCH");
  const metrics={...prior};
  for(const raw of page.rows){
    const row=eventProjection(raw);if(row.seq!==metrics.cursor+1)throw Error("PROJECTION_SEQUENCE_GAP");
    if(row.type==="session.tool.called")metrics.toolCalls++;
    else if(row.type==="session.tool.success")metrics.completedTools++;
    else if(row.type==="session.tool.failed")metrics.failedTools++;
    metrics.cursor=row.seq;
  }
  if(!valid(metrics))throw Error("PROJECTION_METRICS_INVALID");
  return {metrics,complete:page.complete,eventsRead:page.rows.length};
}

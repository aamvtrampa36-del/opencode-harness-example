import { projectedProgress, type Scope as ProjectionScope, type ProjectedSource, type EventRow } from "../metralla-m02-projection.ts";

export const REMOTE_SCHEMA = "opencode.remote-evidence.v1" as const;
export const MAX_BODY_BYTES = 65536;
export const MAX_PAGE_BYTES = 8192;
export const MAX_EVENTS = 64;
export const MAX_CURSOR = 2048;
const encoder = new TextEncoder();
const size = (s:string) => encoder.encode(s).byteLength;
const natural = (x:unknown): x is number => typeof x==="number" && Number.isSafeInteger(x) && x>=0;
const task = /^[a-f0-9]{16}$/;
const workspace = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const session = /^ses[A-Za-z0-9_]{1,64}$/;
const statuses = new Set(["preparing","queued","running","finished","failed","unanswered","cancel_requested","cancelled","unknown"]);
const plain = (x:unknown): x is Record<string,unknown> => !!x && typeof x==="object" && !Array.isArray(x);
const fail = (code:string):never => {throw new Error(code);};
export type RemoteScope = {id:string;workspace:string|null};
export function remoteScope(id:unknown,w:unknown):RemoteScope {
  if(typeof id!=="string"||!task.test(id)) return fail("REMOTE_ID_INVALID");
  if(w!==null && w!==undefined && (typeof w!=="string"||!workspace.test(w))) return fail("REMOTE_WORKSPACE_INVALID");
  return {id,workspace:typeof w==="string"?w.toLowerCase():null};
}
export function validCursor(cursor:unknown):cursor is string {
  return typeof cursor==="string" && cursor.length<=MAX_CURSOR && /^[a-f0-9]+\.[a-f0-9]{64}$/.test(cursor);
}
// The HMAC is verified by the authoritative backend. At this boundary also
// compare the claimed position and scope digest, preventing a valid-shaped
// upstream page from silently skipping/replaying events.
function cursorPosition(token:string):{digest:string;position:number} {
  if(!validCursor(token)) return fail("REMOTE_CURSOR_INVALID");
  try {
    const body=token.split(".")[0];
    if(body.length%2) throw Error();
    const decoded=new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(body.match(/../g)!,v=>parseInt(v,16)));
    const value=JSON.parse(decoded);
    if(!Array.isArray(value)||value.length!==2||typeof value[0]!=="string"||!/^[a-f0-9]{64}$/.test(value[0])||
      typeof value[1]!=="string"||!(/^[1-9][0-9]{0,15}$/.test(value[1]))||!natural(Number(value[1])))throw Error();
    return {digest:value[0],position:Number(value[1])};
  } catch {return fail("REMOTE_CURSOR_INVALID");}
}
function sameScope(raw:Record<string,unknown>,scope:RemoteScope) {
  if(raw.id!==scope.id||raw.workspace!==scope.workspace) fail("REMOTE_UPSTREAM_IDENTITY_MISMATCH");
}
function envelope(raw:unknown,scope:RemoteScope):Record<string,unknown> {
  if(!plain(raw)||raw.schema!==REMOTE_SCHEMA) return fail("REMOTE_SCHEMA_MISMATCH");
  sameScope(raw,scope);
  return raw;
}
function checked<T>(x:T):T {
  if(size(JSON.stringify(x))>MAX_PAGE_BYTES) return fail("REMOTE_PAGE_LIMIT");
  return x;
}
export function validateStatus(raw:unknown,scope:RemoteScope,after:number|null) {
  if(after!==null&&!natural(after)) return fail("REMOTE_REVISION_INVALID");
  const x=envelope(raw,scope);
  if(!natural(x.revision)||(after!==null&&x.revision<after)) return fail("REMOTE_REVISION_INVALID");
  if(typeof x.status!=="string"||!statuses.has(x.status)) return fail("REMOTE_STATUS_INVALID");
  return checked({schema:REMOTE_SCHEMA,...scope,revision:x.revision,status:x.status,
    changed:x.revision!==after,source:"supervisor-task-ledger",snapshot:true,nativeReconciled:false,passed:false,verified:false});
}
export function validateProgress(raw:unknown,scope:RemoteScope,requested:string|undefined) {
  if(requested!==undefined&&!validCursor(requested)) return fail("REMOTE_CURSOR_INVALID");
  const x=envelope(raw,scope);
  if(x.pageAvailable!==true) return fail("REMOTE_PAGE_UNAVAILABLE");
  if(x.requestCursor!==(requested??null)||!natural(x.from)||(!requested&&x.from!==0)||
    !natural(x.nextAfter)||typeof x.complete!=="boolean"||!Array.isArray(x.events)||x.events.length>MAX_EVENTS)
    return fail("REMOTE_PAGE_INVALID");
  const prior=requested===undefined?null:cursorPosition(requested);
  if(prior&&x.from!==prior.position) return fail("REMOTE_CURSOR_POSITION_MISMATCH");
  let last=x.from;
  const events:{seq:number;type:string}[]=[];
  for(const rawEvent of x.events) {
    if(!plain(rawEvent)||!natural(rawEvent.seq)||rawEvent.seq!==last+1||typeof rawEvent.type!=="string"||
       !/^[A-Za-z0-9_.:@-]{1,100}$/.test(rawEvent.type)||/reasoning/i.test(rawEvent.type)) return fail("REMOTE_EVENT_INVALID");
    events.push({seq:rawEvent.seq,type:rawEvent.type});last=rawEvent.seq;
  }
  if(x.nextAfter!==last || (x.complete ? x.cursor!==null : !validCursor(x.cursor)||last===x.from||x.cursor===requested))
    return fail("REMOTE_CURSOR_NOT_ADVANCED");
  if(!x.complete){
    const next=cursorPosition(x.cursor as string);
    if(next.position!==last||(prior&&prior.digest!==next.digest))return fail("REMOTE_CURSOR_POSITION_MISMATCH");
  }
  return checked({schema:REMOTE_SCHEMA,...scope,requestCursor:requested??null,from:x.from,events,
    nextAfter:last,cursor:x.cursor,complete:x.complete,pageAvailable:true,passed:false,verified:false,nativeOperationsMeasured:false,
    ...(x.source==="logical-supervisor-transitions"?{source:"logical-supervisor-transitions"}:{})});
}
/** Backend candidate: lookup must be authenticated before any source read.
 * Key and principal come from server context, never caller input. Scope includes
 * exact task identity via digest; P07 signs the resulting session-bound position.
 * Neither this adapter nor its source interface grants authentication. */
export type AuthorizedProgress = {principal:string;workspace:string;session:string;key:CryptoKey;source:ProjectedSource<EventRow>};
export async function projectRemoteProgress(scope:RemoteScope,cursor:string|undefined,
  authorize:(scope:RemoteScope)=>Promise<AuthorizedProgress|null>) {
  const exact=remoteScope(scope.id,scope.workspace);
  if(cursor!==undefined&&!validCursor(cursor)) return fail("REMOTE_CURSOR_INVALID");
  const access=await authorize(exact);
  if(!access || !access.principal || access.principal.length>128 ||
     access.workspace!==(exact.workspace??"opencode-supervisor-v1") || !session.test(access.session))
    return fail("REMOTE_SCOPE_FORBIDDEN");
  const digest=await crypto.subtle.digest("SHA-256",encoder.encode(JSON.stringify([access.principal,exact.id])));
  const principal=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
  const projectedScope:ProjectionScope={principal,workspace:access.workspace,view:"progress",session:access.session};
  const page=await projectedProgress(access.source,projectedScope,access.key,cursor,{rows:MAX_EVENTS,bytes:4096,ms:1000});
  if(page.stop==="oversize"||page.stop==="time"||(!page.complete&&!page.rows.length)) return fail("REMOTE_PAGE_UNAVAILABLE");
  const from=Number(page.from||0);
  // Do not export raw reasoning strings or skip unseen durable sequences.
  const events=page.rows.map(row=>({seq:row.seq,type:/reasoning/i.test(row.type)?"event.omitted":row.type}));
  return validateProgress({schema:REMOTE_SCHEMA,...exact,requestCursor:cursor??null,from,events,
    nextAfter:events.at(-1)?.seq??from,cursor:page.cursor,complete:page.complete,pageAvailable:true},exact,cursor);
}
export class BodyError extends Error {
  readonly code:string;
  readonly httpStatus:number;
  constructor(code:string,httpStatus:number){super(code);this.code=code;this.httpStatus=httpStatus;}
}
export async function boundMcpRequest(request:Request,timeoutMs=5000):Promise<Request>{
  if(request.method!=="POST") return request;
  const enc=request.headers.get("content-encoding");
  if(enc&&enc.toLowerCase()!=="identity") throw new BodyError("MCP_CONTENT_ENCODING_UNSUPPORTED",415);
  const len=request.headers.get("content-length");
  if(len!==null&&(!/^\d+$/.test(len)||Number(len)>MAX_BODY_BYTES)) throw new BodyError("MCP_BODY_LIMIT",413);
  if(!request.body){
    if(len!==null&&Number(len)!==0) throw new BodyError("MCP_BODY_LENGTH_MISMATCH",400);
    return request;
  }
  const reader=request.body.getReader();
  const buffer=new Uint8Array(MAX_BODY_BYTES);
  let used=0,timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BodyError("MCP_BODY_TIMEOUT",408)),timeoutMs);});
  try{
    while(true){
      const part=await Promise.race([reader.read(),timeout]);
      if(part.done)break;
      if(part.value.byteLength>MAX_BODY_BYTES-used)throw new BodyError("MCP_BODY_LIMIT",413);
      buffer.set(part.value,used);used+=part.value.byteLength;
    }
    if(len!==null&&Number(len)!==used)throw new BodyError("MCP_BODY_LENGTH_MISMATCH",400);
    const headers=new Headers(request.headers);headers.delete("content-length");
    return new Request(request.url,{method:request.method,headers,body:buffer.slice(0,used),signal:request.signal});
  }catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{clearTimeout(timer);reader.releaseLock();}
}
export async function dispatchBoundedMcp(request:Request,dispatch:(r:Request)=>Promise<Response>|Response):Promise<Response>{
  let bounded:Request;
  try{bounded=await boundMcpRequest(request);}
  catch(error){
    const known=error instanceof BodyError;
    return Response.json({error:known?error.code:"MCP_BODY_READ_FAILED",status:"unknown",passed:false,verified:false},
      {status:known?error.httpStatus:400,headers:{"Cache-Control":"no-store"}});
  }
  return await dispatch(bounded);
}

/** One bounded durable receipt stream per isolated Container. Captures only
 * real exec RPC acknowledgement and exit code; not independent VM closure.
 * A lost response leaves an immutable open receipt, never fabricated activity. */
import type {ExecutionScope} from "./metralla-m03-execution-identity";
const PREFIX="m08-linux-receipt-v1:",INDEX="m08-linux-receipt-index-v1";
const MAX=256,ID=/^[a-f0-9-]{36}$/,SHA=/^[a-f0-9]{64}$/;
type Row={seq:number;callId:string;requestId:string;project:string;sessionId:string;operationId:string;releaseSha:string;
 generation:number;bootId:string;containerId:string;commandSha256:string;intentAt:number;acceptedAt:number|null;exitAt:number|null;exitCode:number|null;state:"intent"|"accepted"|"exited"|"unknown";truncated:boolean|null};
const integer=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const rowKey=(seq:number)=>PREFIX+String(seq).padStart(6,"0");
type Reader=Pick<DurableObjectStorage,"get">;
type Writer=Pick<DurableObjectTransaction,"get"|"put">;
async function head(s:Reader){
 const h=await s.get<{count:number;open:number|null}>(INDEX)??{count:0,open:null};
 check(integer(h.count)&&h.count<=MAX&&(h.open===null||integer(h.open)&&h.open===h.count),"LINUX_RECEIPT_INDEX");return h;
}
export async function hasOpenLinuxReceipt(storage:Reader):Promise<boolean>{return (await head(storage)).open!==null;}
export async function beginLinuxReceipt(tx:Writer,scope:ExecutionScope,callId:string,releaseSha:string,commandSha256:string,now=Date.now()){
 const {lease,source,boot}=scope;
 check(ID.test(callId)&&/^[a-f0-9]{40}$/.test(releaseSha)&&SHA.test(commandSha256)&&integer(now)&&now<lease.expiresAt&&
  source.project==="supervised-"+lease.requestId&&boot.project===source.project&&SHA.test(boot.objectId),"LINUX_RECEIPT_SCOPE");
 const h=await head(tx);check(h.open===null&&h.count<MAX,"LINUX_RECEIPT_OPEN_OR_LIMIT");
 // Request ID marker is never overwritten even if the RPC reply is lost.
 const callKey=PREFIX+"call:"+callId;check(!await tx.get(callKey),"LINUX_RECEIPT_REPLAY");
 const seq=h.count+1;
 const row:Row={seq,callId,requestId:lease.requestId,project:source.project,sessionId:"ses_r2_"+lease.requestId,operationId:"rc-start-"+lease.requestId,
  releaseSha,generation:lease.generation,bootId:boot.bootId,containerId:boot.objectId,commandSha256,intentAt:now,acceptedAt:null,exitAt:null,exitCode:null,state:"intent",truncated:null};
 await tx.put(rowKey(seq),row);await tx.put(callKey,seq);await tx.put(INDEX,{count:seq,open:seq});
 return seq;
}
export async function advanceLinuxReceipt(tx:Writer,seq:number,callId:string,event:{kind:"accepted"}|{kind:"exited";exitCode:number|null;truncated:boolean}|{kind:"unknown"},now=Date.now()){
 const h=await head(tx),row=await tx.get<Row>(rowKey(seq));
 check(h.open===seq&&row?.callId===callId&&integer(now)&&now>=row.intentAt,"LINUX_RECEIPT_FENCE");
 if(event.kind==="accepted"){
  check(row.state==="intent","LINUX_RECEIPT_STATE");row.state="accepted";row.acceptedAt=now;
 }else if(event.kind==="exited"){
  check(row.state==="accepted"&&row.acceptedAt!==null&&now>=row.acceptedAt&&typeof event.exitCode==="number"&&Number.isSafeInteger(event.exitCode),"LINUX_RECEIPT_EXIT");
  row.state="exited";row.exitAt=now;row.exitCode=event.exitCode;row.truncated=event.truncated;
  await tx.put(INDEX,{count:h.count,open:null});
 }else{check(row.state==="intent"||row.state==="accepted","LINUX_RECEIPT_STATE");row.state="unknown";}
 await tx.put(rowKey(seq),row);
}
export async function linuxReceiptPage(s:Reader,project:string,releaseSha:string,after:string|null){
 check(/^supervised-[a-f0-9]{16}$/.test(project)&&/^[a-f0-9]{40}$/.test(releaseSha)&&(after===null||/^[1-9][0-9]{0,5}$/.test(after)),"LINUX_RECEIPT_SCOPE");
 const h=await head(s),from=after===null?0:Number(after);
 check(from<=h.count,"LINUX_RECEIPT_CURSOR");
 const rows=[];
 for(let seq=from+1;seq<=Math.min(from+16,h.count);seq++){
  const row=await s.get<Row>(rowKey(seq));
  check(row&&row.seq===seq&&row.project===project&&row.releaseSha===releaseSha&&ID.test(row.callId)&&SHA.test(row.commandSha256)&&
    row.requestId===project.slice("supervised-".length)&&integer(row.intentAt),"LINUX_RECEIPT_GAP");
  rows.push(row);
 }
 return {source:"container-exec-receipts",rows,nextAfter:from+rows.length<h.count?String(from+rows.length):null,openReceipt:h.open,physicalClosureVerified:false};
}

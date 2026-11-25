/** Workerd only supports follow/manual. A manual request never forwards a
 * bearer credential or a POST to an unexpected Location. Reject every
 * redirect before parsing a receipt, with no implicit replay or fallback. */
export async function pilotFetchNoRedirect(http:typeof fetch,input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1]):Promise<Response>{
  const response=await http(input,{...init,redirect:"manual"});
  if(response.redirected||response.type==="opaqueredirect"||response.status===0||
     (response.status>=300&&response.status<400)){
    // Do not await arbitrary redirect body data or disclose Location.
    void response.body?.cancel().catch(()=>{});
    throw Error("PILOT_HTTP_REDIRECT_REFUSED");
  }
  return response;
}

/** Race even an uncooperative transport against the caller's abort. Do not
 * equate abort with upstream absence or physical closure. */
export function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void promise.catch(()=>{});return Promise.reject(Error("HTTP_DEADLINE"));}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener("abort",abort);reject(Error("HTTP_DEADLINE"));};
    signal.addEventListener("abort",abort,{once:true});
    promise.then(v=>{signal.removeEventListener("abort",abort);resolve(v);},()=>{signal.removeEventListener("abort",abort);reject(Error("HTTP_TRANSPORT_FAILED"));});
  });
}
/** Bounded streaming before JSON materialization. Used by both pilot and normal
 * adapters. Header values are hints; enforce the actual byte count. */
export async function readBoundedJson(response:Response,maxBytes:number,signal:AbortSignal):Promise<unknown>{
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4*1024*1024)throw Error("HTTP_RESPONSE_BOUND_INVALID");
  if(response.redirected||response.type==="opaqueredirect"||response.status===0||response.status>=300&&response.status<400){
    void response.body?.cancel().catch(()=>{});throw Error("PILOT_HTTP_REDIRECT_REFUSED");
  }
  if(!response.body||response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")){
    void response.body?.cancel().catch(()=>{});throw Error("HTTP_NON_JSON_RESPONSE");
  }
  const declared=response.headers.get("content-length");
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes)){
    void response.body.cancel().catch(()=>{});throw Error("HTTP_RESPONSE_LIMIT");
  }
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){if(signal.aborted)throw Error("HTTP_DEADLINE");const x=await abortable(reader.read(),signal);
      if(x.done)break;
      if(x.value.byteLength>maxBytes-size)throw Error("HTTP_RESPONSE_LIMIT");
      if(x.value.byteLength){size+=x.value.byteLength;chunks.push(x.value);}
    }
    const bytes=new Uint8Array(size);let off=0;for(const c of chunks){bytes.set(c,off);off+=c.byteLength;}
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  }catch{void reader.cancel().catch(()=>{});throw Error(signal.aborted?"HTTP_DEADLINE":"HTTP_RESPONSE_INVALID_OR_LIMIT");}
  finally{reader.releaseLock();}
}

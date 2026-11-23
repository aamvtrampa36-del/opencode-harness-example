/**
 * F0-C10/R2-T05: project first, serialize afterwards.
 * Never stringify/redact a complete untrusted RPC result before applying limits.
 * This bounds our own work, not the already allocated incoming RPC payload.
 */
const SECRET_FIELD=/(^|[_.\s-])(password|passphrase|token|secret|authorization|cookie|credential|api[_-]?key|private[_-]?key)([_.\s-]|$)/i;
const OMIT="[contenido omitido por límite]";
const MAX_DEPTH=10, MAX_NODES=512, MAX_KEYS=64, MAX_ITEMS=64;
const MAX_KEY_CHARS=128, MAX_VALUE_CHARS=4096, MAX_TOTAL_CHARS=32_768;
type Budget={nodes:number;remainingChars:number;truncated:boolean;seen:WeakSet<object>};

export function redactMcpString(value:string):string{
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,"[REDACTADO]")
    .replace(/\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{12,}\b/g,"[REDACTADO]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g,"[REDACTADO]")
    .replace(/\bBearer\s+[A-Za-z0-9_.~+/-]+/gi,"Bearer [REDACTADO]")
    .replace(/((?:api[_-]?key|password|passphrase|token|secret|authorization|cookie)\s*[:=]\s*["']?)([^\s,;"']+)/gi,"$1[REDACTADO]");
}

function bounded(value:unknown, budget:Budget,depth:number):unknown {
  if(++budget.nodes>MAX_NODES||depth>MAX_DEPTH){budget.truncated=true;return OMIT;}
  if(value===null||typeof value==="number"||typeof value==="boolean")
    return value;
  if(typeof value==="string"){
    // Do not preserve a prefix of an overlong secret: token redaction could
    // otherwise be bypassed by truncating the token at the boundary.
    if(value.length>MAX_VALUE_CHARS||value.length>budget.remainingChars){
      budget.truncated=true;return OMIT;
    }
    budget.remainingChars-=value.length;
    return redactMcpString(value);
  }
  if(typeof value!=="object"){budget.truncated=true;return "[valor no serializable]";}
  if(budget.seen.has(value)){budget.truncated=true;return "[referencia repetida]";}
  budget.seen.add(value);
  if(Array.isArray(value)){
    const output:unknown[]=[];
    const size=Math.min(value.length,MAX_ITEMS);
    for(let i=0;i<size;i++){
      if(budget.nodes>=MAX_NODES){budget.truncated=true;break;}
      output.push(bounded(value[i],budget,depth+1));
    }
    if(value.length>output.length)budget.truncated=true;
    return output;
  }
  const out:Record<string,unknown>={};
  let count=0;
  for(const key in value){
    if(!Object.prototype.hasOwnProperty.call(value,key))continue;
    if(count++>=MAX_KEYS){budget.truncated=true;break;}
    if(key.length>MAX_KEY_CHARS){budget.truncated=true;continue;}
    if(SECRET_FIELD.test(key)){out[key]="[REDACTADO]";continue;}
    if(budget.nodes>=MAX_NODES){budget.truncated=true;break;}
    out[key]=bounded((value as Record<string,unknown>)[key],budget,depth+1);
  }
  return out;
}

/** Returns a small JSON string, or a conservative error record, never a giant
 * full transcript. maxChars is a second-stage OUTPUT cap, not the input budget. */
export function boundedMcpJsonText(value:unknown,maxChars=16_000,targetWorker?:string):string{
  const cap=Number.isSafeInteger(maxChars)&&maxChars>=256?Math.min(maxChars,64_000):16_000;
  const budget:Budget={nodes:0,remainingChars:Math.min(cap,MAX_TOTAL_CHARS),truncated:false,seen:new WeakSet()};
  let payload=bounded(value,budget,0);
  if(!payload||typeof payload!=="object"||Array.isArray(payload))
    payload={result:payload};
  const record=payload as Record<string,unknown>;
  if(targetWorker)record.targetWorker=targetWorker;
  if(budget.truncated){
    record._responseTruncated=true;
    record.passed=false;record.verified=false;
    if("toolProofVerified" in record)record.toolProofVerified=false;
    if("runtimeVerified" in record)record.runtimeVerified=false;
    if("modelVerified" in record)record.modelVerified=false;
    if("toolCountsComplete" in record)record.toolCountsComplete=false;
    if("supervisedCountComplete" in record)record.supervisedCountComplete=false;
    if("status" in record)record.status="unknown";
  }
  // All child content has already been limited before serialization.
  const text=JSON.stringify(record,null,2);
  if(text.length<=cap)return text;
  return JSON.stringify({
    ...(targetWorker?{targetWorker}:{}),
    _responseTruncated:true,status:"unknown",passed:false,verified:false,
    error:"MCP_RESPONSE_LIMIT_EXCEEDED"
  });
}

/** M04 private server seam. Caller owns the existing T03 grant, configured
 * provider adapter, exact token-bound evidence and paid preflight. No client
 * input can supply these attestations. M08 wires this into SDK interception. */
import {reserveInference,beginInferenceDispatch,settleInference,markInferenceUnknown,
  rejectInferenceBeforeGeneration,cancelReservedNormalInference,type BudgetPolicy,type PaidPreflight,type InferenceIntent} from "./supervisor-inference-budget.ts";
import type {StartGrant} from "./supervisor-admission";
import type {NormalRoute} from "./metralla-m04-policy.ts";
import {abortable,pilotFetchNoRedirect,readBoundedJson} from "./pilot-http.ts";
type BeforeCode="429"|"3040"|"402"|"403";
type Send=(route:NormalRoute,body:string,signal:AbortSignal)=>Promise<Response>;
type Context={storage:DurableObjectStorage;grant:StartGrant;policy:BudgetPolicy;preflight:PaidPreflight;
  boundInputTokens:(body:string,route:NormalRoute)=>number;send:Send;
  /** Trusted provider-specific parser; HTTP status alone is never enough. */
  preGenerationRejection?:(status:number,data:unknown,route:NormalRoute)=>BeforeCode|undefined};
function check(ok:unknown,m:string):asserts ok{if(!ok)throw Error(m);}
function record(x:unknown):Record<string,any>{check(x&&typeof x==="object"&&!Array.isArray(x),"NORMAL_JSON_INVALID");return x as Record<string,any>;}
function uint(x:unknown,max:number):x is number{return typeof x==="number"&&Number.isSafeInteger(x)&&x>=0&&x<=max;}
export function normalHttpSender(http:typeof fetch,pin:{endpoint:string;providerID:string;modelID:string;headers:HeadersInit}):Send{
  const url=new URL(pin.endpoint);check(url.protocol==="https:"&&!url.username&&!url.password&&!url.hash,"NORMAL_ENDPOINT_INVALID");
  const headers=new Headers(pin.headers);headers.set("content-type","application/json");
  return async(route,body,signal)=>{check(route.providerID===pin.providerID&&route.modelID===pin.modelID,"NORMAL_ENDPOINT_SCOPE");
    return pilotFetchNoRedirect(http,url.href,{method:"POST",headers,body,signal});};
}
export async function dispatchNormalInference(c:Context,input:Omit<InferenceIntent,"wireBytes">,
  messages:unknown[],tools:unknown[]=[],outer?:AbortSignal){
  check(c.policy.normal&&!c.policy.hybrid,"NORMAL_POLICY_REQUIRED");
  const p=c.policy.normal,route=Object.hasOwn(p.routes,input.selection)?p.routes[input.selection]:undefined;
  check(route&&route.registered===true&&route.tools===true,"NORMAL_ROUTE_UNVERIFIED");
  check(Array.isArray(messages)&&messages.length>0&&messages.length<=256&&Array.isArray(tools)&&tools.length<=64,"NORMAL_PAYLOAD_INVALID");
  // Server supplies authorized tools; the adapter never accepts a URL, headers,
  // streaming, multiple generations or model/provider override from payload.
  const body=JSON.stringify({model:route.modelID,messages,tools,n:1,stream:false,max_tokens:input.outputTokenCeiling,
    ...(route.providerID==="openrouter"?{provider:{allow_fallbacks:false,require_parameters:true}}:{})});
  const wireBytes=new TextEncoder().encode(body).length;
  const bound=c.boundInputTokens(body,route);
  check(uint(bound,input.inputTokenCeiling)&&bound>0&&wireBytes<=route.maxWireBytes,"NORMAL_WIRE_OR_TOKEN_LIMIT");
  const intent:InferenceIntent={...input,wireBytes};
  const remaining=Math.min(route.timeoutMs,p.validUntil-Date.now(),route.validUntil-Date.now());
  check(remaining>0&&!outer?.aborted,"NORMAL_DEADLINE_BEFORE_DISPATCH");
  const signal=AbortSignal.any([AbortSignal.timeout(remaining),...(outer?[outer]:[])]);
  const reservation=await reserveInference(c.storage,c.grant,intent,c.policy);
  if(reservation.kind!=="reserved")return {kind:"duplicate" as const,intent};
  try{
    check(!signal.aborted,"NORMAL_DEADLINE_BEFORE_DISPATCH");
    const d=await beginInferenceDispatch(c.storage,c.grant,intent,c.policy,c.preflight);
    if(!d.proceed)return {kind:"duplicate" as const,intent};
  }catch(e){
    // Only reserved row can be released; if commit outcome was sent/ambiguous,
    // do not retry or silently release. Preserve original error classification.
    try{await cancelReservedNormalInference(c.storage,c.grant,intent,c.policy);}catch{throw Error("NORMAL_DISPATCH_STATE_UNCERTAIN");}
    throw e;
  }
  try{
    check(!signal.aborted,"NORMAL_DEADLINE_AFTER_DISPATCH");
    const response=await abortable(c.send(route,body,signal),signal);
    const data=record(await readBoundedJson(response,route.maxResponseBytes,signal));
    if(!response.ok){
      const code=c.preGenerationRejection?.(response.status,data,route);
      check(code&&["429","3040","402","403"].includes(code)&&
        ((code==="3040"&&response.status===429)||Number(code)===response.status)&&!data.id&&!data.choices&&!data.usage,"NORMAL_PROVIDER_UNKNOWN");
      await rejectInferenceBeforeGeneration(c.storage,intent,{origin:"trusted-provider-adapter",beforeGeneration:true,code});
      return {kind:"rejected" as const,code,intent};
    }
    const u=record(data.usage);
    check(typeof data.id==="string"&&data.id.length>0&&data.id.length<=256&&data.model===route.modelID&&
      Array.isArray(data.choices)&&data.choices.length===1&&["stop","length","tool_calls"].includes(data.choices[0]?.finish_reason),
      "NORMAL_COMPLETION_UNVERIFIED");
    check(uint(u.prompt_tokens,intent.inputTokenCeiling)&&uint(u.completion_tokens,intent.outputTokenCeiling)&&
      uint(u.total_tokens,intent.inputTokenCeiling+intent.outputTokenCeiling)&&u.total_tokens>=u.prompt_tokens+u.completion_tokens,
      "NORMAL_USAGE_UNVERIFIED");
    const output=Math.max(u.completion_tokens,u.total_tokens-u.prompt_tokens);
    check(output<=intent.outputTokenCeiling&&!signal.aborted,"NORMAL_TOKEN_OR_DEADLINE_STOP");
    const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(data.id)));
    const receiptId=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
    check(!signal.aborted,"NORMAL_DEADLINE_AFTER_DISPATCH");
    const settled=await settleInference(c.storage,intent,{origin:"trusted-provider-adapter",receiptId,inputTokens:u.prompt_tokens,outputTokens:output,actualModel:data.model});
    return {kind:"settled" as const,chargedMicroUsd:settled.chargedMicroUsd,intent,data};
  }catch{
    // Neither abort nor HTTP error proves a provider did not generate.
    await markInferenceUnknown(c.storage,intent,"normal_provider_outcome_unknown");
    throw Error("NORMAL_PROVIDER_OUTCOME_UNKNOWN");
  }
}

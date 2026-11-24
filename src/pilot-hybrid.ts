import type { Plugin } from "@opencode/plugin";
import { pilotFetchNoRedirect } from "./pilot-http";
import type { StartGrant } from "./supervisor-admission";
import { PILOT_FREE, PILOT_BACKUP, PILOT_GLM, PILOT_INPUT_TOKENS, PILOT_OUTPUT_TOKENS, PILOT_GLM_BILLABLE_INPUT_CEILING, PILOT_MAX_WIRE_BYTES,
  type BudgetPolicy, type PilotDispatchEvidence, type InferenceIntent, pilotDispatchEvidenceValid,
  pilotProviderSelection, reserveInference, beginInferenceDispatch, rejectInferenceBeforeGeneration,
  settleInference, markInferenceUnknown } from "./supervisor-inference-budget";

export type PilotContext = { storage: DurableObjectStorage; grant: StartGrant; policy: BudgetPolicy; proof: PilotDispatchEvidence };
type RawBinding = { run(model: string, input: Record<string, unknown>, options: {returnRawResponse:true;signal:AbortSignal}): Promise<Response> };
type RunOptions = { returnRawResponse?: boolean; extraHeaders?: Record<string,string>; signal?: AbortSignal };
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const allowedTools = new Set(["linux","inspect_linux","github","repo_info","repo_read","repo_review","repo_pr_search","repo_pr_info","repo_issue_info","repo_pr_files","repo_pr_reviews","repo_checks"]);
function check(ok:unknown, reason:string): asserts ok { if(!ok) throw Error(reason); }
function obj(v:unknown): Record<string,any> { check(v && typeof v==="object" && !Array.isArray(v),"PILOT_JSON_INVALID"); return v as Record<string,any>; }
function shape(input:unknown): Record<string,unknown> {
  const p=obj(input);
  check(Array.isArray(p.messages) && p.messages.length>0 && p.messages.length<=128,"PILOT_MESSAGES_INVALID");
  // Admit text and ordinary chat tool calls only. No media, provider-native tools,
  // routing preferences, paid plugins, arbitrary headers or model-supplied URL.
  for(const m of p.messages) {
    const r=obj(m);
    check(["system","user","assistant","tool","developer"].includes(r.role) &&
      (r.content==null || typeof r.content==="string" ||
       (Array.isArray(r.content)&&r.content.every((x:unknown)=>{const t=obj(x);return t.type==="text"&&typeof t.text==="string"}))),
      "PILOT_MEDIA_OR_ROLE_FORBIDDEN");
  }
  check(p.tools===undefined || (Array.isArray(p.tools)&&p.tools.length<=32&&p.tools.every((x:unknown)=>{
    const t=obj(x);return t.type==="function" && typeof t.function?.name==="string" && allowedTools.has(t.function.name);
  })),"PILOT_TOOL_FORBIDDEN");
  const body:Record<string,unknown>={messages:p.messages};
  for(const k of ["tools","tool_choice","temperature","top_p","stop","seed","frequency_penalty","presence_penalty","response_format"])
    if(p[k]!==undefined)body[k]=p[k];
  // Conservative wire-size gate; not a certified provider tokenizer.
  check(new TextEncoder().encode(JSON.stringify(body)).length<=PILOT_MAX_WIRE_BYTES,"PILOT_INPUT_WIRE_LIMIT");
  return body;
}
async function readJson(r:Response) {
  check(r.body && !r.headers.get("content-type")?.includes("text/event-stream"),"PILOT_NON_JSON_RESPONSE");
  const reader=r.body.getReader(), chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;
    if(size>512*1024){await reader.cancel();throw Error("PILOT_RESPONSE_LIMIT");}chunks.push(x.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let off=0;for(const c of chunks){bytes.set(c,off);off+=c.length;}
  return obj(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
}
async function receiptId(id:string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(id))),b=>b.toString(16).padStart(2,"0")).join("");
}
function quotaRejected(response:Response, data:Record<string,any>) {
  // Only an explicit router admission refusal, never generic HTTP 429,
  // upstream error, incomplete stream, or a response with generation data.
  return response.status===429 && data.error?.code===429 &&
    ["openrouter_free_tier_per_minute","openrouter_free_tier_per_day"].includes(data.error?.metadata?.limit_source) &&
    !data.error.metadata.provider_name && !data.id && !data.choices && !data.usage;
}
/** Actual Agents language-model binding seam, not an additional agent loop.
 * Buffer exactly one complete chat response before exposing tool calls to SDK.
 * A lost response leaves the durable pending reservation sticky. */
export function makePilotHybridBinding(binding:Ai, context:(session:string)=>Promise<PilotContext>,
  loadKey:()=>Promise<string|undefined>, request:typeof fetch=fetch):Ai {
  const raw=binding as unknown as RawBinding;
  return {
    get aiGatewayLogId(){return null;},
    async fetch(){throw Error("PILOT_NATIVE_GATEWAY_FORBIDDEN");},
    async run(model:string,input:unknown,options?:RunOptions) {
      check(model===PILOT_GLM && options?.returnRawResponse===true,"PILOT_CARRIER_REQUIRED");
      const session=new Headers(options.extraHeaders).get("x-opencode-session-id");
      check(session,"PILOT_SESSION_REQUIRED");
      const c=await context(session);
      check(c.policy.hybrid?.session===session && pilotDispatchEvidenceValid(c.policy,c.proof),"PILOT_DISPATCH_STOP");
      const body=shape(input);
      const key=await loadKey();
      const makeIntent=(selection:string):InferenceIntent=>({requestId:c.grant.id,operationId:"rc-start-"+c.grant.id,
        callId:crypto.randomUUID(),attemptId:"attempt_1",selection,
        inputTokenCeiling:selection===PILOT_BACKUP?PILOT_GLM_BILLABLE_INPUT_CEILING:PILOT_INPUT_TOKENS,outputTokenCeiling:PILOT_OUTPUT_TOKENS});
      const selection=await pilotProviderSelection(c.storage,c.grant,c.policy,makeIntent(PILOT_FREE),!key);
      const one=async(selection:string):Promise<Response|null>=>{
        const fresh=await context(session);
        check(fresh.grant.token===c.grant.token&&fresh.grant.generation===c.grant.generation&&fresh.proof.preparationDigest===c.proof.preparationDigest,"PILOT_PREPARATION_CHANGED");
        const i=makeIntent(selection);
        const payload=selection===PILOT_FREE?{...body,model:"openrouter/free",max_tokens:PILOT_OUTPUT_TOKENS,n:1,stream:false,
          provider:{max_price:{prompt:0,completion:0,request:0,image:0,audio:0},require_parameters:true,allow_fallbacks:false}}:
          {...body,max_completion_tokens:PILOT_OUTPUT_TOKENS,n:1,stream:false,parallel_tool_calls:false};
        const encoded=JSON.stringify(payload);
        // Size is a request-shape control only; GLM reserves the documented
        // context ceiling, Free has zero price. Both require post-usage proof.
        check(new TextEncoder().encode(encoded).length<=c.proof.maxWireBytes,"PILOT_INPUT_WIRE_LIMIT");
        const remaining=Math.min(120_000,c.policy.hybrid!.workUntil-Date.now(),c.proof.validUntil-Date.now());
        check(remaining>0 && !options.signal?.aborted,"PILOT_DEADLINE");
        const signal=AbortSignal.any([AbortSignal.timeout(remaining),...(options.signal?[options.signal]:[])]);
        const reservation=await reserveInference(c.storage,c.grant,i,c.policy);
        check(reservation.kind==="reserved","PILOT_DUPLICATE_CALL");
        const dispatch=await beginInferenceDispatch(c.storage,c.grant,i,c.policy,c.proof);
        check(dispatch.proceed,"PILOT_DUPLICATE_DISPATCH");
        try{
          check(!signal.aborted,"PILOT_DEADLINE");
          let response:Response;
          if(selection===PILOT_FREE){
            check(key,"PILOT_FREE_KEY_MISSING");
            response=await pilotFetchNoRedirect(request,ENDPOINT,{method:"POST",signal,
              headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
              body:encoded});
          }else{
            check(selection===PILOT_BACKUP,"PILOT_PROVIDER_FORBIDDEN");
            response=await raw.run(PILOT_GLM,payload,{returnRawResponse:true,signal});
          }
          check(!signal.aborted,"PILOT_DEADLINE");
          let data=await readJson(response);
          if(selection===PILOT_FREE && quotaRejected(response,data)){
            await rejectInferenceBeforeGeneration(c.storage,i,{origin:"trusted-provider-adapter",beforeGeneration:true,
              code:"429",preGenerationSource:data.error.metadata.limit_source});
            return null;
          }
          check(response.ok,"PILOT_PROVIDER_REJECTED");
          if(selection===PILOT_BACKUP && data.success===true && data.result)data=obj(data.result);
          const u=obj(data.usage);
          check(typeof data.id==="string" && data.id.length>0 && data.id.length<=256 &&
            Array.isArray(data.choices)&&data.choices.length===1 &&
            ["stop","tool_calls","length"].includes(data.choices[0]?.finish_reason),"PILOT_COMPLETION_UNVERIFIED");
          check(Number.isSafeInteger(u.prompt_tokens)&&u.prompt_tokens>=0&&Number.isSafeInteger(u.completion_tokens)&&u.completion_tokens>=0&&
            Number.isSafeInteger(u.total_tokens)&&u.total_tokens>=u.prompt_tokens+u.completion_tokens,"PILOT_USAGE_UNVERIFIED");
          const output=Math.max(u.completion_tokens,u.total_tokens-u.prompt_tokens);
          const reasoning=u.completion_tokens_details?.reasoning_tokens;
          check(reasoning===undefined||(Number.isSafeInteger(reasoning)&&reasoning>=0&&reasoning<=output),"PILOT_REASONING_USAGE_UNVERIFIED");
          check(u.prompt_tokens<=PILOT_INPUT_TOKENS&&output<=PILOT_OUTPUT_TOKENS,"PILOT_TOKEN_LIMIT");
          if(selection===PILOT_FREE)check(u.cost===0&&typeof data.model==="string"&&data.model.length>0&&data.model.length<=160,"PILOT_FREE_COST_UNVERIFIED");
          else check(data.model===PILOT_GLM,"PILOT_GLM_MODEL_UNVERIFIED");
          const result=Response.json(data);
          check(!signal.aborted,"PILOT_DEADLINE");
          await settleInference(c.storage,i,{origin:"trusted-provider-adapter",receiptId:await receiptId(data.id),
            inputTokens:u.prompt_tokens,outputTokens:output,actualModel:selection===PILOT_FREE?data.model:PILOT_GLM});
          return result;
        }catch(error){
          // Never retry or switch on a timeout, ambiguous outcome or bad receipt.
          // Preserve the full reservation and block effects even if Free was rated zero.
          const reason=error instanceof Error && ["PILOT_TOKEN_LIMIT","PILOT_FREE_COST_UNVERIFIED","PILOT_GLM_MODEL_UNVERIFIED"].includes(error.message)
            ? error.message : "PILOT_PROVIDER_OUTCOME_UNKNOWN";
          await markInferenceUnknown(c.storage,i,reason);
          throw Error("PILOT_PROVIDER_OUTCOME_UNKNOWN");
        }
      };
      const result=await one(selection);
      if(result)return result;
      check(selection===PILOT_FREE,"PILOT_FALLBACK_INVALID");
      const backup=await one(PILOT_BACKUP);
      check(backup,"PILOT_FALLBACK_INVALID");return backup;
    }
  } as unknown as Ai;
}
/** Only installed in the explicitly reserved supervisor lane. Deny other native
 * model transports and tools; the binding above is the sole allowed output. */
export function pilotHybridPlugin(session:string, authorize:(session:string)=>Promise<unknown>):Plugin.Plugin{
  return {id:"opencode-cloud.pilot-hybrid",async setup(ctx){
    const verify=async(id:string)=>{check(id===session,"PILOT_SESSION_FORBIDDEN");await authorize(id);};
    await ctx.session.hook("model.request",async input=>{
      await verify(input.sessionID);
      check(input.model.providerID==="cloudflare"&&input.model.id===PILOT_GLM,"PILOT_CARRIER_REQUIRED");
    });
    await ctx.session.hook("retry",input=>{input.decision={retry:false};});
    await ctx.session.hook("http.request",()=>{throw Error("PILOT_NATIVE_HTTP_FORBIDDEN");});
    await ctx.session.hook("context",async input=>{
      await verify(input.sessionID);
      for(const k of Object.keys(input.tools))if(!allowedTools.has(k))delete input.tools[k];
    });
    await ctx.tool.hook("execute.before",async input=>{
      await verify(input.sessionID);check(allowedTools.has(input.tool),"PILOT_TOOL_FORBIDDEN");
    });
  }};
}

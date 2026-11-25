import type { Plugin } from "@opencode/plugin";
import { PILOT_GLM, type BudgetPolicy, type PaidPreflight } from "./supervisor-inference-budget";
import { dispatchNormalInference, normalHttpSender } from "./metralla-m04-adapter";
import { readBoundedJson } from "./pilot-http";
import type { StartGrant } from "./supervisor-admission";
import type { NormalRoute } from "./metralla-m04-policy";

const ALLOWED=new Set(["linux","inspect_linux","github","repo_info","repo_read","repo_review","repo_pr_search","repo_pr_info","repo_issue_info","repo_pr_files","repo_pr_reviews","repo_checks"]);
export type NormalContext={storage:DurableObjectStorage;grant:StartGrant;policy:BudgetPolicy;preflight:PaidPreflight;
  selection:string;operationId:string;contextBoundEvidence:string};
function check(ok:unknown,code:string):asserts ok{if(!ok)throw Error(code);}
function record(x:unknown):Record<string,any>{check(x&&typeof x==="object"&&!Array.isArray(x),"NORMAL_NATIVE_PAYLOAD");return x as Record<string,any>;}
type RawBinding={run(model:string,input:Record<string,unknown>,options:{returnRawResponse:true;signal:AbortSignal}):Promise<Response>};
export function makeNormalMeteredBinding(binding:Ai,context:(id:string)=>Promise<NormalContext>,loadKey:()=>Promise<string|undefined>,request:typeof fetch=fetch):Ai{
  const raw=binding as unknown as RawBinding;
  return {get aiGatewayLogId(){return null;},async fetch(){throw Error("NORMAL_NATIVE_GATEWAY_FORBIDDEN");},
    async run(model:string,input:unknown,options?:{returnRawResponse?:boolean;extraHeaders?:Record<string,string>;signal?:AbortSignal}){
      check(model===PILOT_GLM&&options?.returnRawResponse===true,"NORMAL_CARRIER_REQUIRED");
      const session=new Headers(options.extraHeaders).get("x-opencode-session-id");
      check(session,"NORMAL_SESSION_REQUIRED");const c=await context(session);
      const route=c.policy.normal?.routes[c.selection];
      check(route&&/^[a-f0-9]{64}$/.test(c.contextBoundEvidence),"NORMAL_CONTEXT_BOUND_UNVERIFIED");
      const p=record(input);
      check(Array.isArray(p.messages)&&p.messages.length>0&&p.messages.length<=128,"NORMAL_MESSAGES");
      for(const m of p.messages){const x=record(m);check(["system","user","assistant","tool","developer"].includes(x.role)&&
        (x.content==null||typeof x.content==="string"||Array.isArray(x.content)&&x.content.every((v:unknown)=>{const q=record(v);return q.type==="text"&&typeof q.text==="string";})),"NORMAL_MEDIA_OR_ROLE");}
      const tools=p.tools??[];check(Array.isArray(tools)&&tools.length<=32&&tools.every((v:unknown)=>{const x=record(v);return x.type==="function"&&ALLOWED.has(x.function?.name);}),"NORMAL_TOOL_FORBIDDEN");
      // Reserve the entire independently attested provider context ceiling.
      // This is not a tokenizer estimate or an attestation created by the model.
      const out=Math.min(route.maxOutputTokens,typeof p.max_tokens==="number"&&Number.isSafeInteger(p.max_tokens)&&p.max_tokens>0?p.max_tokens:route.maxOutputTokens);
      let send:(r:NormalRoute,body:string,signal:AbortSignal)=>Promise<Response>;
      if(route.providerID==="openrouter"){
        const key=await loadKey();check(key,"NORMAL_OPENROUTER_KEY_REQUIRED");
        send=normalHttpSender(request,{endpoint:"https://openrouter.ai/api/v1/chat/completions",providerID:route.providerID,modelID:route.modelID,headers:{Authorization:"Bearer "+key}});
      }else{
        check(route.providerID==="cloudflare","NORMAL_PROVIDER_FORBIDDEN");
        send=async(r,body,signal)=>{
          const payload=record(JSON.parse(body));delete payload.model;payload.max_completion_tokens=payload.max_tokens;delete payload.max_tokens;
          const response=await raw.run(r.modelID,payload,{returnRawResponse:true,signal});
          const data=record(await readBoundedJson(response,r.maxResponseBytes,signal));
          return Response.json(data.success===true&&data.result?data.result:data,{status:response.status});
        };
      }
      const result=await dispatchNormalInference({...c,boundInputTokens:()=>route.maxInputTokens,send},
        {requestId:c.grant.id,operationId:c.operationId,callId:crypto.randomUUID(),attemptId:"attempt_1",selection:c.selection,inputTokenCeiling:route.maxInputTokens,outputTokenCeiling:out},
        p.messages,tools,options.signal);
      check(result.kind==="settled","NORMAL_INFERENCE_NOT_SETTLED");return Response.json(result.data);
    }} as unknown as Ai;
}
export function normalMeteredPlugin(authorize:(session:string)=>Promise<unknown>):Plugin.Plugin{
 return {id:"opencode-cloud.normal-metered",async setup(ctx){
   await ctx.session.hook("model.request",async input=>{await authorize(input.sessionID);check(input.model.providerID==="cloudflare"&&input.model.id===PILOT_GLM,"NORMAL_CARRIER_REQUIRED");});
   await ctx.session.hook("retry",input=>{input.decision={retry:false};});
   await ctx.session.hook("http.request",()=>{throw Error("NORMAL_NATIVE_HTTP_FORBIDDEN");});
   await ctx.session.hook("context",async input=>{await authorize(input.sessionID);for(const k of Object.keys(input.tools))if(!ALLOWED.has(k))delete input.tools[k];});
   await ctx.tool.hook("execute.before",async input=>{await authorize(input.sessionID);check(ALLOWED.has(input.tool),"NORMAL_TOOL_FORBIDDEN");});
 }};
}

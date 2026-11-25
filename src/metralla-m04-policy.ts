/** M04: normal-lane extension of the existing T07 transaction. No IO, scheduler or second ledger. */
export type NormalRound = { taskIds: string[]; maxMicroUsd: number; maxCalls: number; maxInflight: number };
export type NormalRoute = { providerID: string; modelID: string; tools: true; registered: true;
  evidenceId: string; validUntil: number; maxInputTokens: number; maxOutputTokens: number;
  maxWireBytes: number; maxResponseBytes:number; timeoutMs:number; requestsPerMinute: number };
export type NormalPolicy = { validUntil: number; maxCalls: number; maxCallsPerTask: number;
  maxInflight: number; rounds: Record<string, NormalRound>; routes: Record<string,NormalRoute>; fallbacks?:Record<string,string[]> };
type Money = { confirmed: number; reserved: number; unknown: number };
type RoundState = Money & { calls:number; active:number };
export type NormalState = { calls:number; active:number; rounds:Record<string,RoundState>;
  tasks:Record<string,{calls:number;active:number}>; dispatches:Record<string,number[]> };
type Intent = {requestId:string;selection:string;inputTokenCeiling:number;outputTokenCeiling:number;wireBytes?:number};
type Allowance = {providerID:string;modelID:string};
const id = /^[a-f0-9]{16}$/;
const key = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const integer=(x:unknown,min:number,max:number)=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=min&&x<=max;
function check(x:unknown,m:string):asserts x {if(!x)throw Error(m);}
export function validateNormalPolicy(p:NormalPolicy,total:number,models:Record<string,Allowance>){
  check(p&&integer(p.validUntil,1,Number.MAX_SAFE_INTEGER)&&integer(p.maxCalls,1,10000)&&
    integer(p.maxCallsPerTask,1,p.maxCalls)&&integer(p.maxInflight,1,10),"NORMAL_POLICY_INVALID");
  const rounds=Object.entries(p.rounds??{}), routes=Object.entries(p.routes??{}), tasks=new Set<string>(), upstream=new Set<string>();
  check(rounds.length>0&&rounds.length<=10&&routes.length>0&&routes.length===Object.keys(models).length&&routes.length<=16,"NORMAL_POLICY_INVALID");
  for(const [name,r] of rounds){
    check(key.test(name)&&Array.isArray(r.taskIds)&&r.taskIds.length>0&&r.taskIds.length<=10&&
      integer(r.maxMicroUsd,1,total)&&integer(r.maxCalls,1,p.maxCalls)&&integer(r.maxInflight,1,p.maxInflight),"NORMAL_ROUND_INVALID");
    for(const t of r.taskIds){check(id.test(t)&&!tasks.has(t),"NORMAL_TASK_SCOPE_CONFLICT");tasks.add(t);}
  }
  for(const [name,r] of routes){
    const m=Object.prototype.hasOwnProperty.call(models,name)?models[name]:undefined;
    check(m&&r.providerID===m.providerID&&r.modelID===m.modelID&&r.tools===true&&r.registered===true&&
      typeof r.evidenceId==="string"&&/^[a-f0-9]{64}$/.test(r.evidenceId)&&
      integer(r.validUntil,1,p.validUntil)&&integer(r.maxInputTokens,1,1048576)&&
      integer(r.maxOutputTokens,1,1048576)&&integer(r.maxWireBytes,1,4*1024*1024)&&
      integer(r.maxResponseBytes,1,4*1024*1024)&&integer(r.timeoutMs,1,120000)&&integer(r.requestsPerMinute,1,1000),"NORMAL_ROUTE_UNVERIFIED");
    const upstreamId=r.providerID+":"+r.modelID;
    check(!upstream.has(upstreamId),"NORMAL_ROUTE_ALIAS_DENIED");upstream.add(upstreamId);
  }
  for(const [from,targets] of Object.entries(p.fallbacks??{})){
    check(Object.hasOwn(p.routes,from)&&Array.isArray(targets)&&targets.length<=3&&new Set(targets).size===targets.length&&
      targets.every(to=>to!==from&&Object.hasOwn(p.routes,to)&&!p.fallbacks?.[to]?.length),"NORMAL_FALLBACK_POLICY_INVALID");
  }
}
export function newNormalState(p:NormalPolicy):NormalState{
  return {calls:0,active:0,rounds:Object.fromEntries(Object.keys(p.rounds).map(k=>[k,{confirmed:0,reserved:0,unknown:0,calls:0,active:0}])),
    tasks:Object.fromEntries(Object.values(p.rounds).flatMap(r=>r.taskIds.map(t=>[t,{calls:0,active:0}]))),dispatches:{}};
}
function roundFor(p:NormalPolicy,i:Intent){
  const pair=Object.entries(p.rounds).find(([,r])=>r.taskIds.includes(i.requestId));
  check(pair,"NORMAL_TASK_OUTSIDE_ROUND");return pair;
}
function routeFor(p:NormalPolicy,i:Intent,now:number){
  const r=Object.prototype.hasOwnProperty.call(p.routes,i.selection)?p.routes[i.selection]:undefined;
  check(r&&now<p.validUntil&&now<r.validUntil,"NORMAL_ROUTE_OR_DEADLINE_STOP");
  check(integer(i.wireBytes,1,r.maxWireBytes)&&integer(i.inputTokenCeiling,1,r.maxInputTokens)&&
    integer(i.outputTokenCeiling,1,r.maxOutputTokens),"NORMAL_WIRE_OR_TOKEN_LIMIT");return r;
}
export function normalReserve(p:NormalPolicy,s:NormalState,i:Intent,exposure:number,now:number){
  routeFor(p,i,now);const [name,r]=roundFor(p,i),state=s.rounds[name],task=s.tasks[i.requestId];
  check(state&&task,"NORMAL_LEDGER_CORRUPT");
  check(s.calls<p.maxCalls&&state.calls<r.maxCalls&&task.calls<p.maxCallsPerTask,"NORMAL_CALL_LIMIT");
  check(s.active<p.maxInflight&&state.active<r.maxInflight&&task.active===0,"NORMAL_BACKPRESSURE");
  check(state.confirmed+state.reserved+state.unknown+exposure<=r.maxMicroUsd,"NORMAL_ROUND_BUDGET_EXHAUSTED");
  s.calls++;state.calls++;task.calls++;s.active++;state.active++;task.active++;state.reserved+=exposure;
}
export function normalDispatch(p:NormalPolicy,s:NormalState,i:Intent,now:number){
  const r=routeFor(p,i,now);roundFor(p,i);
  const k=r.providerID+":"+r.modelID;
  const stamps=(s.dispatches[k]??[]).filter(t=>t>now-60000);
  check(stamps.every(t=>Number.isSafeInteger(t)&&t<=now),"NORMAL_CLOCK_REGRESSION");
  check(stamps.length<r.requestsPerMinute,"NORMAL_QUOTA_STOP");
  stamps.push(now);s.dispatches[k]=stamps;
}
/** unknown retains its active slot; terminal evidence alone frees it. */
export function normalRoundMove(p:NormalPolicy,s:NormalState,i:Intent,from:"reserved"|"unknown",to:"unknown"|"confirmed"|"released",exposure:number,charge=0){
  const [name]=roundFor(p,i),r=s.rounds[name],task=s.tasks[i.requestId];
  check(task&&r&&r[from]>=exposure&&s.active>0&&r.active>0&&task.active===1,"NORMAL_LEDGER_CORRUPT");
  r[from]-=exposure;
  if(to==="unknown"){r.unknown+=exposure;return;}
  if(to==="confirmed")r.confirmed+=charge;
  s.active--;r.active--;task.active--;
}

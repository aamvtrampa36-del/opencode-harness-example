/** M04 reproducible upper-bound estimator. No network/current prices/implicit free quota.
 * All integer quantities are in declared base units; all rates in micro-USD.
 * Unknown rate, service use, rounding or pricing evidence => STOP, not zero. */
export const METERS=Object.freeze({
  inputTokens:"token",outputTokens:"token",cacheReadTokens:"token",cacheWriteTokens:"token",
  providerCalls:"call",inferenceMilliseconds:"ms",containerVcpuMilliseconds:"vCPU-ms",
  containerMemoryMiBMilliseconds:"MiB-ms",containerDiskMiBMilliseconds:"MiB-ms",
  workerRequests:"request",workerCpuMilliseconds:"ms",doRequests:"request",
  doMemoryMiBMilliseconds:"MiB-ms",doReadRows:"row",doWrittenRows:"row",
  doStorageByteMilliseconds:"byte-ms",ciSeconds:"second",egressBytes:"byte",logBytes:"byte"
});
const keys=Object.keys(METERS);
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const integer=(x,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const check=(x,m)=>{if(!x)throw Error(m)};
const ceil=(x,y)=>(x+y-1n)/y;
const safe=x=>{check(x<=BigInt(Number.MAX_SAFE_INTEGER),'ESTIMATE_OVERFLOW');return Number(x)};
function quantities(x,label){
  check(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length,'MISSING_METERS:'+label);
  for(const k of keys)check(own(x,k)&&integer(x[k]),'METER_UNKNOWN:'+label+':'+k);
  return x;
}
function rate(k,t,now){
  check(t&&t.unit===METERS[k]&&integer(t.microUsd)&&integer(t.unitsPerCharge,1)&&
    ['proportional','block'].includes(t.rounding)&&typeof t.revision==='string'&&t.revision.trim()&&
    typeof t.evidenceId==='string'&&/^[a-f0-9]{64}$/.test(t.evidenceId)&&
    integer(t.measuredAt,0,now)&&integer(t.validUntil,now+1),'PRICE_UNKNOWN_OR_STALE:'+k);
  // No implicit free quota. A true zero rate still needs attested pricing/disabled-route proof.
  check(t.microUsd!==0||['documented-zero-rate','verified-disabled-route'].includes(t.zeroBasis),'ZERO_RATE_UNPROVEN:'+k);
  return t;
}
function charge(k,q,t,roundingEvents){
  check(!(q>0&&t.zeroBasis==='verified-disabled-route'),'DISABLED_METER_USED:'+k);
  if(!q||!t.microUsd)return 0n;
  const amount=BigInt(q),unit=BigInt(t.unitsPerCharge),price=BigInt(t.microUsd);
  // Charge-block and micro-dollar rounding can occur per call/request/billing window.
  // events is a conservative upper bound on independently rounded charges; at
  // worst every base unit is a charge event, so absent evidence use q.
  const events=BigInt(roundingEvents);
  if(t.rounding==='block')return (ceil(amount,unit)+(events>0n?events-1n:0n))*price;
  return ceil(amount*price,unit)+(events>0n?events-1n:0n);
}
function bill(q,events,rates){
  let total=0n;const detail={};
  for(const k of keys){const n=q[k];check(integer(events[k],n?1:0,n),'ROUNDING_EVENTS_INVALID:'+k);
    const c=charge(k,n,rates[k],events[k]);detail[k]=safe(c);total+=c;}
  return {total:safe(total),detail};
}
/** Includes overhead independently of inference. Caps are explicit, never
 * inherited from PILOTO-01. Each plan is immutable before execution.
 * quantity and roundingEvents include cache tokens, time, storage and overhead.
 * No estimator certifies account hard-stop or actual provider capacity. */
export function estimateCampaign(plan,now){
  check(integer(now,0)&&plan&&plan.schema==='metralla-m04-estimate-v1'&&
    integer(plan.totalCapMicroUsd,1)&&integer(plan.residualMicroUsd,1)&&
    typeof plan.pricingRevision==='string'&&plan.pricingRevision.trim()&&
    plan.tariffs&&Object.keys(plan.tariffs).length===keys.length&&
    Array.isArray(plan.rounds)&&plan.rounds.length>0&&plan.rounds.length<=10,'ESTIMATE_PLAN_INVALID');
  const tariffs=Object.fromEntries(keys.map(k=>[k,rate(k,plan.tariffs[k],now)]));
  const ids=new Set(),rounds=[];let cumulative=BigInt(plan.residualMicroUsd);
  for(const r of plan.rounds){
    check(r&&typeof r.id==='string'&&/^[a-z0-9_-]{1,32}$/.test(r.id)&&!ids.has(r.id)&&
      [1,2,4,10].includes(r.tasks)&&integer(r.taskCapMicroUsd,1,plan.totalCapMicroUsd)&&
      integer(r.roundCapMicroUsd,1,plan.totalCapMicroUsd)&&integer(r.residualMicroUsd,1)&&
      integer(r.maxConcurrent,1,r.tasks)&&integer(r.maxDurationMs,1)&&integer(r.maxCallsPerTask,1)&&
      integer(r.maxInputTokens,1)&&integer(r.maxOutputTokens,1)&&integer(r.maxWireBytes,1)&&
      integer(r.maxResponseBytes,1)&&integer(r.requestsPerMinute,1),'ROUND_PLAN_INVALID');
    ids.add(r.id);
    const task=quantities(r.perTask,'task'),shared=quantities(r.shared,'shared');
    const te=quantities(r.perTaskRoundingEvents,'task-rounding'),se=quantities(r.sharedRoundingEvents,'shared-rounding');
    check(task.providerCalls===r.maxCallsPerTask&&
      BigInt(task.inputTokens)+BigInt(task.cacheReadTokens)+BigInt(task.cacheWriteTokens)>=BigInt(r.maxCallsPerTask)*BigInt(r.maxInputTokens)&&
      BigInt(task.outputTokens)>=BigInt(r.maxCallsPerTask)*BigInt(r.maxOutputTokens)&&
      task.inferenceMilliseconds>=r.maxDurationMs,'INFERENCE_CEILING_NOT_COVERED');
    const taskCost=bill(task,te,tariffs),sharedCost=bill(shared,se,tariffs);
    const cost=BigInt(taskCost.total)*BigInt(r.tasks)+BigInt(sharedCost.total)+BigInt(r.residualMicroUsd);
    cumulative+=cost;
    const blockers=[];
    if(taskCost.total>r.taskCapMicroUsd)blockers.push('TASK_CAP');
    if(cost>BigInt(r.roundCapMicroUsd))blockers.push('ROUND_CAP');
    if(cumulative>BigInt(plan.totalCapMicroUsd))blockers.push('LOT_CAP');
    rounds.push({id:r.id,tasks:r.tasks,maxConcurrent:r.maxConcurrent,taskCostMicroUsd:taskCost.total,
      sharedCostMicroUsd:sharedCost.total,roundCostMicroUsd:safe(cost),cumulativeMicroUsd:safe(cumulative),
      taskCostByMeter:taskCost.detail,sharedCostByMeter:sharedCost.detail,blockers});
  }
  return {schema:'metralla-m04-estimate-result-v1',decision:rounds.some(r=>r.blockers.length)?'STOP':'OFFLINE_ESTIMATE_WITHIN_CAPS',
    pricingRevision:plan.pricingRevision,totalCapMicroUsd:plan.totalCapMicroUsd,totalUpperMicroUsd:safe(cumulative),
    residualMicroUsd:plan.residualMicroUsd,rounds,liveDispatchAuthorized:false,accountHardStopVerified:false};
}

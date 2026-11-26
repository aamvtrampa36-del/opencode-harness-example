import { manifest, validManifest, verifyFixtureOutput } from './manifest.mjs';
import { measureOverlap, evaluateTrace, OFFLINE_LIMITS, LIVE_LIMITS } from '../evaluate.mjs';
import { digest } from '../live-evidence.mjs';
import { verifyIntegratedRound } from './integrated-round.mjs';

// T10 thresholds were fixed before M07. Fixture cost and side effects are zero.
export const LIMITS = Object.freeze({ minOverlapMs: OFFLINE_LIMITS.minOverlapMs,
  maxDurationMs: OFFLINE_LIMITS.maxTaskDurationMs, maxStartP95Ms: OFFLINE_LIMITS.maxStartP95Ms,
  maxStatusP95Ms: OFFLINE_LIMITS.maxStatusP95Ms, maxEvents: 5000, maxCostUsd: 0 });
export const LIMITS_DIGEST = digest(LIMITS);
const sources = Object.freeze({ received:'admission', reserved:'admission', queued:'admission',
  activity_start:'executor', activity_end:'executor', status:'observer', output:'executor',
  readback:'artifact-collector', github:'github-collector', logical_close:'admission',
  physical_close:'executor-observer', cost:'meter', tdd_red:'executor', tdd_green:'executor',
  oom:'observer', restart:'observer', cancelled:'admission', response_lost:'observer' });
const identityFields = ['fixtureId','requestId','sessionId','operationId','project','version'];
const pct = (a,p) => a.length ? [...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1] : null;
const exact = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const safeTime = n => Number.isSafeInteger(n) && n>=0;
const bounded = n => typeof n === 'string' && n.length>0 && n.length<=256;
const one = (events,type) => events.filter(e=>e.type===type);

export function evaluateFixture(m, trace) {
  const failures=[];
  const fail=(code,subject)=>failures.push({code,subject});
  const rejected=()=>({pass:false,fixturePass:false,livePass:false,evidenceClass:'fixture',failures});
  if (!validManifest(m) || !trace || trace.mode!=='fixture' || trace.schema!=='metralla.m07.evidence.v1' ||
      trace.manifestDigest!==m.digest || trace.limitsDigest!==LIMITS_DIGEST || !bounded(trace.version) ||
      !Array.isArray(trace.tasks) || trace.tasks.length!==m.size || !Array.isArray(trace.events) ||
      trace.events.length>LIMITS.maxEvents || trace.events.some(e=>!e || typeof e!=='object')) {
    fail('EVIDENCE_FORMAT','round'); return rejected();
  }
  const unique = Object.fromEntries(identityFields.filter(x=>x!=='version').map(x=>[x,new Set()]));
  const byRequest=new Map(), intervals=[], starts=[], durations=[], statuses=[], chronology=[], taskResults=[];
  let oom=0,restarts=0,queued=0,verifiedOutputs=0,closed=0,totalCost=0;
  for(const [i,t] of trace.tasks.entries()){
    const spec=m.tasks[i], failureStart=failures.length;
    const result={fixtureId:spec.fixtureId,pass:false,outputVerified:false,closed:false,activityIntervals:0};
    taskResults.push(result);
    if(!t || t.fixtureId!==spec.fixtureId || t.project!==spec.scope.project || t.version!==trace.version ||
       !['requestId','sessionId','operationId'].every(k=>bounded(t[k])&&t[k].startsWith('fixture:'))) {
      fail('TASK_IDENTITY',spec.fixtureId); continue;
    }
    for(const [k,set] of Object.entries(unique)){
      if(set.has(t[k])) fail('DUPLICATE_ID',k+':'+t[k]);
      set.add(t[k]);
    }
    byRequest.set(t.requestId,t);
    const stream=trace.events.filter(e=>e.requestId===t.requestId).sort((a,b)=>a.seq-b.seq);
    for(const [j,e] of stream.entries()){
      if(identityFields.some(k=>e[k]!==t[k]) || e.manifestDigest!==m.digest || e.source!==sources[e.type] || !sources[e.type])
        fail('CROSS_SCOPE_OR_SOURCE',t.fixtureId);
      if(e.seq!==j+1 || !safeTime(e.atMs) || (j && e.atMs<stream[j-1].atMs)) fail('CLOCK_OR_SEQUENCE',t.fixtureId);
      if(e.type==='oom') {oom++;fail('OOM',t.fixtureId);}
      if(e.type==='restart') {restarts++;fail('RESTART_UNRECONCILED',t.fixtureId);}
      if(['cancelled','response_lost'].includes(e.type))fail('UNEXPECTED_TERMINAL',t.fixtureId);
    }
    const requireOne=type=>{const v=one(stream,type);if(v.length!==1)fail('MISSING_OR_DUPLICATE_'+type.toUpperCase(),t.fixtureId);return v[0];};
    const received=requireOne('received'), reserve=requireOne('reserved'), queue=requireOne('queued');
    const output=requireOne('output'), readback=requireOne('readback'), logical=requireOne('logical_close'),
      physical=requireOne('physical_close'), cost=requireOne('cost');
    if(queue)queued++;
    if(!received||!reserve||!queue||!output||!readback||!logical||!physical||!cost) continue;
    const ordered=[received,reserve,queue,output,readback,physical,logical,cost];
    if(ordered.some((e,j)=>j>0&&e.seq<=ordered[j-1].seq))fail('LIFECYCLE_ORDER',t.fixtureId);
    if(reserve.effectCount!==0 || reserve.reservation!=='fixture-only')fail('RESERVATION',t.fixtureId);
    const opened=new Map(), used=new Set(), own=[];
    for(const e of stream){
      if(e.type==='activity_start'){
        if(!bounded(e.callId)||used.has(e.callId)||e.seq<=queue.seq||e.seq>=output.seq)fail('ACTIVITY_START',t.fixtureId);
        else {used.add(e.callId);opened.set(e.callId,e);}
      }
      if(e.type==='activity_end'){
        const start=opened.get(e.callId);opened.delete(e.callId);
        if(!start||e.seq>=output.seq||e.atMs<=start.atMs||e.exitCode!==0||e.tool!==start.tool||!bounded(e.tool))
          fail('ACTIVITY_END',t.fixtureId);
        else own.push({requestId:t.requestId,start:start.atMs,end:e.atMs});
      }
    }
    if(opened.size||!own.length)fail('NO_CLOSED_ACTIVITY',t.fixtureId);
    intervals.push(...own);result.activityIntervals=own.length;
    const probes=one(stream,'status');
    if(!probes.length||!probes.some(e=>own.some(a=>a.start<=e.atMs&&e.atMs<a.end)))fail('NO_STATUS_DURING_ACTIVITY',t.fixtureId);
    for(const e of probes){
      if(e.status!=='ok'||!safeTime(e.latencyMs))fail('STATUS',t.fixtureId);
      else statuses.push(e.latencyMs);
    }
    if(spec.kind==='tdd'){
      const red=requireOne('tdd_red'),green=requireOne('tdd_green');
      if(!red||!green||red.exitCode!==1||green.exitCode!==0||red.seq>=green.seq||
         !own.some(a=>a.start<=red.atMs&&green.atMs<=a.end))fail('TDD_EXITS',t.fixtureId);
    }
    const github=one(stream,'github');
    if(github.length!==(spec.scope.github?1:0) || github.some(e=>e.seq<=readback.seq||e.seq>=physical.seq))
      fail('GITHUB_SCOPE_OR_ORDER',t.fixtureId);
    if(!exact(output.artifact,readback.artifact)||!verifyFixtureOutput(spec,{
      schema:'metralla.m07.output.v1',mode:'fixture',fixtureId:t.fixtureId,project:t.project,
      exitCode:output.exitCode,liveEffects:output.liveEffects,readback:{...readback.artifact,source:'fixture-readback'},
      github:github[0]?.receipt??null
    }))fail('OUTPUT_OR_READBACK',t.fixtureId);else {verifiedOutputs++;result.outputVerified=true;}
    if(physical.openProcesses!==0||physical.openOperations!==0||logical.reservationReleased!==true||
       logical.activeSlots!==0||physical.liveEffects!==0)fail('CLOSURE',t.fixtureId);else {closed++;result.closed=true;}
    if(cost.measuredUsd!==0||cost.inferenceCalls!==0||cost.liveEffects!==0)fail('COST_UNKNOWN_OR_OVER',t.fixtureId);
    else totalCost+=cost.measuredUsd;
    starts.push(reserve.atMs-received.atMs);durations.push(logical.atMs-received.atMs);
    if(logical.atMs-received.atMs>LIMITS.maxDurationMs)fail('DURATION',t.fixtureId);
    result.pass=failures.length===failureStart&&result.outputVerified&&result.closed&&result.activityIntervals>0;
    chronology.push({fixtureId:t.fixtureId,receivedAtMs:received.atMs,queuedAtMs:queue.atMs,
      activity:own,logicalCloseAtMs:logical.atMs,physicalCloseAtMs:physical.atMs});
  }
  if(trace.events.some(e=>!byRequest.has(e.requestId)))fail('UNKNOWN_REQUEST','round');
  const overlap=measureOverlap(intervals,m.size);
  if(overlap.maxActive!==m.size||overlap.longestFullMs<LIMITS.minOverlapMs)fail('INSUFFICIENT_OVERLAP','round');
  if(pct(starts,.95)>LIMITS.maxStartP95Ms||pct(statuses,.95)===null||pct(statuses,.95)>LIMITS.maxStatusP95Ms)
    fail('LATENCY','round');
  const metrics={...overlap,oom,restarts,queued,verifiedOutputs,closed,totalCost,
    p50StartMs:pct(starts,.5),p95StartMs:pct(starts,.95),p50StatusMs:pct(statuses,.5),p95StatusMs:pct(statuses,.95),
    p50DurationMs:pct(durations,.5),p95DurationMs:pct(durations,.95),chronology};
  return {pass:failures.length===0,fixturePass:failures.length===0,livePass:false,evidenceClass:'fixture',failures,metrics,taskResults};
}

// Full M07 evidence validation uses the same signed T10 evaluator plus a frozen
// operator plan, independent GitHub and physical/logical closure receipts.
// This is verification of evidence, never permission to submit or spend.
export function assessLiveCandidate(trace,{limits=LIVE_LIMITS,trustedKeys,approval,supplement,journalSeals}={}){
 if(!trace||trace.mode!=='live'||trace.metadata?.simulated===true||trace.metadata?.fixture===true||trace.metadata?.synthetic===true||trace.evidenceClass==='fixture')
   return {pass:false,livePass:false,code:'FIXTURE_OR_MISSING_LIVE'};
 return verifyIntegratedRound(trace,{limits,trustedKeys,approval,supplement,journalSeals});
}

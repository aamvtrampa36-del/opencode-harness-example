import { manifest } from './manifest.mjs';
import { LIMITS_DIGEST } from './evaluator.mjs';

export function fixtureTrace(size,{active=size,stagger=0}={}){
  const m=manifest(size),version='fixture:v1',tasks=[],events=[];
  for(const [i,s] of m.tasks.entries()){
    const t={fixtureId:s.fixtureId,project:s.scope.project,version,requestId:'fixture:req:'+s.fixtureId,
      sessionId:'fixture:session:'+s.fixtureId,operationId:'fixture:op:'+s.fixtureId};
    tasks.push(t);let seq=0;
    const emit=(type,source,atMs,more={})=>events.push({...t,manifestDigest:m.digest,seq:++seq,type,source,atMs,...more});
    const start=10+i*stagger,end=start+100;
    emit('received','admission',0);emit('reserved','admission',1,{effectCount:0,reservation:'fixture-only'});
    emit('queued','admission',2);
    if(i<active){
      emit('activity_start','executor',start,{callId:'fixture:call:'+i,tool:'local-fixture'});
      if(s.kind==='tdd')emit('tdd_red','executor',start+1,{exitCode:1});
      emit('status','observer',start+5,{status:'ok',latencyMs:2});
      if(s.kind==='tdd')emit('tdd_green','executor',end-1,{exitCode:0});
      emit('activity_end','executor',end,{callId:'fixture:call:'+i,tool:'local-fixture',exitCode:0});
    }
    emit('output','executor',end+1,{artifact:{...s.expected},exitCode:0,liveEffects:0});
    emit('readback','artifact-collector',end+2,{artifact:{...s.expected}});
    if(s.scope.github)emit('github','github-collector',end+3,{receipt:{mode:'fixture',effect:'simulated-draft',
      repo:s.scope.github.repo,path:s.scope.github.path,contentSha256:s.expected.sha256,liveWrite:false}});
    emit('physical_close','executor-observer',end+4,{openProcesses:0,openOperations:0,liveEffects:0});
    emit('logical_close','admission',end+5,{reservationReleased:true,activeSlots:0});
    emit('cost','meter',end+6,{measuredUsd:0,inferenceCalls:0,liveEffects:0});
  }
  return {m,trace:{schema:'metralla.m07.evidence.v1',mode:'fixture',version,manifestDigest:m.digest,limitsDigest:LIMITS_DIGEST,tasks,events}};
}

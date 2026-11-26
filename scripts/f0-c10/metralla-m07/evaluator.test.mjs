import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixture, assessLiveCandidate } from './evaluator.mjs';
import { fixtureTrace } from './fixture-trace.mjs';
import { runMock } from '../mock.mjs';
import { evaluateTrace } from '../evaluate.mjs';
import { sha256 } from '../tasks.mjs';
for(const n of [1,2,4,10])test('GREEN fixture '+n,()=>{
  const {m,trace}=fixtureTrace(n),r=evaluateFixture(m,trace);
  assert.equal(r.fixturePass,true,JSON.stringify(r.failures));assert.equal(r.livePass,false);
  assert.equal(r.metrics.maxActive,n);assert.equal(r.metrics.longestFullMs,100);
  assert.equal(r.metrics.closed,n);assert.equal(r.metrics.verifiedOutputs,n);assert.equal(r.metrics.p95StatusMs,2);
});
test('historical RED T10 #118/#119: no verified round',async()=>{
  const r=evaluateTrace(await runMock({size:10,fault:'historical-red'}));
  assert.equal(r.pass,false);
  const {m,trace}=fixtureTrace(10,{active:0});
  const f=evaluateFixture(m,trace);assert.equal(f.pass,false);assert.equal(f.metrics.maxActive,0);
});
test('ten queued, four active',()=>{
  const {m,trace}=fixtureTrace(10,{active:4}),r=evaluateFixture(m,trace);
  assert.equal(r.pass,false);assert.equal(r.metrics.queued,10);assert.equal(r.metrics.maxActive,4);
});
test('nonoverlapping real intervals',()=>{
  const {m,trace}=fixtureTrace(4,{stagger:101}),r=evaluateFixture(m,trace);
  assert.equal(r.pass,false);assert.equal(r.metrics.maxActive,1);
});
const first=(t,type)=>t.events.find(e=>e.type===type);
const mutations={
  'false finished': t=>{t.events=[{type:'completed',verified:true}];},
  'cross session':t=>{first(t,'activity_start').sessionId=t.tasks[1].sessionId;},
  'cross version':t=>{first(t,'activity_end').version='other';},
  'duplicate request':t=>{t.tasks[1].requestId=t.tasks[0].requestId;},
  'duplicate event':t=>{t.events.push({...first(t,'activity_end')});},
  'wrong exit':t=>{first(t,'activity_end').exitCode=1;},
  'corrupt oracle even rehashed':t=>{for(const e of [first(t,'output'),first(t,'readback')]){e.artifact.content='{}';e.artifact.sha256=sha256('{}');e.artifact.size=2;}},
  'missing readback':t=>{t.events=t.events.filter(e=>e.type!=='readback');},
  'wrong github':t=>{first(t,'github').receipt.repo='foreign';},
  'oom':t=>{const e=first(t,'status');e.type='oom';},
  'restart':t=>{const e=first(t,'status');e.type='restart';},
  'over cost':t=>{first(t,'cost').measuredUsd=1;},
  'unknown cost':t=>{delete first(t,'cost').measuredUsd;},
  'missing closure':t=>{t.events=t.events.filter(e=>e.type!=='physical_close');},
  'unclosed process':t=>{first(t,'physical_close').openProcesses=1;},
  'wrong source':t=>{first(t,'readback').source='executor';},
  'retrospective limits':t=>{t.limitsDigest='changed';},
  'unknown event':t=>{first(t,'received').type='bogus';},
  'live masquerade':t=>{t.mode='live';}
};
for(const [name,mutate] of Object.entries(mutations))test('RED '+name,()=>{
  const {m,trace}=fixtureTrace(10);mutate(trace);const r=evaluateFixture(m,trace);
  assert.equal(r.pass,false,name);assert.equal(r.livePass,false);
});
test('live boundary fail closed',()=>{const {trace}=fixtureTrace(10);assert.equal(assessLiveCandidate(trace).livePass,false);assert.equal(assessLiveCandidate({...trace,mode:'live'}).livePass,false);});

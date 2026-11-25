import test from 'node:test';
import assert from 'node:assert/strict';
import { planRound,preflight,dryRun,liveOperatorTemplate,livePreflight,runFixtureRound,collectPage,runControls } from './harness.mjs';
import { fixtureTrace } from './fixture-trace.mjs';
import { evaluateFixture } from './evaluator.mjs';
for(const size of [1,2,4,10]){
  test('dry run zero effects '+size,async()=>{
    const p=planRound(size),d=dryRun(size);assert.deepEqual(d,await runFixtureRound(p,{dry:true}));
    for(const k of ['submissions','readbacks','writes','liveEffects'])assert.equal(d[k],0);
    assert.equal(d.preflight.ok,true);assert.equal(d.livePass,false);
  });
  test('bounded round with independently computed bytes '+size,async()=>{
    const x=await runFixtureRound(planRound(size));
    assert.equal(x.report.fixturePass,true,JSON.stringify(x.report.failures));
    assert.equal(x.livePass,false);assert.equal(x.submissions,size);assert.equal(x.readbacks,size);
    assert.ok(x.peakLocalSubmissions<=size);assert.equal(x.report.metrics.verifiedOutputs,size);
    assert.equal(x.report.metrics.closed,size);assert.equal(x.syntheticActivity,true);
    assert.equal(x.report.metrics.maxActive,size);
    if(size===10){assert.ok(x.pages>1);assert.equal(x.evidence.events.filter(e=>e.type==='github').length,1);}
  });
}
test('preflight refuses retroactive cap, scope, version, reservations, model and missing closure',async()=>{
  for(const mutate of [p=>p.limits={...p.limits,minOverlapMs:0},p=>p.requestedConcurrency=1,p=>p.reservations=0,
    p=>p.priorOpenOperations=1,p=>p.baseline={...p.baseline,model:'paid'},p=>p.baseline={...p.baseline,version:'other'},
    p=>p.manifest={...p.manifest,digest:'bad'},p=>p.authorization='live']){
    const p=planRound(4);mutate(p);assert.equal(preflight(p).ok,false);await assert.rejects(runFixtureRound(p));
  }
});
test('incremental cursor bound, mutation and invalid page rejected',()=>{
  const {trace}=fixtureTrace(10),p=collectPage(trace.events,null,3),q=collectPage(trace.events,p.cursor,3);
  assert.equal(p.rows.length,3);assert.deepEqual(q.rows,trace.events.slice(3,6));
  assert.throws(()=>collectPage(trace.events,'foreign:1'));assert.throws(()=>collectPage(trace.events,null,33));
  trace.events[0].atMs=99;assert.throws(()=>collectPage(trace.events,p.cursor,3));
});
test('controls separate from positive rounds',()=>{
  const results=runControls();assert.equal(results.length,6);assert.ok(results.every(x=>x.ok&&x.countsAsPositive===false));
});
test('live form cannot authorize effect or pass',()=>{
  const t=liveOperatorTemplate(10);assert.equal(t.taskSpecs.length,10);assert.ok(t.taskSpecs.every(x=>x.requestId===null));
  assert.ok(livePreflight(t).missing.includes('effectiveSpendStopReceipt'));assert.equal(livePreflight(t).ok,false);
  assert.equal(livePreflight(Object.fromEntries(Object.keys(t).map(k=>[k,'fake']))).liveAllowed,false);
});
test('negative evidence does not become positive via controls',()=>{
  const {m,trace}=fixtureTrace(10,{active:4});assert.equal(evaluateFixture(m,trace).pass,false);
  assert.ok(runControls().every(x=>x.ok));assert.equal(evaluateFixture(m,trace).livePass,false);
});

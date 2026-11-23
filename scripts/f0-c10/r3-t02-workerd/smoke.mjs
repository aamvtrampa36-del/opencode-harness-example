/**
 * Disposable workerd probe driver. LOCAL LOOPBACK ONLY; never invoke remote Staging.
 * Prepare: node .../smoke.mjs prepare
 * Restart the *local* wrangler dev process with identical --persist-to.
 * Verify: node .../smoke.mjs verify
 * No OpenCode SDK, models, inference, GitHub writes or external DOs.
 */
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8787';
const runId = 'r3t02_';
const id = (n) => runId + n.toString(16).padStart(8, '0');
async function call(path, data, expected = 200) {
  const response = await fetch(base + path, data === undefined ? {signal:AbortSignal.timeout(5000)} :
    {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),
      signal:AbortSignal.timeout(5000)});
  const value = await response.json();
  assert.equal(response.status, expected, path + ' ' + JSON.stringify(value));
  return value;
}
const mode = process.argv[2];
if (!['prepare','verify'].includes(mode)) throw Error('USAGE: prepare|verify; local-only');
assert.equal((await call('/health')).scope, 'local-only');
if (mode === 'prepare') {
  for (const n of [1, 2, 4, 10]) {
    const active = [];
    for (let j = 0; j < n; j++) {
      const k = n * 100 + j;
      await call('/start', {id:id(k)}); active.push(k);
    }
    for (const k of active) {
      for (let i = 0; i < 5; i++) await call('/step',{id:id(k)});
      await call('/finish',{id:id(k)});
    }
    assert.equal((await call('/snapshot')).activeReferences, 0);
  }
  await call('/start',{id:id(999)});
  await call('/step',{id:id(999)});
  const before=await call('/snapshot');
  assert.equal(before.activeReferences,1);
  console.log(JSON.stringify({pass:true,scope:'workerd-single-DO-local',mode,
    rows:before.rows.length,hasRunning:before.rows.some(x=>x.key==='probe:'+id(999)&&x.status==='running'),
    cpuIsolateMeasured:false,memoryIsolateMeasured:false,externalRSSMeasured:false}));
} else {
  const after=await call('/snapshot');
  assert.equal(after.activeReferences,0); // new process/cache, same SQLite persistence
  assert.ok(after.rows.some(x=>x.key==='probe:'+id(999)&&x.status==='running'));
  const negative=await call('/step',{id:id(999)},409);
  assert.equal(negative.error,'RECOVERY_UNCONFIRMED'); // never invent successful recovery
  console.log(JSON.stringify({pass:true,scope:'workerd-single-DO-local',mode,
    retainedDurableRow:true,clearedJSRefs:true,negativeStepFailClosed:true,
    cpuIsolateMeasured:false,memoryIsolateMeasured:false,externalRSSMeasured:false}));
}

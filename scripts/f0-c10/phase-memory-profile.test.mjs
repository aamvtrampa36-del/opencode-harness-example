import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundedStatus, boundMcpResponse, PHASES, measureChildProcess } from './phase-memory-profile.mjs';
const profile=fileURLToPath(new URL('./phase-memory-profile.mjs',import.meta.url));
test('RED: full history copies and closures survive recovery; exit 1 deliberate',()=>{
  const x=spawnSync(process.execPath,['--expose-gc',profile,'--red'],{encoding:'utf8',maxBuffer:32768,timeout:15000});
  assert.equal(x.status,1);
  const a=JSON.parse(x.stdout);
  assert.deepEqual(a.rows.map(x=>x.phase),PHASES);
  assert.equal(a.status.historyCopies,6);
  assert.equal(a.status.retainedSessionObjects,6);
  assert.equal(a.status.activeAlarmClosures,6);
});
test('GREEN: bounded cursor/summary, no retained history or alarm closures; exit 0',()=>{
  const x=spawnSync(process.execPath,['--expose-gc',profile,'--bounded'],{encoding:'utf8',maxBuffer:32768,timeout:15000});
  assert.equal(x.status,0);
  const a=JSON.parse(x.stdout);
  assert.equal(a.status.scanned,6*64);
  assert.equal(a.status.historyCopies,0);
  assert.equal(a.status.retainedSessionObjects,0);
  assert.equal(a.status.activeAlarmClosures,0);
  assert(a.rows.every(s=>Number.isFinite(s.retainedHeapDeltaBytes)));
  assert(a.mcp.sentBytes<=4096);
  assert.equal(a.child.memoryDomain,'separate local child process, NOT Cloudflare Container');
});
test('projection does not materialize or return synthetic event contents',()=>{
  const x=boundedStatus({id:'synthetic',events:Array.from({length:1000},(_,i)=>({ordinal:i,response:'secret-sentinel'}))});
  assert.equal(x.scanned,64);
  assert.equal(x.last,999);
  assert(!JSON.stringify(x).includes('secret-sentinel'));
  assert.throws(()=>boundedStatus({events:[]},10000),/UNBOUNDED/);
});
test('MCP wire size is separated from heap allocation and exposes truncation',()=>{
  const x=boundMcpResponse({content:'z'.repeat(200000)},512);
  assert.equal(x.truncated,true);
  assert(x.fullBytes>512);
  assert(x.sentBytes<=512);
});
test('local child process memory independent, not a Cloudflare Container measurement',()=>{
  const x=measureChildProcess();
  assert.equal(x.bytesAllocated,4194304);
  assert(x.rssBytes>0);
  assert.equal(x.kind,'synthetic_child_process');
});

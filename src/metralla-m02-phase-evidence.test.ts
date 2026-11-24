import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPhaseEvidence,logicalPhaseCounts,restorePhaseCheckpoint,PHASE_EVIDENCE_LIMITS,type PhaseRow} from './metralla-m02-phase-evidence.ts';
const id='0000000000000001';
const empty=(requestId=id)=>JSON.stringify({requestId,rows:[]});
const fixture=(requestId=id):PhaseRow[]=>['queued','active','effect','active','finalizing','finished'].map((phase,i)=>({requestId,sessionId:i?'ses_fixture':null,operationId:'op_'+i,seq:i+1,at:i*10,phase:phase as PhaseRow['phase']}));
const source=(rows:PhaseRow[])=>async({after,maxBytes}:{after:number;maxBytes:number})=>{const row=rows[after];if(!row)return null;const wire=JSON.stringify(row);assert(wire.length<=maxBytes);return wire;};
test('restart preserves scoped cursor and exact phase intervals',async()=>{
  const rows=fixture();const first=await readPhaseEvidence(source(rows.slice(0,3)),empty(),id);
  assert.equal(first.complete,false);assert.equal(first.rowsRead,3);
  const second=await readPhaseEvidence(source(rows),JSON.stringify(first.checkpoint),id);
  assert.equal(second.rowsRead,3);assert.equal(second.complete,true);assert.deepEqual(second.checkpoint.rows,rows);
  assert.equal(logicalPhaseCounts([second.checkpoint],25).effect,1);
  assert.equal(logicalPhaseCounts([first.checkpoint],25).effect,0);
});
test('oversized wire rejected before parse; incorrect identity, gaps and failed source reject',async()=>{
  await assert.rejects(readPhaseEvidence(async()=> 'x'.repeat(1_000_000),empty(),id),/PHASE_EVIDENCE_INVALID/);
  await assert.rejects(readPhaseEvidence(source(fixture('0000000000000002')),empty(),id),/PHASE_EVIDENCE_INVALID/);
  await assert.rejects(readPhaseEvidence(source([{...fixture()[0],seq:2}]),empty(),id),/PHASE_EVIDENCE_INVALID/);
  await assert.rejects(readPhaseEvidence(async()=>{throw Error('source failed');},empty(),id),/source failed/);
  const wrong=fixture();wrong[2].sessionId='ses_other';await assert.rejects(readPhaseEvidence(source(wrong),empty(),id),/PHASE_EVIDENCE_INVALID/);
  assert.throws(()=>restorePhaseCheckpoint('x'.repeat(100_000),id),/PHASE_EVIDENCE_INVALID/);
});
test('retention stops before another row, not silently evicting or certifying',async()=>{
  const rows:PhaseRow[]=Array.from({length:100},(_,i)=>({requestId:id,sessionId:i?'s':null,operationId:'o',seq:i+1,at:i,phase:i===0?'queued':i%2?'active':'effect'}));
  let calls=0;const read=source(rows);const result=await readPhaseEvidence(async scope=>{calls++;return read(scope);},empty(),id);
  assert.equal(calls,PHASE_EVIDENCE_LIMITS.rows);assert.equal(result.complete,false);
  const replay=await readPhaseEvidence(async()=>{throw Error('must not fetch');},JSON.stringify(result.checkpoint),id);
  assert.equal(replay.rowsRead,0);assert.equal(replay.complete,false);
});
test('synthetic comparable overlap 1/2/4/10, distinct queue/effect/finalization',async()=>{
  for(const n of [1,2,4,10]){
    const start=performance.now(), before=process.memoryUsage();const cps=[];let bytes=0;
    for(let i=1;i<=n;i++){const rid=i.toString(16).padStart(16,'0');const r=await readPhaseEvidence(source(fixture(rid)),empty(rid),rid);assert(r.complete);cps.push(r.checkpoint);bytes+=r.bytesRead;}
    assert.equal(logicalPhaseCounts(cps,5).queued,n);assert.equal(logicalPhaseCounts(cps,15).active,n);assert.equal(logicalPhaseCounts(cps,25).effect,n);assert.equal(logicalPhaseCounts(cps,45).finalizing,n);assert.equal(logicalPhaseCounts(cps,50).finished,n);
    assert.throws(()=>logicalPhaseCounts([...cps,cps[0]],15),/PHASE_EVIDENCE_INVALID/);
    const after=process.memoryUsage();console.log(JSON.stringify({fixture:true,tasks:n,rows:n*6,wireBytes:bytes,logicalActive:n,nativeOperationsMeasured:false,elapsedMs:performance.now()-start,heapDeltaBytes:after.heapUsed-before.heapUsed,rssDeltaBytes:after.rss-before.rss}));
  }
});

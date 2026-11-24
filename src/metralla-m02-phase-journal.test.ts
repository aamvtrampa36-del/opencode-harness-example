import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendPhaseTransition,phaseCheckpointSource,logicalEvidenceSnapshot} from './metralla-m02-phase-journal.ts';
import {readPhaseEvidence, type PhaseRow} from './metralla-m02-phase-evidence.ts';
const requestId='0000000000000001';
const empty=JSON.stringify({requestId,rows:[]});
const row=(seq:number,phase:PhaseRow['phase']):PhaseRow=>({requestId,sessionId:seq===1?null:'session1',operationId:'op'+seq,seq,at:seq*10,phase});
test('bounded producer only projects explicit scalar metadata, including giant unrelated payload',async()=>{
  const extra={...row(1,'queued'),get payload(){throw Error('MUST NOT MATERIALIZE');}};
  const first=appendPhaseTransition(empty,requestId,extra);assert(first.accepted);
  assert(!first.wire.includes('payload'));
  assert.throws(()=>appendPhaseTransition(first.wire,requestId,{...row(2,'active'),operationId:'x'.repeat(1_000_000)}),/PHASE_EVIDENCE_INVALID/);
  const second=appendPhaseTransition(first.wire,requestId,row(2,'active'));
  const read=phaseCheckpointSource(second.wire,requestId);
  await assert.rejects(read({requestId:'0000000000000002',after:0,maxBytes:512}),/PHASE_EVIDENCE_INVALID/);
  await assert.rejects(read({requestId,after:0,maxBytes:1}),/PHASE_EVIDENCE_INVALID/);
  const result=await readPhaseEvidence(read,empty,requestId);assert.equal(result.rowsRead,2);assert.equal(result.complete,false);
  assert.equal(logicalEvidenceSnapshot([result.checkpoint],15).phases.queued,1);
  assert.equal(logicalEvidenceSnapshot([result.checkpoint],25).unknown,1);
});
test('append cap prevents further writes and preserves earlier wire',()=>{
  let wire=empty;
  for(let seq=1;seq<=32;seq++) {const result=appendPhaseTransition(wire,requestId,row(seq,seq===1?'queued':seq%2?'effect':'active'));assert(result.accepted);wire=result.wire;}
  const result=appendPhaseTransition(wire,requestId,row(33,'effect'));
  assert.deepEqual(result,{wire,accepted:false});
});

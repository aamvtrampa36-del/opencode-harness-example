import {PHASE_EVIDENCE_LIMITS as L, EVIDENCE_PHASES, restorePhaseCheckpoint, logicalPhaseCounts, type PhaseRow, type PhaseCheckpoint, type PhaseRead} from './metralla-m02-phase-evidence.ts';

/** Only explicit scalar metadata is projected. Never inspect payload, transcript or error. */
export function projectPhaseMetadata(raw:PhaseRow):PhaseRow {
  const {requestId,sessionId,operationId,seq,at,phase}=raw;
  const validId=(v:unknown)=>typeof v==='string' && v.length>0 && v.length<=96 && /^[A-Za-z0-9_-]+$/.test(v);
  if(typeof requestId!=='string' || requestId.length!==16 || !/^[a-f0-9]{16}$/.test(requestId) ||
    !(sessionId===null || validId(sessionId)) || !validId(operationId) ||
    !Number.isSafeInteger(seq) || seq<1 || !Number.isSafeInteger(at) || at<0 || !EVIDENCE_PHASES.includes(phase))
    throw Error('PHASE_EVIDENCE_INVALID');
  return {requestId,sessionId,operationId,seq,at,phase};
}
/** Pure append for a caller holding the authoritative task transaction/fence.
 * No writes, storage mutation, eviction or inference. Persist only accepted wire atomically.
 */
export function appendPhaseTransition(wire:string, expected:string, metadata:PhaseRow):{wire:string;accepted:boolean} {
  const cp=restorePhaseCheckpoint(wire,expected);
  if(cp.rows.length>=L.rows) return {wire,accepted:false};
  const row=projectPhaseMetadata(metadata);
  if(JSON.stringify(row).length>L.rowBytes) throw Error('PHASE_EVIDENCE_INVALID');
  const candidate=JSON.stringify({requestId:expected,rows:[...cp.rows,row]});
  restorePhaseCheckpoint(candidate,expected);
  return {wire:candidate,accepted:true};
}
/** Source over an already bounded authoritative metadata snapshot, not SDK log/history.
 * At most one projected row serialized; never serializes a large raw event.
 */
export function phaseCheckpointSource(wire:string, expected:string):PhaseRead {
  const cp=restorePhaseCheckpoint(wire,expected);
  return async ({requestId,after,maxBytes})=>{
    if(requestId!==expected || !Number.isSafeInteger(after) || after<0 || after>cp.rows.length ||
       !Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>L.rowBytes) throw Error('PHASE_EVIDENCE_INVALID');
    const row=cp.rows[after];
    if(!row) return null;
    const encoded=JSON.stringify(row);
    if(encoded.length>maxBytes) throw Error('PHASE_EVIDENCE_INVALID');
    return encoded;
  };
}
/** Explicit unknown prevents treating a partial observation as zero actual activity. */
export function logicalEvidenceSnapshot(cps:readonly PhaseCheckpoint[], at:number) {
  const phases=logicalPhaseCounts(cps,at);
  return {phases,unknown:cps.length-Object.values(phases).reduce((a,b)=>a+b,0),nativeOperationsMeasured:false as const};
}

/** Scoped, bounded phase evidence v1. Not a public log or native activity oracle. */
export const PHASE_EVIDENCE_LIMITS = Object.freeze({rows:32, rowBytes:512, pageBytes:8192, tasks:10});
export const EVIDENCE_PHASES = ['queued','active','effect','finalizing','finished'] as const;
export type EvidencePhase = typeof EVIDENCE_PHASES[number];
export type PhaseRow = {requestId:string; sessionId:string|null; operationId:string; seq:number; at:number; phase:EvidencePhase};
export type PhaseCheckpoint = {requestId:string; rows:PhaseRow[]};
export type PhaseRead = (scope:{requestId:string; after:number; maxBytes:number}) => Promise<string|null>;
const id = (v:unknown): v is string => typeof v==='string' && v.length<=96 && /^[A-Za-z0-9_-]+$/.test(v);
const request = (v:unknown): v is string => typeof v==='string' && v.length===16 && /^[a-f0-9]{16}$/.test(v);
const integer = (v:unknown): v is number => typeof v==='number' && Number.isSafeInteger(v) && v>=0;
const next:Record<EvidencePhase,readonly EvidencePhase[]> = {queued:['active','finalizing'],active:['effect','finalizing'],effect:['active','finalizing'],finalizing:['finished'],finished:[]};
function fail():never {throw new Error('PHASE_EVIDENCE_INVALID');}
function validate(row:unknown, expected:string, prev?:PhaseRow):PhaseRow {
  if(!row || typeof row!=='object' || Array.isArray(row)) return fail();
  const x=row as Partial<PhaseRow>;
  if(Object.keys(x).length!==6 || x.requestId!==expected || !request(x.requestId) || !id(x.operationId) ||
    !(x.sessionId===null || id(x.sessionId)) || !integer(x.seq) || !integer(x.at) ||
    !EVIDENCE_PHASES.includes(x.phase as EvidencePhase)) return fail();
  const r=x as PhaseRow;
  if(!prev ? r.seq!==1 || r.phase!=='queued' :
    r.seq!==prev.seq+1 || r.at<prev.at || !next[prev.phase].includes(r.phase) ||
    (prev.sessionId!==null && r.sessionId!==prev.sessionId)) return fail();
  return {requestId:r.requestId,sessionId:r.sessionId,operationId:r.operationId,seq:r.seq,at:r.at,phase:r.phase};
}
/** Wire format is ASCII projected metadata only. Check length before JSON.parse. */
function decode(raw:string, maxBytes:number, expected:string, prev?:PhaseRow):PhaseRow {
  if(typeof raw!=='string' || raw.length>maxBytes || !/^[\x20-\x7e]+$/.test(raw)) return fail();
  return validate(JSON.parse(raw),expected,prev);
}
/** Restore only bounded checkpoint bytes; never load full transcript. */
export function restorePhaseCheckpoint(wire:string, expected:string):PhaseCheckpoint {
  if(!request(expected) || typeof wire!=='string' || wire.length>PHASE_EVIDENCE_LIMITS.rows*PHASE_EVIDENCE_LIMITS.rowBytes+128 || !/^[\x20-\x7e]+$/.test(wire)) return fail();
  const x=JSON.parse(wire) as Partial<PhaseCheckpoint>;
  if(!x || Object.keys(x).length!==2 || x.requestId!==expected || !Array.isArray(x.rows) || x.rows.length>PHASE_EVIDENCE_LIMITS.rows) return fail();
  const rows:PhaseRow[]=[];
  for(const row of x.rows) rows.push(validate(row,expected,rows.at(-1)));
  return {requestId:expected,rows};
}
/** Producer MUST scope by request, select metadata only and cap row bytes BEFORE returning.
 * No lookahead at row/page/retention exhaustion. Null means source confirmed end, not failed read.
 * Caller persists checkpoint atomically; any read/validation failure leaves previous checkpoint intact.
 */
export async function readPhaseEvidence(read:PhaseRead, checkpointWire:string, expected:string):Promise<{checkpoint:PhaseCheckpoint; complete:boolean; bytesRead:number; rowsRead:number}> {
  const checkpoint=restorePhaseCheckpoint(checkpointWire,expected);
  let bytesRead=0,rowsRead=0;
  while(checkpoint.rows.length<PHASE_EVIDENCE_LIMITS.rows && PHASE_EVIDENCE_LIMITS.pageBytes-bytesRead>=PHASE_EVIDENCE_LIMITS.rowBytes){
    const prev=checkpoint.rows.at(-1);
    const raw=await read({requestId:expected,after:prev?.seq??0,maxBytes:PHASE_EVIDENCE_LIMITS.rowBytes});
    if(raw===null) return {checkpoint,complete:prev?.phase==='finished',bytesRead,rowsRead};
    const row=decode(raw,PHASE_EVIDENCE_LIMITS.rowBytes,expected,prev);
    bytesRead+=raw.length;rowsRead++;checkpoint.rows.push(row);
  }
  return {checkpoint,complete:false,bytesRead,rowsRead};
}
/** Counts logical phase intersections, never native execution. Unknown outside observed intervals. */
export function logicalPhaseCounts(checkpoints:readonly PhaseCheckpoint[], at:number):Record<EvidencePhase,number> {
  if(!integer(at) || checkpoints.length>PHASE_EVIDENCE_LIMITS.tasks) return fail();
  const counts={queued:0,active:0,effect:0,finalizing:0,finished:0};
  const seen=new Set<string>();
  for(const cp of checkpoints){
    if(!request(cp.requestId) || seen.has(cp.requestId) || cp.rows.length>PHASE_EVIDENCE_LIMITS.rows) return fail();
    seen.add(cp.requestId);
    let prev:PhaseRow|undefined;
    for(const row of cp.rows){const r=validate(row,cp.requestId,prev);if(prev && prev.at<=at && at<r.at) counts[prev.phase]++;prev=r;}
    if(prev?.phase==='finished' && prev.at<=at) counts.finished++;
  }
  return counts;
}

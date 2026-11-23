/** F0-C10/R2-T01 offline synthetic stage profiler; no Cloudflare/remote/network. */
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

export const PHASES = Object.freeze(['admit', 'create/fork', 'setModel', 'submit', 'status', 'alarm', 'recover']);
const MAX_EVENTS = 64;
const MAX_WIRE_BYTES = 4096;
const FIXTURE_COUNT = 6;
const PER_SESSION = 400;
const OUTPUT_BYTES_PER_EVENT = 1024;

function memory() {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers };
}
function phase(run, phaseName, action) {
  if (!PHASES.includes(phaseName)) throw new Error('INVALID_PHASE');
  global.gc?.();
  const before = memory(), start = performance.now();
  const value = action();
  const immediate = memory();
  global.gc?.();
  const retained = memory();
  run.rows.push({ phase: phaseName, durationMs: Math.round((performance.now()-start)*1000)/1000,
    heapDeltaBytes: immediate.heapUsed-before.heapUsed,
    retainedHeapDeltaBytes: retained.heapUsed-before.heapUsed,
    rssDeltaBytes: retained.rss-before.rss,
    externalDeltaBytes: retained.external-before.external,
    arrayBuffersDeltaBytes: retained.arrayBuffers-before.arrayBuffers });
  return value;
}
function event(session, index) {
  return { ordinal: index, result: `\${session}:\${index}:\${'a'.repeat(OUTPUT_BYTES_PER_EVENT)}` };
}
export function boundedStatus(session, maxEvents=MAX_EVENTS) {
  if (!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>128) throw new Error('UNBOUNDED_EVENT_BUDGET');
  const tail=session.events.slice(-maxEvents);
  return { session:session.id, count:session.events.length, last:tail.at(-1)?.ordinal ?? null,
    scanned:tail.length, events:tail.map(({ordinal})=>ordinal) };
}
export function boundMcpResponse(value, maxBytes=MAX_WIRE_BYTES) {
  if (!Number.isInteger(maxBytes)||maxBytes<256||maxBytes>65536) throw new Error('INVALID_MCP_BUDGET');
  // This receives an already-allocated object; full serialization is OFFLINE ONLY.
  const full=JSON.stringify(value);
  const fullBytes=Buffer.byteLength(full,'utf8');
  if(fullBytes<=maxBytes) return { text:full, truncated:false, fullBytes, sentBytes:fullBytes };
  const safe=JSON.stringify({truncated:true, reason:'SYNTHETIC_MCP_BUDGET'});
  assert(Buffer.byteLength(safe,'utf8')<=maxBytes);
  return {text:safe,truncated:true,fullBytes,sentBytes:Buffer.byteLength(safe,'utf8')};
}
export function simulate(mode='bounded') {
  if(!['red','bounded'].includes(mode)) throw new Error('INVALID_MODE');
  const run={runtime:'node-offline',version:process.version,mode,fixtures:{sessions:FIXTURE_COUNT,eventsPerSession:PER_SESSION,charsPerEvent:OUTPUT_BYTES_PER_EVENT},rows:[]};
  const state={admissions:[],sessions:[],historyCopies:[],alarmReferences:[]};
  phase(run,'admit',()=>{state.admissions=Array.from({length:FIXTURE_COUNT},(_,i)=>({id:`fixture-\${i}`,state:'preparing'}));});
  phase(run,'create/fork',()=>{state.sessions=state.admissions.map(({id},i)=>({id,events:Array.from({length:PER_SESSION},(_,n)=>event(i,n)),model:null}));});
  phase(run,'setModel',()=>{for(const s of state.sessions)s.model={provider:'fixture',model:'no-inference'};});
  phase(run,'submit',()=>{for(const s of state.sessions)s.events.push(event(s.id,PER_SESSION));});
  phase(run,'status',()=>{
    for(const s of state.sessions){
      if(mode==='red')state.historyCopies.push(JSON.stringify(s.events));
      else state.historyCopies.push(boundedStatus(s));
    }
  });
  phase(run,'alarm',()=>{
    if(mode==='red')state.alarmReferences=state.sessions.map(s=>()=>s.events);
    else state.alarmReferences=state.sessions.map(s=>({session:s.id, pending:0}));
  });
  phase(run,'recover',()=>{
    if(mode==='bounded'){
      state.alarmReferences=[];
      state.historyCopies=[];
      state.sessions=[];
    }
  });
  run.status={scanned:mode==='red'?FIXTURE_COUNT*(PER_SESSION+1):FIXTURE_COUNT*MAX_EVENTS,
    historyCopies:mode==='red'?FIXTURE_COUNT:0,activeAlarmClosures:mode==='red'?FIXTURE_COUNT:0,
    retainedSessionObjects:state.sessions.length};
  const sample={session:'synthetic',events:[{ordinal:1,output:'z'.repeat(16384)}]};
  run.mcp=boundMcpResponse(sample);
  run.mcp={fullBytes:run.mcp.fullBytes,sentBytes:run.mcp.sentBytes,truncated:run.mcp.truncated,
    label:'serialized response; NOT isolate or Container memory'};
  return run;
}
export function measureChildProcess() {
  const p=spawnSync(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--synthetic-child'],
    {encoding:'utf8',maxBuffer:8192,timeout:8000});
  if(p.status!==0)throw new Error(`CHILD_FAILED_\${p.status}:\${(p.stderr||'').slice(0,100)}`);
  const value=JSON.parse(p.stdout);
  if(value.kind!=='synthetic_child_process')throw new Error('CHILD_INVALID');
  return {kind:value.kind,bytesAllocated:value.bytesAllocated,rssBytes:value.rssBytes,
    memoryDomain:'separate local child process, NOT Cloudflare Container'};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  if(process.argv.includes('--synthetic-child')){
    const a=Buffer.alloc(4*1024*1024,23);
    console.log(JSON.stringify({kind:'synthetic_child_process',bytesAllocated:a.length,rssBytes:process.memoryUsage().rss}));
  }else{
    const mode=process.argv.includes('--red')?'red':'bounded';
    const result=simulate(mode);
    result.child=measureChildProcess();
    console.log(JSON.stringify(result));
    if(mode==='red') process.exitCode=1;
  }
}

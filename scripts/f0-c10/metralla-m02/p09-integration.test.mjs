import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRemoteProgress,validateProgress,validateStatus,remoteScope,REMOTE_SCHEMA} from '../../../src/staging-control-mcp/p08-remote.ts';
import {appendPhaseTransition,logicalEvidenceSnapshot} from '../../../src/metralla-m02-phase-journal.ts';
import {restorePhaseCheckpoint} from '../../../src/metralla-m02-phase-evidence.ts';
const key=await crypto.subtle.importKey('raw',new Uint8Array(32).fill(9),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
const workspace='opencode-supervisor-v1';
const id=i=>i.toString(16).padStart(16,'0');
const fixtures=1024, readers=2;
const fixture=i=>{
 const scope=remoteScope(id(i),null),session='ses_'+i;
 let wire=JSON.stringify({requestId:scope.id,rows:[]});
 for(const [j,phase] of ['queued','active','effect','active','finalizing','finished'].entries()){
  const r=appendPhaseTransition(wire,scope.id,{requestId:scope.id,sessionId:session,operationId:'op_'+i,seq:j+1,at:j*10,phase});
  assert.equal(r.accepted,true);wire=r.wire;
 }
 let calls=0,hydrated=0;
 const source={async next(s,after,max,signal){
  calls++;assert.equal(s.workspace,workspace);assert.equal(s.session,session);assert(!signal.aborted);
  const seq=Number(after||0)+1;if(seq>fixtures)return {kind:'end'};
  const original={seq,type:seq%17===0?'session.reasoning.delta':'session.tool.called',get payload(){hydrated++;return 'x'.repeat(seq%16===0?1048576:2048);}};
  const row={seq:original.seq,type:original.type};
  return Buffer.byteLength(JSON.stringify(row))<=max?{kind:'row',row}:{kind:'oversize'};
 }};
 const authorize=async s=>s.id===scope.id&&s.workspace===null?{principal:'fixture-owner',workspace,session,key,source}:null;
 return {scope,authorize,checkpoint:restorePhaseCheckpoint(wire,scope.id),stats:()=>({calls,hydrated})};
};
for(const n of [1,2,4,10])test('combined M02 benchmark '+n+' sessions',async t=>{
 const fs=Array.from({length:n},(_,i)=>fixture(i+1));const before=process.memoryUsage();const start=performance.now();
 const traces=await Promise.all(fs.flatMap(f=>Array.from({length:readers},async()=>{
  let cursor,position=0,bytes=0,pages=0;
  do{const p=await projectRemoteProgress(f.scope,cursor,f.authorize);
   assert.equal(p.from,position);assert.equal(p.passed,false);assert.equal(p.verified,false);
   assert.ok(p.events.length<=64);assert.ok(Buffer.byteLength(JSON.stringify(p))<=8192);
   assert.ok(p.events.every(e=>!e.type.includes('reasoning')));
   position=p.nextAfter;bytes+=Buffer.byteLength(JSON.stringify(p));pages++;
   cursor=p.cursor;if(p.complete)break;assert.ok(cursor);assert.ok(pages<=32);
  }while(true);
  assert.equal(position,fixtures);return {bytes,pages};
 })));
 const snapshot=logicalEvidenceSnapshot(fs.map(f=>f.checkpoint),15);
 assert.equal(snapshot.phases.active,n);assert.equal(snapshot.nativeOperationsMeasured,false);
 assert.ok(fs.every(f=>f.stats().hydrated===0&&f.stats().calls<=readers*(fixtures+2)));
 t.diagnostic(JSON.stringify({sessions:n,readers:n*readers,history:fixtures,events:n*readers*fixtures,pages:traces.reduce((a,b)=>a+b.pages,0),wireBytes:traces.reduce((a,b)=>a+b.bytes,0),payloadHydrations:0,sourceCalls:fs.reduce((a,f)=>a+f.stats().calls,0),elapsedMs:Math.round(performance.now()-start),heapDelta:process.memoryUsage().heapUsed-before.heapUsed,rssDelta:process.memoryUsage().rss-before.rss,nativeOperationsMeasured:false}));
});
test('upstream cursor replay and skip fail closed; foreign scope has no read',async()=>{
 const f=fixture(1),g=fixture(2);
 const a=await projectRemoteProgress(f.scope,undefined,f.authorize);
 const b=await projectRemoteProgress(f.scope,a.cursor,f.authorize);
 assert.throws(()=>validateProgress({...b,from:b.from+1,events:b.events.map(e=>({...e,seq:e.seq+1})),nextAfter:b.nextAfter+1},f.scope,a.cursor),/REMOTE_CURSOR_POSITION_MISMATCH/);
 assert.throws(()=>validateProgress({...b,cursor:a.cursor},f.scope,a.cursor),/REMOTE_CURSOR/);
 const other=await projectRemoteProgress(g.scope,undefined,g.authorize);
 assert.throws(()=>validateProgress({...b,cursor:other.cursor},f.scope,a.cursor),/REMOTE_CURSOR/);
 const before=g.stats().calls;
 await assert.rejects(projectRemoteProgress(g.scope,a.cursor,g.authorize),/CURSOR_INVALID/);
 await assert.rejects(projectRemoteProgress(g.scope,undefined,async()=>null),/SCOPE_FORBIDDEN/);
 assert.equal(g.stats().calls,before);
 assert.equal(validateStatus({schema:REMOTE_SCHEMA,...f.scope,revision:1,status:'finished',verified:true},f.scope,null).verified,false);
});

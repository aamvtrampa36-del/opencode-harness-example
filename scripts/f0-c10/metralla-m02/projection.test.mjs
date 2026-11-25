import test from 'node:test';
import assert from 'node:assert/strict';
import {projectedDirectory,projectedProgress,readCursor,signCursor} from '../../../src/metralla-m02-projection.ts';
const key=await crypto.subtle.importKey('raw',new Uint8Array(32).fill(37),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
const scope={principal:'fixture-owner',workspace:'fixture-workspace',view:'directory',session:'directory'};
const progress={...scope,view:'progress',session:'ses_fixture'};
const limits={rows:5,bytes:2048,ms:1000};
const task=(i)=>({key:'supervisor:task:'+i.toString(16).padStart(16,'0'),session:'ses_'+i,status:'running',createdAt:i});
const fixture=(size,view='directory',options={})=>{
 let calls=0,hydrated=0,peak=0,inflight=0;
 return {stats:()=>({calls,hydrated,peak}),async next(s,after,budget,signal){
  calls++;inflight++;peak=Math.max(peak,inflight);
  try{
   if(s.principal!=='fixture-owner'||s.workspace!=='fixture-workspace'||s.view!==view)throw Error('DENIED');
   if(signal.aborted)throw Error('ABORT');
   await Promise.resolve();
   if(options.delay)await new Promise((resolve,reject)=>{const t=setTimeout(resolve,options.delay);signal.addEventListener('abort',()=>{clearTimeout(t);reject(Error('ABORT'));},{once:true});});
   const i=(view==='directory'?after?parseInt(after.slice(-16),16):0:Number(after||0))+1;
   if(i>size)return {kind:'end'};
   if(options.oversize===i)return {kind:'oversize'};
   const row=view==='directory'?task(i):{seq:i,type:i%2?'called':'success'};
   // Fixture represents a huge original record. Payload is never touched by next().
   const original={...row,get transcript(){hydrated++;throw Error('PAYLOAD_HYDRATED');}};
   const projected=view==='directory'?{key:original.key,session:original.session,status:original.status,createdAt:original.createdAt}:{seq:original.seq,type:original.type};
   if(Buffer.byteLength(JSON.stringify(projected))>budget)return {kind:'oversize'};
   return {kind:'row',row:projected};
  }finally{inflight--;}
 }};
};
test('exclusive cursor pagination and reconnect, no transcript hydration',async()=>{
 const s=fixture(11);const a=await projectedDirectory(s,scope,key,undefined,limits);assert.equal(a.stop,'rows');assert.equal(a.rows.length,5);assert.equal(s.stats().calls,5);
 const b=await projectedDirectory(s,scope,key,a.cursor,limits);const c=await projectedDirectory(s,scope,key,b.cursor,limits);
 assert.deepEqual([...a.rows,...b.rows,...c.rows].map(r=>r.createdAt),Array.from({length:11},(_,i)=>i+1));assert.equal(c.complete,true);assert.equal(c.cursor,null);assert.equal(s.stats().hydrated,0);
});
test('foreign principal, workspace, session, view, tampering and malformed cursor denied before scan',async()=>{
 const s=fixture(2);const token=await signCursor(scope,task(1).key,key);
 for(const other of [{...scope,principal:'other'},{...scope,workspace:'other'},{...scope,session:'other'}])await assert.rejects(projectedDirectory(s,other,key,token,limits),/CURSOR_INVALID/);
 await assert.rejects(projectedProgress(s,progress,key,token,limits),/CURSOR_INVALID/);
 for(const bad of ['garbage','x'.repeat(2049),token.slice(0,-1)+(token.endsWith('0')?'1':'0')])await assert.rejects(projectedDirectory(s,scope,key,bad,limits),/CURSOR_INVALID/);
 assert.equal(s.stats().calls,0);
});
test('giant row denied before payload read; no cursor advance',async()=>{
 const s=fixture(10,'directory',{oversize:2});const a=await projectedDirectory(s,scope,key,undefined,limits);
 assert.equal(a.stop,'oversize');assert.equal(a.rows.length,1);assert.equal(await readCursor(scope,a.cursor,key),task(1).key);assert.equal(s.stats().hydrated,0);assert.equal(a.complete,false);
});
test('byte cap and row cap are passed down; invalid limits fail before storage',async()=>{
 const s=fixture(1000);const a=await projectedDirectory(s,scope,key,undefined,{rows:20,bytes:160,ms:1000});
 assert.equal(a.rows.length,1);assert.ok(a.bytes<=160);assert.equal(a.bytes,Buffer.byteLength(JSON.stringify(a.rows)));assert.equal(a.complete,false);
 const before=s.stats().calls;await assert.rejects(projectedDirectory(s,scope,key,undefined,{...limits,rows:201}),/LIMIT_INVALID/);assert.equal(s.stats().calls,before);
});
test('long event history starts at checkpoint; never loads full history',async()=>{
 const s=fixture(1_000_000,'progress');const token=await signCursor(progress,'999990',key);const a=await projectedProgress(s,progress,key,token,limits);assert.deepEqual(a.rows.map(r=>r.seq),[999991,999992,999993,999994,999995]);assert.equal(s.stats().calls,5);assert.equal(s.stats().hydrated,0);
});
test('deadline abort and resume without false completion',async()=>{
 const s=fixture(10,'directory',{delay:100});const a=await projectedDirectory(s,scope,key,undefined,{...limits,ms:10});assert.equal(a.stop,'time');assert.equal(a.complete,false);assert.equal(a.rows.length,0);assert.equal(await readCursor(scope,a.cursor,key),'');assert.equal(s.stats().calls,1);
});
test('storage failure and unordered pages fail closed',async()=>{
 await assert.rejects(projectedDirectory({next:async()=>{throw Error('storage unavailable');}},scope,key,undefined,limits),/storage unavailable/);
 const token=await signCursor(scope,task(2).key,key);await assert.rejects(projectedDirectory({next:async()=>({kind:'row',row:task(1)})},scope,key,token,limits),/PROJECTION_ORDER_INVALID/);
});
test('concurrent readers preserve independent scope and bounded per-page work',async()=>{
 const s=fixture(10000);const pages=await Promise.all(Array.from({length:10},()=>projectedDirectory(s,scope,key,undefined,limits)));assert.equal(s.stats().calls,50);assert.equal(s.stats().hydrated,0);assert.ok(s.stats().peak<=10);assert.ok(pages.every(p=>p.rows.length===5&&p.bytes<=limits.bytes));
});
for(const readers of [1,2,4,10])test(`synthetic benchmark ${readers} readers`,async(t)=>{
 const s=fixture(1_000_000,'progress',{delay:1});const heapBefore=process.memoryUsage();const start=performance.now();const initial=await signCursor(progress,'900000',key);const pages=await Promise.all(Array.from({length:readers},()=>projectedProgress(s,progress,key,initial,{rows:64,bytes:8192,ms:1500})));
 const next=await Promise.all(pages.map(p=>projectedProgress(s,progress,key,p.cursor,{rows:64,bytes:8192,ms:1500})));const ms=performance.now()-start;
 assert.ok(pages.every(p=>p.rows.length===64&&p.bytes<=8192));assert.ok(next.every(p=>p.rows[0].seq===900065));assert.equal(s.stats().calls,readers*128);assert.equal(s.stats().hydrated,0);
 t.diagnostic(JSON.stringify({readers,logicalHistory:1000000,rows:readers*128,projectedBytes:[...pages,...next].reduce((n,p)=>n+p.bytes,0),ms:Number(ms.toFixed(2)),heapDeltaBytes:process.memoryUsage().heapUsed-heapBefore.heapUsed,rssDeltaBytes:process.memoryUsage().rss-heapBefore.rss,...s.stats()}));
});

test('event sequence gap does not acknowledge missing records',async()=>{
 await assert.rejects(projectedProgress({next:async()=>({kind:'row',row:{seq:2,type:'called'}})},progress,key,undefined,limits),/PROJECTION_SEQUENCE_GAP/);
});
test('SQLite source projects fixed columns, filters owners, gates bytes before JS, and requires coverage',async()=>{
 const DatabaseSync=process.versions.bun?(await import('bun:sqlite')).Database:(await import('node:sqlite')).DatabaseSync;const {sqliteProjectionSource}=await import('../../../src/metralla-m02-projection.ts');
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE metralla_directory_projection(principal TEXT,workspace TEXT,task_key TEXT,session_id TEXT,status TEXT,created_at INTEGER,PRIMARY KEY(principal,workspace,task_key)); CREATE TABLE metralla_event_projection(principal TEXT,workspace TEXT,session_id TEXT,seq INTEGER,event_type TEXT,PRIMARY KEY(principal,workspace,session_id,seq));`);
  const ins=db.prepare('INSERT INTO metralla_directory_projection VALUES(?,?,?,?,?,?)');
  for(let i=1;i<=12;i++){const r=task(i);ins.run(scope.principal,scope.workspace,r.key,r.session,r.status,r.createdAt);}
  ins.run('other',scope.workspace,task(1).key,'ses_other','running',1);
  ins.run(scope.principal,scope.workspace,task(13).key,'ses_'+ 'x'.repeat(1000000),'running',13);
  const query=(sql,args)=>db.prepare(sql).all(...args);const source=sqliteProjectionSource('directory',query,s=>s.principal===scope.principal&&s.workspace===scope.workspace);
  const a=await projectedDirectory(source,scope,key,undefined,{rows:20,bytes:8192,ms:1000});assert.equal(a.rows.length,12);assert.equal(a.stop,'oversize');assert.equal(await readCursor(scope,a.cursor,key),task(12).key);assert.ok(a.rows.every(r=>r.session!=='ses_other'));
  await assert.rejects(projectedDirectory(source,{...scope,principal:'other'},key,undefined,limits),/PROJECTION_COVERAGE_UNKNOWN/);
  const ev=db.prepare('INSERT INTO metralla_event_projection VALUES(?,?,?,?,?)');ev.run(scope.principal,scope.workspace,progress.session,1,'called');ev.run(scope.principal,scope.workspace,'ses_other',2,'failed');ev.run(scope.principal,scope.workspace,progress.session,2,'success');
  const events=await projectedProgress(sqliteProjectionSource('progress',query,()=>true),progress,key,undefined,limits);assert.deepEqual(events.rows,[{seq:1,type:'called'},{seq:2,type:'success'}]);assert.equal(events.complete,true);
 }finally{db.close();}
});
test('metrics fold preserves durable checkpoint, counts native types and rejects replay against advanced cursor',async()=>{
 const {foldProjectedCounts}=await import('../../../src/metralla-m02-projection.ts');
 const prior={cursor:0,toolCalls:0,completedTools:0,failedTools:0};
 const p={from:'',rows:[{seq:1,type:'session.tool.called'},{seq:2,type:'session.tool.success'},{seq:3,type:'session.text.ended'}],complete:false};
 const a=foldProjectedCounts(prior,p);assert.deepEqual(a,{metrics:{cursor:3,toolCalls:1,completedTools:1,failedTools:0},complete:false,eventsRead:3});
 assert.throws(()=>foldProjectedCounts(a.metrics,p),/PROJECTION_CHECKPOINT_MISMATCH/);
 assert.throws(()=>foldProjectedCounts(prior,{from:'',rows:[{seq:1,type:'session.tool.failed'}],complete:true}),/PROJECTION_METRICS_INVALID/);
});

test('canonical view scope and checkpoint reject before effects',async()=>{
 const s=fixture(3);await assert.rejects(projectedDirectory(s,{...scope,session:'ses_other'},key,undefined,limits),/SCOPE_INVALID/);assert.equal(s.stats().calls,0);
 const {foldProjectedCounts}=await import('../../../src/metralla-m02-projection.ts');const m={cursor:1,toolCalls:1,completedTools:0,failedTools:0};
 assert.throws(()=>foldProjectedCounts(m,{from:'01',rows:[],complete:true}),/PROJECTION_CHECKPOINT_MISMATCH/);
});

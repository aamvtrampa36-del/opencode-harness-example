import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureInspectedArtifact,artifactKey,artifactView,persistTaskArtifact} from './task-output-artifacts.ts';
import {parseArtifactQuery,scopedArtifactDownload} from './metralla-m06-artifact-http.ts';
import {taskArtifactExportResponse} from './session-export.ts';
const scope={id:'0000000000000001',project:'supervised-0000000000000001',session:'sesFixture1',repository:'fixture/repo'};
const now=1000;
function storage(){const m=new Map();return {m,get:async k=>m.get(k),put:async(k,v)=>m.set(k,v),delete:async k=>m.delete(k)}}
async function cap(value='olá 🌎',at=now){let bytes=Buffer.from(value);return captureInspectedArtifact({requestId:scope.id,ownerProject:scope.project,ownerSession:scope.session,repository:scope.repository,request:{path:'dist/report.txt',name:'report.txt',mime:'text/plain'},inspected:{path:'dist/report.txt',byteSize:bytes.length,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')},now:at})}
test('generation-bound route delivers bytes and digest; stale and legacy paths fail',async()=>{
 const s=storage(),a=await cap();await persistTaskArtifact(s,scope,a,now);const u=new URL(artifactView(a).delivery.path,'https://fixture.invalid');
 const q=parseArtifactQuery(u.search,true);const r=await scopedArtifactDownload(s,scope,a.artifactId,q.expiresAt,null,now);
 assert.equal(r.status,200);assert.equal(r.headers.get('x-artifact-sha256'),a.sha256);assert.equal(r.headers.get('accept-ranges'),'none');
 assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),a.sha256);
 assert.throws(()=>parseArtifactQuery('',true));assert.throws(()=>parseArtifactQuery('?expires=1&expires=2',true));
 assert.equal((await scopedArtifactDownload(s,scope,a.artifactId,q.expiresAt,'bytes=0-1',now)).status,416);
 assert.equal((await scopedArtifactDownload(s,scope,a.artifactId,q.expiresAt,null,a.expiresAt)).status,410);
 const fresh=await cap('olá 🌎',a.expiresAt+1);s.m.set(artifactKey(scope.id,a.artifactId),fresh);
 assert.equal((await scopedArtifactDownload(s,scope,a.artifactId,q.expiresAt,null,a.expiresAt+1)).status,410);
});
test('foreign scope denied before expiry, tampered bytes and active MIME fail',async()=>{
 const s=storage(),a=await cap();await persistTaskArtifact(s,scope,a,now);
 for(const foreign of [{...scope,session:'sesOther'},{...scope,project:'foreign'},{...scope,repository:'other/repo'},{...scope,id:'0000000000000002'}]){
   const r=await scopedArtifactDownload(s,foreign,a.artifactId,a.expiresAt,null,a.expiresAt);assert.equal(r.status,404);assert.equal(r.headers.get('content-disposition'),null);
 }
 const key=artifactKey(scope.id,a.artifactId);for(const bad of [{...a,bytes:new Uint8Array(a.byteSize)},{...a,mime:'text/html',name:'report.html'}]){
   s.m.set(key,bad);assert.equal((await scopedArtifactDownload(s,scope,a.artifactId,a.expiresAt,null,now)).status,502);
 }
 assert.equal((await scopedArtifactDownload(s,scope,'../bad',a.expiresAt,null,now)).status,404);
});
test('bounded text/JSON export, task cursor and no private path',async()=>{
 const s=storage();for(const t of ['one','two','three'])await persistTaskArtifact(s,scope,await cap(t),now);
 const r=await taskArtifactExportResponse(s,scope,'json',undefined,2,now);assert.equal(r.status,200);
 const body=await r.json();assert.equal(body.items.length,2);assert.ok(body.nextAfter);assert.equal(r.headers.get('x-artifact-next-after'),body.nextAfter);
 assert.ok(!JSON.stringify(body).includes('dist/report.txt'));
 const next=await taskArtifactExportResponse(s,scope,'text',body.nextAfter,2,now);assert.equal(next.status,200);assert.match(await next.text(),/three/);
 assert.equal((await taskArtifactExportResponse(s,scope,'json',undefined,3,now)).status,400);
 await assert.rejects(taskArtifactExportResponse(s,scope,'json','0000000000000002:'+body.items[0].artifactId,2,now),/ARTIFACT_CURSOR_INVALID/);
 assert.throws(()=>parseArtifactQuery('?limit=9',false));assert.throws(()=>parseArtifactQuery('?token=unsafe',false));assert.throws(()=>parseArtifactQuery('?after=../a',false));
});

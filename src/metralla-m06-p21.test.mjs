import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {captureInspectedArtifact,artifactView,persistTaskArtifact} from './task-output-artifacts.ts';
import {scopedArtifactDownload,parseArtifactQuery} from './metralla-m06-artifact-http.ts';
import {artifactClientView,artifactClientViews,withoutVerifiedArtifactParts,verifiedClientArtifactBytes,artifactDownloadError} from './metralla-m06-artifact-client.ts';
const scope={id:'0000000000000001',project:'supervised-0000000000000001',session:'sesFixture1',repository:'fixture/repo'};
const now=1000;
const fixture=readFileSync(new URL('../docs/metralla/packets/M06/fixture-report.txt',import.meta.url));
const sha='abaa0f1eae42ea1b06d66caeb7476864414557bab2ef2f862cc2288ecdff2e3f';
async function cap(bytes=fixture){return captureInspectedArtifact({requestId:scope.id,ownerProject:scope.project,ownerSession:scope.session,repository:scope.repository,request:{path:'dist/report.txt',name:'report.txt',mime:'text/plain'},inspected:{path:'dist/report.txt',byteSize:bytes.length,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')},now})}
function storage(){const m=new Map();return {get:async k=>m.get(k),put:async(k,v)=>m.set(k,v),delete:async k=>m.delete(k)}}
test('real fixture readback via scoped authorized transport and independently verified bytes',async()=>{
 const a=await cap(),s=storage();await persistTaskArtifact(s,scope,a,now);const v=artifactView(a);
 assert.equal(v.sha256,sha);assert.equal(v.byteSize,31);
 let calls=0;
 const received=await verifiedClientArtifactBytes(v,async(path,init)=>{
  calls++;assert.equal(path,v.delivery.path);assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
  const q=parseArtifactQuery(new URL(path,'https://fixture.invalid').search,true);
  return scopedArtifactDownload(s,scope,v.artifactId,q.expiresAt,null,now);
 },now);
 assert.equal(calls,1);assert.deepEqual(Buffer.from(received),fixture);
});
test('typed file and JSON manifest only; internal, external, forged and cross-task parts never become verified links',async()=>{
 const v=artifactView(await cap());const file={type:'file',uri:v.delivery.path,mime:v.mime,name:v.name,artifact:v};
 const manifest={type:'text',text:JSON.stringify({schema:v.schema,requestId:v.requestId,artifacts:[v]})};
 assert.deepEqual(artifactClientViews([file,manifest]),[v]);
 const fake=[{...v,delivery:{...v.delivery,path:'/bundle/report.txt'}},{...v,mime:'text/html'},{...v,sha256:'bad'},
 {...v,delivery:{...v.delivery,path:'https://evil.invalid'+v.delivery.path}}];
 for(const f of fake)assert.equal(artifactClientView(f),null);
 assert.deepEqual(artifactClientViews([{...file,uri:'https://evil.invalid'+v.delivery.path},{type:'text',text:'/bundle/report.txt'},
 {type:'text',text:JSON.stringify({schema:v.schema,requestId:'0000000000000002',artifacts:[v]})}]),[]);
 assert.deepEqual(withoutVerifiedArtifactParts([file,{type:'file',uri:'data:text/plain,ok'}]),[{type:'file',uri:'data:text/plain,ok'}]);
});
test('auth denial, expiry and tampered response are readable and never save bytes',async()=>{
 const a=await cap(),v=artifactView(a);let calls=0;
 await assert.rejects(verifiedClientArtifactBytes(v,async()=>{calls++;return new Response('private detail',{status:401})},now),/ARTIFACT_AUTH_REQUIRED/);
 assert.match(artifactDownloadError(Error('ARTIFACT_AUTH_REQUIRED')),/autorizado/);
 await assert.rejects(verifiedClientArtifactBytes(v,async()=>{calls++;throw Error('no')},v.delivery.expiresAt),/ARTIFACT_EXPIRED/);
 assert.equal(calls,1);
 const headers={'content-length':String(v.byteSize),'content-type':v.mime+'; charset=utf-8','content-disposition':'attachment; filename="report.txt"','x-artifact-sha256':v.sha256};
 for(const bytes of [Buffer.alloc(v.byteSize),Buffer.alloc(v.byteSize+1),Buffer.alloc(v.byteSize-1)]) {
  await assert.rejects(verifiedClientArtifactBytes(v,async()=>new Response(bytes,{headers}),now),/ARTIFACT_INTEGRITY_FAILURE/);
 }
});
test('recognisable credential material in a trusted-reader receipt is still denied before capture',async()=>{
 for(const bytes of [Buffer.from('-----BEGIN PRIVATE KEY-----'),Buffer.from('{"password":"fixture-not-real-secret"}'),Buffer.from('Bearer fixture-not-real-token')]) {
   await assert.rejects(cap(bytes),/ARTIFACT_SECRET_PATTERN/);
 }
});

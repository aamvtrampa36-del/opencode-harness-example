/**
 * Loopback-only HTTP integration fixture of the R2 contract. NOT the deployed Worker.
 * The actual supervisor authentication and Durable Object bindings need a Staging E2E.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {
 captureInspectedArtifact, artifactKey, artifactIsOwnedBy, artifactView,
 verifiedArtifactDownload, TASK_ARTIFACT_PREFIX, TASK_ARTIFACT_TTL_MS
} from './task-output-artifacts.ts';

import {scopedArtifactDownload,parseArtifactQuery} from './metralla-m06-artifact-http.ts';

const NOW=1000;
const TOKEN='supervisor-fixture-token-not-a-real-credential';
const id=n=>n.toString(16).padStart(16,'0');
function scope(requestId){return {id:requestId,project:'supervised-'+requestId,session:'sesTest_'+requestId,repository:'aamvtrampa36-del/opencode-harness-example'};}
async function record(requestId,n,now=NOW){const contents=`verified-task-${n}`;const owner=scope(requestId);return captureInspectedArtifact({requestId,ownerProject:owner.project,ownerSession:owner.session,repository:owner.repository,request:{path:'dist/output.txt',name:'salida.txt',mime:'text/plain'},inspected:{path:'dist/output.txt',byteSize:Buffer.byteLength(contents),base64:Buffer.from(contents).toString('base64'),sha256:createHash('sha256').update(contents).digest('hex')},now});}

async function startFixture() {
 const records=new Map();
 const server=createServer(async(req,res)=>{
   // This fixture simulates the production *header* gate; it cannot assert the live Access policy.
   if(req.headers.authorization!==`Bearer ${TOKEN}`){res.writeHead(401,{'Cache-Control':'no-store'}).end();return;}
   const url=new URL(req.url||'/', 'http://127.0.0.1');
   const m=new RegExp(`^${TASK_ARTIFACT_PREFIX}/([a-f0-9]{16})/artifacts/([a-f0-9]{32})$`).exec(url.pathname);
   if(!m || req.method!=='GET'){res.writeHead(404).end();return;}
   let query; try { query=parseArtifactQuery(url.search,true); } catch {res.writeHead(400).end();return;}
   const result=await scopedArtifactDownload({get:async key=>records.get(key)},scope(m[1]),m[2],query.expiresAt,req.headers.range??null,NOW+1);
   res.writeHead(result.status,Object.fromEntries(result.headers));
   res.end(Buffer.from(await result.arrayBuffer()));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();
 return {records,base:`http://127.0.0.1:${address.port}`,close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}

test('ten real loopback GET requests recover each matching task bytes despite shuffled completion',async()=>{
 const fx=await startFixture();
 try{
  for(const n of [7,2,9,1,5,4,0,8,6,3]){const a=await record(id(n),n);fx.records.set(artifactKey(a.requestId,a.artifactId),a);}
  assert.equal(fx.records.size,10);
  for(let n=0;n<10;n++){
   const a=[...fx.records.values()].find(x=>x.requestId===id(n));
   const response=await fetch(new URL(artifactView(a).delivery.path,fx.base),{headers:{Authorization:`Bearer ${TOKEN}`},redirect:'manual'});
   assert.equal(response.status,200);
   assert.match(response.headers.get('content-disposition'),/^attachment;/i);
   assert.equal(response.headers.get('x-content-type-options'),'nosniff');
   assert.equal(response.headers.get('content-length'),String(a.byteSize));
   assert.equal(response.headers.get('content-type'),'text/plain; charset=utf-8');
   const received=new Uint8Array(await response.arrayBuffer());
   assert.equal(Buffer.from(received).toString(),'verified-task-'+n);
   assert.equal(createHash('sha256').update(received).digest('hex'),a.sha256);
   assert.equal(received.byteLength,a.byteSize);
  }
 }finally{await fx.close();}
});

test('an expired or rotated bearer cannot retrieve files; no public download',async()=>{
 const fx=await startFixture();
 try{
  const a=await record(id(1),1);fx.records.set(artifactKey(a.requestId,a.artifactId),a);
  const url=fx.base+artifactView(a).delivery.path;
  for(const headers of [{}, {Authorization:'Bearer expired-token'}, {Authorization:'Bearer '+TOKEN+'-old'}]){
   const res=await fetch(url,{headers,redirect:'manual'});
   assert.equal(res.status,401);assert.equal(res.headers.get('content-disposition'),null);
  }
 }finally{await fx.close();}
});

test('cross-task ID, wrong artifact ID, URL query and internal path are denied',async()=>{
 const fx=await startFixture();
 try{
  const a=await record(id(1),1);fx.records.set(artifactKey(a.requestId,a.artifactId),a);
  const headers={Authorization:`Bearer ${TOKEN}`};
  const paths=[
   `${TASK_ARTIFACT_PREFIX}/${id(2)}/artifacts/${a.artifactId}`,
   `${TASK_ARTIFACT_PREFIX}/${id(1)}/artifacts/${'e'.repeat(32)}`,
   `${TASK_ARTIFACT_PREFIX}/${id(1)}/artifacts/${a.artifactId}?token=unsafe`,
   '/bundle/output.txt','/file:%2F%2F%2Fbundle/output.txt',
   `${TASK_ARTIFACT_PREFIX}/${id(1)}/artifacts/../../etc/passwd`
  ];
  for(const path of paths){const res=await fetch(fx.base+path,{headers,redirect:'manual'});assert.notEqual(res.status,200);assert.equal(res.headers.get('content-disposition'),null);}
 }finally{await fx.close();}
});

test('expired artifact is rejected by real download implementation (not just omitted by manifest)',async()=>{
 const a=await record(id(1),1);const res=await verifiedArtifactDownload(a,NOW+TASK_ARTIFACT_TTL_MS);
 assert.equal(res.status,410);assert.equal(res.headers.get('content-disposition'),null);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {manifest} from './metralla-m07/manifest.mjs';
import {fixtureTrace} from './metralla-m07/fixture-trace.mjs';
import {evaluateFixture} from './metralla-m07/evaluator.mjs';
import {captureInspectedArtifact,persistTaskArtifact,readTaskArtifactPage,artifactKey} from '../../src/task-output-artifacts.ts';
import {scopedArtifactDownload} from '../../src/metralla-m06-artifact-http.ts';
import {selectExpectedArtifact,checkCollectedBytes,collectM06Artifact,M08_STAGING_ORIGIN} from './m08-artifact-collector.mjs';
const now=1000;
function storage(rows=new Map()){return {rows,get:async k=>structuredClone(rows.get(k)),put:async(k,v)=>rows.set(k,structuredClone(v)),delete:async k=>rows.delete(k)};}
async function prepare(spec,i){
 const id=(i+1).toString(16).padStart(16,'0'),scope={id,project:'supervised-'+id,session:'sesFixture'+i,repository:'fixture/repo'};
 const content=spec.expected.content,bytes=Buffer.from(content),sha256=createHash('sha256').update(bytes).digest('hex');
 const expected={requestId:id,sessionId:scope.session,operationId:'fixture-operation-'+i,projectId:scope.project,
   kind:spec.kind,path:'dist/'+spec.kind+'.json',name:spec.kind+'.json',mime:'application/json',sha256,byteSize:bytes.length};
 const record=await captureInspectedArtifact({requestId:id,ownerProject:scope.project,ownerSession:scope.session,
   repository:scope.repository,request:{path:expected.path,name:expected.name,mime:expected.mime},
   inspected:{path:expected.path,base64:bytes.toString('base64'),byteSize:bytes.length,sha256},now});
 const first=storage();await persistTaskArtifact(first,scope,record,now);const saved=storage(structuredClone(first.rows));
 const page=await readTaskArtifactPage(saved,scope,undefined,8,now);
 const response={schema:'opencode.task-output.v1',requestId:id,...page,errors:[],
   evidence:{sessionId:scope.session,operationId:expected.operationId,projectId:scope.project}};
 const fetcher=async(path,init)=>{
   const url=new URL(path,'https://fixture.invalid');
   assert.equal(init.redirect,'error');assert.equal(init.method,'GET');
   assert.equal(url.pathname,'/api/supervisor/v1/tasks/'+id+'/artifacts/'+record.artifactId);
   return scopedArtifactDownload(saved,scope,record.artifactId,Number(url.searchParams.get('expires')),null,now);
 };
 return {expected,record,scope,saved,response,fetcher};
}
test('M06 storage -> scoped bytes -> M07 ten independent oracles; serialized reconstruction fixture only',async()=>{
 for(const [i,spec] of manifest(10).tasks.entries()){
   const x=await prepare(spec,i);
   const view=selectExpectedArtifact(x.response,x.expected);
   const artifact=await checkCollectedBytes(view,x.expected,x.fetcher,now);
   assert.equal(artifact.content,spec.expected.content);assert.equal(artifact.sha256,spec.expected.sha256);
   assert.equal(artifact.byteLength,spec.expected.size);assert.equal(artifact.path,x.expected.path);
 }
});
test('cross-task, session, operation, incomplete manifest, external URL and wrong oracle rejected',async()=>{
 const x=await prepare(manifest(1).tasks[0],0);
 for(const response of [{...x.response,requestId:'0000000000000002'},
   {...x.response,evidence:{...x.response.evidence,sessionId:'sesOther'}},
   {...x.response,evidence:{...x.response.evidence,operationId:'wrong'}},
   {...x.response,nextAfter:'other'},{...x.response,artifacts:[{...x.response.artifacts[0],delivery:{...x.response.artifacts[0].delivery,path:'https://evil.invalid/'}}]}])
   assert.throws(()=>selectExpectedArtifact(response,x.expected),/M08_/);
 const view=selectExpectedArtifact(x.response,x.expected);
 await assert.rejects(checkCollectedBytes(view,{...x.expected,kind:'csv'},x.fetcher,now),/M08_ORACLE_MISMATCH/);
 x.saved.rows.set(artifactKey(x.scope.id,x.record.artifactId),{...x.record,bytes:new Uint8Array(x.record.byteSize)});
 await assert.rejects(checkCollectedBytes(view,x.expected,x.fetcher,now),/ARTIFACT_UNAVAILABLE/);
});
test('live collector rejects insecure origins and missing credentials before any fetch',async()=>{
 await assert.rejects(collectM06Artifact({origin:'http://fixture.invalid'}),/M08_ORIGIN_INVALID/);
 await assert.rejects(collectM06Artifact({origin:M08_STAGING_ORIGIN}),/M08_CREDENTIALS_REQUIRED/);
});

test('M07 evaluator consumes M06 verified fixture readbacks at 1/2/4/10; never live',async()=>{
 for(const n of [1,2,4,10]){
  const {m,trace}=fixtureTrace(n);
  for(const [i,spec] of m.tasks.entries()){
   const x=await prepare(spec,i),view=selectExpectedArtifact(x.response,x.expected);
   const observed=await checkCollectedBytes(view,x.expected,x.fetcher,now);
   // Logical fixture path is distinct from physical captured dist path.
   const event=trace.events.find(e=>e.fixtureId===spec.fixtureId&&e.type==="readback");
   event.artifact={content:observed.content,sha256:observed.sha256,size:observed.byteLength,type:view.mime,path:spec.expected.path};
   event.fixturePhysicalSourcePath=observed.path;
  }
  const result=evaluateFixture(m,trace);
  assert.equal(result.fixturePass,true,JSON.stringify(result.failures));assert.equal(result.livePass,false);
  trace.events.find(e=>e.type==="readback").artifact.content="{}";
  assert.equal(evaluateFixture(m,trace).fixturePass,false);
 }
});

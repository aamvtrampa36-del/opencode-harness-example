// M08: operator-side M06 -> M07 byte collector. Never dispatches tasks or signs evidence.
import { createHash, randomUUID } from 'node:crypto';
import { artifactClientView, verifiedClientArtifactBytes } from '../../src/metralla-m06-artifact-client.ts';
import { TASK_ARTIFACT_SCHEMA, validateCaptureRequest } from '../../src/task-output-artifacts.ts';
import { verifyArtifact } from './tasks.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check=(condition,code)=>{if(!condition)throw Error(code);};
const MAX_MANIFEST=16384;
export const M08_STAGING_ORIGIN='https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev';

// The expected identity and oracle come from the independently frozen operator plan,
// never from the returned manifest or a model assertion.
export function selectExpectedArtifact(manifest, expected) {
  check(expected && /^[a-f0-9]{16}$/.test(expected.requestId) &&
    /^ses[A-Za-z0-9_]{1,64}$/.test(expected.sessionId) &&
    expected.projectId==='supervised-'+expected.requestId &&
    typeof expected.operationId==='string' && expected.operationId.length>0 && expected.operationId.length<=256 &&
    /^[a-f0-9]{64}$/.test(expected.sha256) && Number.isSafeInteger(expected.byteSize) &&
    expected.byteSize>=0 && expected.byteSize<=8192,'M08_EXPECTED_SCOPE');
  const source=validateCaptureRequest({path:expected.path,name:expected.name,mime:expected.mime});
  const id=hash([expected.requestId,source.path,source.name,source.mime,expected.sha256].join('\n')).slice(0,32);
  check(manifest?.schema===TASK_ARTIFACT_SCHEMA && manifest.requestId===expected.requestId &&
    manifest.evidence?.sessionId===expected.sessionId && manifest.evidence?.operationId===expected.operationId &&
    manifest.evidence?.projectId===expected.projectId && manifest.nextAfter===null &&
    Array.isArray(manifest.artifacts) && manifest.artifacts.length<=8 &&
    Array.isArray(manifest.errors) && manifest.errors.length===0 &&
    manifest._responseTruncated!==true,'M08_MANIFEST_SCOPE');
  const views=manifest.artifacts.map(artifactClientView);
  check(views.every(v=>v && v.requestId===expected.requestId) &&
    new Set(views.map(v=>v.artifactId)).size===views.length,'M08_MANIFEST_INVALID');
  const view=views.find(v=>v.artifactId===id);
  check(view && view.sha256===expected.sha256 && view.byteSize===expected.byteSize &&
    view.name===source.name && view.mime===source.mime,'M08_ARTIFACT_MISSING_OR_MISMATCH');
  return view;
}
export async function checkCollectedBytes(view, expected, fetcher, now=Date.now()) {
  const bytes=Buffer.from(await verifiedClientArtifactBytes(view,fetcher,now));
  const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const artifact={kind:expected.kind,projectId:expected.projectId,path:expected.path,content,
    sha256:hash(bytes),byteLength:bytes.length,bytesBase64:bytes.toString('base64'),retrievedAtMs:now};
  check(artifact.sha256===expected.sha256 && artifact.byteLength===expected.byteSize &&
    verifyArtifact(expected,artifact),'M08_ORACLE_MISMATCH');
  return artifact;
}
async function boundedJson(response) {
  check(response.status===200 && !response.redirected &&
    /^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''),'M08_MANIFEST_HTTP');
  const reader=response.body?.getReader();check(reader,'M08_MANIFEST_BODY');
  const bytes=new Uint8Array(MAX_MANIFEST);let used=0;
  try {
    while(true){const part=await reader.read();if(part.done)break;
      check(part.value.length<=MAX_MANIFEST-used,'M08_MANIFEST_LIMIT');
      bytes.set(part.value,used);used+=part.value.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)));
  } catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}
// Only an operator-controlled HTTPS origin and header credentials may be used.
// No arbitrary URL, redirects, query token, automatic retries or key generation.
// This is an unsigned observation, NOT evidence that a live gate passed.
export async function collectM06Artifact({origin,supervisorBearer,accessClientId,accessClientSecret,expected}) {
  const base=new URL(origin);
  check(origin===M08_STAGING_ORIGIN && base.protocol==='https:' && base.origin===origin && !base.username && !base.password &&
    !base.hash && !base.search,'M08_ORIGIN_INVALID');
  check(typeof supervisorBearer==='string' && supervisorBearer.length>=32 &&
    typeof accessClientId==='string' && accessClientId.length>0 &&
    typeof accessClientSecret==='string' && accessClientSecret.length>0,'M08_CREDENTIALS_REQUIRED');
  check(expected && /^[a-f0-9]{16}$/.test(expected.requestId),'M08_EXPECTED_SCOPE');
  const headers=new Headers({Authorization:'Bearer '+supervisorBearer,
    'CF-Access-Client-Id':accessClientId,'CF-Access-Client-Secret':accessClientSecret});
  const prefix='/api/supervisor/v1/tasks/'+expected.requestId+'/artifacts';
  const read=async(path,init={})=>{
    const url=new URL(path,base);
    check(url.origin===base.origin && (url.pathname===prefix || url.pathname.startsWith(prefix+'/')),'M08_ROUTE_SCOPE');
    try{return await fetch(url,{...init,method:'GET',headers,redirect:'error',cache:'no-store',
      signal:AbortSignal.timeout(15000)});}catch{throw Error('M08_HTTP_UNAVAILABLE');}
  };
  const manifest=await boundedJson(await read(prefix+'?limit=8'));
  const view=selectExpectedArtifact(manifest,expected);
  const artifact=await checkCollectedBytes(view,expected,read);
  artifact.retrievedAtMs=Date.now(); // byte retrieval completed, not request start
  return {evidenceClass:'unsigned-http-observation',livePass:false,requestId:expected.requestId,
    sessionId:expected.sessionId,operationId:expected.operationId,projectId:expected.projectId,
    artifact,retrievalReceipt:{method:'GET',status:200,authenticated:true,retrievalId:randomUUID(),
      sha256:artifact.sha256,byteLength:artifact.byteLength}};
}

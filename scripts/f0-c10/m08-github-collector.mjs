// M08: independent, bounded GitHub readback for an exact frozen M05 intent.
// No mutation, no key generation, no automatic retry, no live PASS.
import { createHash } from 'node:crypto';
import { canonicalJson } from './live-evidence.mjs';
const REPO='aamvtrampa36-del/opencode-harness-example';
const API='https://api.github.com';
const SHA=/^[a-f0-9]{40}$/;
const ID=/^[a-f0-9]{16}$/;
const check=(v,code)=>{if(!v)throw Error(code);};
const pathOk=p=>typeof p==='string'&&p.length>0&&p.length<=240&&!p.startsWith('/')&&!p.includes('\\')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&!/[\x00-\x1f\x7f]/.test(s));
const sha256=x=>createHash('sha256').update(canonicalJson(x)).digest('hex');
function freezeIntent(e){
  check(e&&e.repo===REPO&&ID.test(e.requestId)&&e.branch==='opencode/staging-'+e.requestId&&
    typeof e.sessionId==='string'&&/^ses[A-Za-z0-9_]{1,64}$/.test(e.sessionId)&&
    typeof e.operationId==='string'&&e.operationId.length>0&&e.operationId.length<=256&&
    e.projectId==='supervised-'+e.requestId&&SHA.test(e.sourceSha)&&SHA.test(e.baseSha)&&
    SHA.test(e.headSha)&&SHA.test(e.headTree)&&e.headSha!==e.baseSha&&
    typeof e.base==='string'&&/^[A-Za-z0-9][A-Za-z0-9_./-]{0,150}$/.test(e.base)&&
    e.base.split('/').every(s=>s&&s!=='.'&&s!=='..')&&e.base!==e.branch&&
    Number.isSafeInteger(e.pr)&&e.pr>0&&Array.isArray(e.files)&&e.files.length>0&&e.files.length<=100,
    'M08_GITHUB_INTENT');
  const files=e.files.map(f=>{
    check(f&&pathOk(f.path)&&SHA.test(f.sha)&&['added','modified'].includes(f.status),'M08_GITHUB_FILE_SCOPE');
    return {path:f.path,sha:f.sha,status:f.status};
  }).sort((a,b)=>a.path.localeCompare(b.path));
  check(new Set(files.map(f=>f.path)).size===files.length,'M08_GITHUB_DUPLICATE_FILE');
  return {repo:e.repo,requestId:e.requestId,sessionId:e.sessionId,operationId:e.operationId,projectId:e.projectId,
    sourceSha:e.sourceSha,base:e.base,baseSha:e.baseSha,branch:e.branch,headSha:e.headSha,headTree:e.headTree,pr:e.pr,files};
}
async function jsonBounded(response,max){
  check(response.status===200&&!response.redirected&&
    /^application\/(?:json|vnd\.github\+json)(?:;|$)/i.test(response.headers.get('content-type')||''),'M08_GITHUB_HTTP');
  const reader=response.body?.getReader();check(reader,'M08_GITHUB_BODY');
  const buf=new Uint8Array(max);let n=0;
  try{
    while(true){const p=await reader.read();if(p.done)break;
      check(p.value.byteLength<=max-n,'M08_GITHUB_BODY_LIMIT');buf.set(p.value,n);n+=p.value.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buf.subarray(0,n)));
  }catch(e){void reader.cancel().catch(()=>{});throw e;}
  finally{reader.releaseLock();}
}
// Transport injection is for offline fixtures. Live entrypoint below fixes origin and credentials.
export async function verifyGitHubReadback(expected,read){
  const e=freezeIntent(expected),prefix='/repos/'+REPO;
  const refPath=prefix+'/git/ref/heads/'+e.branch;
  const basePath=prefix+'/git/ref/heads/'+e.base;
  const refOk=(v,branch,sha)=>v?.ref==='refs/heads/'+branch&&v.object?.type==='commit'&&v.object?.sha===sha;
  check(refOk(await read(refPath),e.branch,e.headSha),'M08_GITHUB_HEAD_MISMATCH');
  check(refOk(await read(basePath),e.base,e.baseSha),'M08_GITHUB_BASE_MISMATCH');
  const c=await read(prefix+'/git/commits/'+e.headSha);
  check(c?.sha===e.headSha&&c.tree?.sha===e.headTree,'M08_GITHUB_TREE_MISMATCH');
  const prPath=prefix+'/pulls/'+e.pr;
  const pr=await read(prPath);
  const prOk=p=>p?.number===e.pr&&p.state==='open'&&p.draft===true&&p.merged===false&&
    p.head?.repo?.full_name===REPO&&p.base?.repo?.full_name===REPO&&
    p.head.ref===e.branch&&p.head.sha===e.headSha&&p.base.ref===e.base&&p.base.sha===e.baseSha&&
    p.changed_files===e.files.length;
  check(prOk(pr),'M08_GITHUB_PR_MISMATCH');
  const compare=await read(prefix+'/compare/'+e.baseSha+'...'+e.headSha+'?per_page=100');
  check(compare?.status==='ahead'&&compare.behind_by===0&&compare.ahead_by>0&&
    compare.merge_base_commit?.sha===e.baseSha&&Array.isArray(compare.files)&&compare.files.length===e.files.length,
    'M08_GITHUB_COMPARE_SCOPE');
  const actual=compare.files.map(f=>({path:f.filename,sha:f.sha,status:f.status})).sort((a,b)=>a.path.localeCompare(b.path));
  check(canonicalJson(actual)===canonicalJson(e.files),'M08_GITHUB_DIFF_MISMATCH');
  check(prOk(await read(prPath))&&refOk(await read(basePath),e.base,e.baseSha)&&
    refOk(await read(refPath),e.branch,e.headSha),'M08_GITHUB_READBACK_CHANGED');
  return {schema:'metralla.m08.github-readback.v1',evidenceClass:'untrusted-transport-observation',
    livePass:false,intent:e,intentSha256:sha256(e),verified:true};
}
export async function collectGitHubReadback({expected,token}){
  check(typeof token==='string'&&token.length>=20&&!/\s/.test(token),'M08_GITHUB_AUTH_REQUIRED');
  const intent=freezeIntent(expected), signal=AbortSignal.timeout(15000);
  const read=async path=>{
    const url=new URL(path,API);
    check(url.origin===API&&url.pathname.startsWith('/repos/'+REPO+'/')&&!url.hash,'M08_GITHUB_ORIGIN');
    let response;
    try{response=await fetch(url,{method:'GET',redirect:'error',cache:'no-store',signal,
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});}
    catch{throw Error('M08_GITHUB_UNAVAILABLE');}
    return jsonBounded(response,1024*1024);
  };
  const observed=await verifyGitHubReadback(intent,read);
  // A caller may attach this to an independently provisioned signer only after
  // authorization and collector audit. This function never certifies the gate.
  return {...observed,evidenceClass:'unsigned-authenticated-http-observation'};
}

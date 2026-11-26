import {createHash,createPublicKey,verify} from 'node:crypto';
import {digest,canonicalJson,EVIDENCE_ROLES} from '../live-evidence.mjs';
import {OBSERVED_JOURNAL_SCHEMA,OBSERVER_ORIGINS,observedClaimHash,observedClaimBytes} from '../observed-journal.mjs';
import {evaluateTrace,LIVE_LIMITS} from '../evaluate.mjs';
import {TASKS,canonicalOutput,sha256} from '../tasks.mjs';
import {collectM06Artifact,M08_STAGING_ORIGIN} from '../m08-artifact-collector.mjs';
import {collectGitHubReadback} from '../m08-github-collector.mjs';

const REPO='aamvtrampa36-del/opencode-harness-example';
const PATH='docs/opencode-agent-lab/fixture-report.json';
const ID=/^[a-f0-9]{16}$/, SHA=/^[a-f0-9]{40}$/, HASH=/^[a-f0-9]{64}$/;
const ROLES=['github','physical','logical'];
const FIELDS=['experimentId','sourceSha','gitBaseSha','workerVersion','mcpVersion','workerDeploymentId','mcpDeploymentId','leaseId','fencingToken','limitsSha256'];
const IDENTITY=['requestId','sessionId','operationId','projectId','executorId','kind'];
const bound=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const uint=x=>Number.isSafeInteger(x)&&x>=0;
const check=(v,code)=>{if(!v)throw Error(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const project=(x,fields)=>Object.fromEntries(fields.map(k=>[k,x[k]]));
const fingerprint=pem=>{const k=createPublicKey(pem);check(k.asymmetricKeyType==='ed25519','M07_KEY_TYPE');return createHash('sha256').update(k.export({format:'der',type:'spki'})).digest('hex');};
const message=(domain,value)=>Buffer.from('OPEN-CODE/METRALLA/M07/V1/'+domain+'\0'+canonicalJson(value),'utf8');
export const roundApprovalBytes=plan=>message('approval',plan);
export const supplementalBytes=(role,plan,rows)=>message('supplement/'+role,{planDigest:digest(plan),rows});
export const journalSealBytes=(plan,seal)=>message('journal-seal',{planDigest:digest(plan),seal});
function signature(pem,bytes,sig){
 check(typeof sig==='string'&&sig.length===88&&Buffer.from(sig,'base64').length===64&&Buffer.from(sig,'base64').toString('base64')===sig&&verify(null,bytes,createPublicKey(pem),Buffer.from(sig,'base64')),'M07_SIGNATURE_INVALID');
}
function unique(arr){return new Set(arr).size===arr.length;}
function within(t,p){return uint(t)&&t>=p.notBefore&&t<=p.expiresAt;}
function exactIdentity(row,task){check(same(project(row,IDENTITY),project(task,IDENTITY)),'M07_TASK_SCOPE');}
export function artifactExpectation(task){
 const content=canonicalOutput(task.kind);
 return {...project(task,['requestId','sessionId','operationId','projectId','kind']),path:'dist/'+task.kind+'.json',name:task.kind+'.json',mime:'application/json',sha256:sha256(content),byteSize:Buffer.byteLength(content)};
}
/** Plan is signed by the already trusted operator; model/trace cannot mint it.
 * A fixture plan uses independent ephemeral test keys and is permanently offline. */
export function validateRoundApproval(approval,limits,trust,meta){
 const p=approval?.plan;
 check(p?.schema==='metralla.m07.integrated-round.v1'&&['live','fixture'].includes(p.mode)&&p.environment==='staging'&&
  p.context&&FIELDS.every(k=>bound(p.context[k]))&&SHA.test(p.context.sourceSha)&&SHA.test(p.context.gitBaseSha)&&
  p.context.limitsSha256===digest(limits)&&uint(p.notBefore)&&uint(p.expiresAt)&&p.expiresAt>p.notBefore&&p.expiresAt-p.notBefore<=3600000&&
  bound(p.approvalRef)&&[1,2,4,10].includes(p.tasks?.length),'M07_PLAN_INVALID');
 // Only explicit spend caps are run-specific. Baseline safety thresholds cannot be relaxed.
 check(Object.keys(limits).sort().join(',')===Object.keys(LIVE_LIMITS).sort().join(',')&&
  Object.entries(LIVE_LIMITS).every(([k,v])=>v===null?Number.isFinite(limits[k])&&limits[k]>0:limits[k]===v)&&
  limits.maxCampaignCostUsd>=limits.maxCostUsd,'M07_LIMITS_INVALID');
 if(meta)check(meta.environment==='staging'&&same(project(meta,FIELDS),p.context)&&meta.artifactLayout==='m06-dist-v1','M07_RELEASE_SCOPE');
 const allKeys=[trust.operatorPublicKeyPem,...EVIDENCE_ROLES.map(k=>trust[k]),...OBSERVER_ORIGINS.map(k=>trust.observers[k].publicKeyPem),...ROLES.map(k=>trust.supplemental[k])];
 check(unique(allKeys.map(fingerprint)),'M07_KEY_REUSE');
 const keyPins=Object.fromEntries([...EVIDENCE_ROLES.map(k=>[k,fingerprint(trust[k])]),...OBSERVER_ORIGINS.map(k=>['observer:'+k,fingerprint(trust.observers[k].publicKeyPem)]),...ROLES.map(k=>[k,fingerprint(trust.supplemental[k])])]);
 check(same(p.keyPins,keyPins),'M07_KEY_SCOPE');
 signature(trust.operatorPublicKeyPem,roundApprovalBytes(p),approval.signature);
 for(const [i,t] of p.tasks.entries()){
  check(t.kind===TASKS[i].kind&&ID.test(t.requestId)&&t.sessionId==='ses_r2_'+t.requestId&&t.operationId==='rc-start-'+t.requestId&&t.projectId==='supervised-'+t.requestId&&bound(t.executorId)&&
   same(t.artifact,artifactExpectation(t)),'M07_PLAN_TASK');
  if(i===p.tasks.length-1){
   const g=t.github;
   check(g?.repo===REPO&&g.branch==='opencode/staging-'+t.requestId&&g.baseSha===p.context.gitBaseSha&&bound(g.base)&&g.base!==g.branch&&g.path===PATH,'M07_PLAN_GITHUB');
  }else check(t.github===null,'M07_PLAN_GITHUB');
 }
 for(const k of IDENTITY)check(unique(p.tasks.map(t=>t[k])),'M07_DUPLICATE_TASK');
 return p;
}
function validateGitHubIntent(intent,t,p){
 const g=t.github,content=canonicalOutput(t.kind);
 const blob=createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0').update(content).digest('hex');
 check(g&&intent&&intent.repo===g.repo&&intent.requestId===t.requestId&&intent.sessionId===t.sessionId&&intent.operationId===t.operationId&&intent.projectId===t.projectId&&intent.sourceSha===p.context.sourceSha&&intent.base===g.base&&intent.baseSha===g.baseSha&&intent.branch===g.branch&&
  SHA.test(intent.headSha)&&intent.headSha!==g.baseSha&&SHA.test(intent.headTree)&&uint(intent.pr)&&intent.pr>0&&intent.files?.length===1&&intent.files[0].path===g.path&&intent.files[0].sha===blob&&['added','modified'].includes(intent.files[0].status),'M07_GITHUB_INTENT');
}
function validateSupplement(trace,p,supplement,trust){
 check(supplement&&Object.keys(supplement).sort().join(',')===ROLES.slice().sort().join(','),'M07_SUPPLEMENT_MISSING');
 for(const role of ROLES){
  const x=supplement[role];
  check(Array.isArray(x.rows)&&x.rows.length===(role==='github'?1:p.tasks.length),'M07_SUPPLEMENT_COUNT');
  signature(trust.supplemental[role],supplementalBytes(role,p,x.rows),x.signature);
 }
 const phys=new Map(supplement.physical.rows.map(x=>[x.requestId,x])),logical=new Map(supplement.logical.rows.map(x=>[x.requestId,x]));
 check(phys.size===p.tasks.length&&logical.size===p.tasks.length,'M07_CLOSE_DUPLICATE');
 const github=supplement.github.rows[0];
 const published=p.tasks.at(-1);
 exactIdentity(github,published);validateGitHubIntent(github.observation?.intent,published,p);
 check(github.observation.schema==='metralla.m08.github-readback.v1'&&github.observation.verified===true&&github.observation.intentSha256===digest(github.observation.intent)&&
  (github.observation.evidenceClass==='unsigned-authenticated-http-observation'||p.mode==='fixture'&&github.observation.evidenceClass==='untrusted-transport-observation')&&within(github.observedAtMs,p),'M07_GITHUB_READBACK');
 for(const t of p.tasks){
  const events=trace.events.filter(e=>e.requestId===t.requestId),done=events.find(e=>e.type==='completed'),read=events.find(e=>e.type==='artifact_readback');
  const a=phys.get(t.requestId),b=logical.get(t.requestId);
  exactIdentity(a,t);exactIdentity(b,t);
  const containers=new Set(events.filter(e=>e.type==='tool_start'||e.type==='tool_end').map(e=>e.containerId));
  check(containers.size===1&&containers.has(a.containerId)&&bound(a.bootId)&&bound(a.closeOperation)&&HASH.test(a.snapshotDigest)&&HASH.test(a.taskDigest)&&HASH.test(a.nativeReceiptDigest)&&
   within(a.observedAtMs,p)&&a.observedAtMs>=done.atMs&&a.vmTerminated===true&&a.descendants===0&&a.nativeOperations===0&&a.nativeSource==='independent-native','M07_PHYSICAL_CLOSE');
  check(within(b.observedAtMs,p)&&b.observedAtMs>=a.observedAtMs&&b.taskDigest===a.taskDigest&&b.physicalReceiptSha256===digest(a)&&uint(b.generation)&&b.generation>0&&
   b.slotReleased===true&&b.reservedMicroUsd===0&&b.unknownMicroUsd===0&&b.outstandingEffects===0&&HASH.test(b.releaseReceiptDigest),'M07_LOGICAL_CLOSE');
  check(read.artifact.retrievedAtMs===read.atMs&&read.artifact.sha256===t.artifact.sha256&&read.artifact.byteLength===t.artifact.byteSize&&read.artifact.path===t.artifact.path&&read.atMs<=a.observedAtMs,'M07_ARTIFACT_SCOPE');
  if(t.github)check(github.observedAtMs>=read.atMs&&github.observedAtMs<=a.observedAtMs,'M07_GITHUB_ORDER');
 }
}
/** Source seals commit to the complete stream, preventing a signed prefix from
 * looking complete. Signers are externally approved, never keys in the trace. */
function validateJournalSeals(trace,p,seals,trust){
 const records=trace.observedJournal?.records;
 check(Array.isArray(records)&&records.length>0&&records.length<=5000&&seals&&Object.keys(seals).sort().join(',')===OBSERVER_ORIGINS.slice().sort().join(','),'M07_JOURNAL_SEALS');
 for(const origin of OBSERVER_ORIGINS){
  const rows=records.filter(x=>x.claim.origin===origin),last=rows.at(-1)?.claim;
  const x=seals[origin],seal=x?.seal;
  check(seal?.origin===origin&&seal.count===rows.length&&seal.head===(last?observedClaimHash(last):'0'.repeat(64))&&
    seal.complete===true&&within(seal.observedAtMs,p)&&seal.observedAtMs>=Math.max(...trace.events.map(e=>e.atMs),...rows.map(x=>x.claim.observedAtMs))&&
    seal.collectorId===trust.observers[origin].collectorId&&seal.deploymentId===trust.observers[origin].deploymentId,'M07_JOURNAL_SEAL_MISMATCH');
  signature(trust.observers[origin].publicKeyPem,journalSealBytes(p,seal),x.signature);
 }
}
export function verifyIntegratedRound(trace,{limits,trustedKeys:trust,approval,supplement,journalSeals}={}){
 try{
  const p=validateRoundApproval(approval,limits,trust,trace.metadata);
  check(trace.mode==='live'&&!trace.metadata.simulated&&!trace.metadata.fixture&&!trace.metadata.synthetic&&trace.evidenceClass!=='fixture'&&trace.tasks?.length===p.tasks.length&&Array.isArray(trace.events)&&trace.events.length<=5000,'M07_TRACE_INVALID');
  for(const [i,t] of trace.tasks.entries())exactIdentity(t,p.tasks[i]);
  check(trace.events.every(e=>within(e.atMs,p))&&trace.events.filter(e=>e.type==='artifact_readback').length===p.tasks.length,'M07_TRACE_WINDOW');
  check(!trace.events.some(e=>['oom','restart','cancelled','failed','response_lost'].includes(e.type)),'M07_NEGATIVE_IN_POSITIVE_ROUND');
  const t10=evaluateTrace(trace,{mode:'live',limits,trustedKeys:trust});
  if(!t10.pass)return {pass:false,livePass:false,contractPass:false,code:'M07_T10_RED',t10};
  validateJournalSeals(trace,p,journalSeals,trust);
  validateSupplement(trace,p,supplement,trust);
  return {pass:p.mode==='live',livePass:p.mode==='live',contractPass:true,evidenceClass:p.mode==='live'?'signed-independent-evidence':'signed-fixture',taskCount:p.tasks.length,t10,planDigest:digest(p)};
 }catch(e){return {pass:false,livePass:false,contractPass:false,code:String(e.message).slice(0,150)};}
}
/** Read-only, bounded adapter: use independent M06 and M05 collectors rather
 * than converting model output into evidence. No dispatch, retry or signing.
 * A future operator invokes it only with the separately signed live plan. */
export async function collectRoundReadbacks({approval,limits,trustedKeys,githubIntent,credentials}){
 const p=validateRoundApproval(approval,limits,trustedKeys);
 check(p.mode==='live'&&within(Date.now(),p),'M07_COLLECTION_NOT_AUTHORIZED');
 validateGitHubIntent(githubIntent,p.tasks.at(-1),p);
 check(credentials&&typeof credentials.githubToken==='string'&&credentials.githubToken.length>=20&&typeof credentials.supervisorBearer==='string'&&credentials.supervisorBearer.length>=32&&bound(credentials.accessClientId)&&bound(credentials.accessClientSecret),'M07_COLLECTOR_AUTH_REQUIRED');
 const artifacts=[];
 // Strict sequential readback; never increases task/inference concurrency.
 for(const t of p.tasks)artifacts.push(await collectM06Artifact({origin:M08_STAGING_ORIGIN,supervisorBearer:credentials.supervisorBearer,accessClientId:credentials.accessClientId,accessClientSecret:credentials.accessClientSecret,expected:t.artifact}));
 const github=await collectGitHubReadback({expected:githubIntent,token:credentials.githubToken});
 return {planDigest:digest(p),artifacts,github,evidenceClass:'unsigned-authenticated-observations',livePass:false};
}
/** Read externally collected, already signed native records in bounded pages.
 * No event is generated from supervisor busy/finished text or model history.
 * Source readPage is an independently provisioned read-only observer port. */
export async function collectObserverPages({approval,limits,trustedKeys,readPage}){
 const p=validateRoundApproval(approval,limits,trustedKeys);
 check(typeof readPage==='function','M07_NATIVE_OBSERVER_PORT_REQUIRED');
 const records=[],seals={};
 for(const origin of OBSERVER_ORIGINS){
  let after=0,head='0'.repeat(64),done=false;
  for(let pages=0;pages<=157&&!done;pages++){
   const signal=AbortSignal.timeout(5000);
   let onAbort;
   const deadline=new Promise((_,reject)=>{onAbort=()=>reject(Error('M07_JOURNAL_PAGE_TIMEOUT'));signal.addEventListener('abort',onAbort,{once:true});});
   let page;
   try{page=await Promise.race([readPage({origin,planDigest:digest(p),after,head,limit:32,signal}),deadline]);}
   finally{signal.removeEventListener('abort',onAbort);}
   check(page?.origin===origin&&page.planDigest===digest(p)&&page.after===after&&Array.isArray(page.records)&&page.records.length<=32&&typeof page.complete==='boolean','M07_JOURNAL_PAGE_SCOPE');
   check(Buffer.byteLength(canonicalJson(page))<=262144,'M07_JOURNAL_PAGE_SIZE');
   for(const item of page.records){
    const c=item.claim;
    check(c.origin===origin&&c.seq===after+1&&c.prevHash===head&&c.experimentId===p.context.experimentId&&c.sourceSha===p.context.sourceSha&&c.workerVersion===p.context.workerVersion&&c.fencingToken===p.context.fencingToken&&within(c.observedAtMs,p),'M07_JOURNAL_PAGE_CHAIN');
    signature(trustedKeys.observers[origin].publicKeyPem,observedClaimBytes(c),item.signature);
    records.push(item);check(records.length<=5000,'M07_JOURNAL_LIMIT');after++;head=observedClaimHash(c);
   }
   if(page.complete){check(page.seal?.seal?.count===after&&page.seal.seal.head===head,'M07_JOURNAL_SEAL_MISMATCH');signature(trustedKeys.observers[origin].publicKeyPem,journalSealBytes(p,page.seal.seal),page.seal.signature);seals[origin]=page.seal;done=true;}
   else check(page.records.length>0&&!page.seal,'M07_JOURNAL_NO_PROGRESS');
  }
  check(done,'M07_JOURNAL_INCOMPLETE');
 }
 return {observedJournal:{schema:OBSERVED_JOURNAL_SCHEMA,records},journalSeals:seals,livePass:false};
}

/** Campaign validation cannot bypass the integrated per-round gate. */
export function verifyIntegratedCampaign(entries,{limits,trustedKeys}={}){
 if(!Array.isArray(entries)||entries.length!==3||entries.length!==limits?.minRounds)return {pass:false,livePass:false,code:'M07_CAMPAIGN_ROUNDS'};
 const reports=entries.map(x=>verifyIntegratedRound(x.trace,{limits,trustedKeys,approval:x.approval,supplement:x.supplement,journalSeals:x.journalSeals}));
 if(!reports.every(r=>r.contractPass))return {pass:false,livePass:false,contractPass:false,code:'M07_CAMPAIGN_ROUND_RED',reports};
 const plans=entries.map(x=>x.approval.plan),modes=new Set(plans.map(p=>p.mode));
 const releaseFields=['sourceSha','gitBaseSha','workerVersion','mcpVersion','workerDeploymentId','mcpDeploymentId','limitsSha256'];
 const all=plans.flatMap(p=>p.tasks);
 if(modes.size!==1||plans.some(p=>p.tasks.length!==10||!same(project(p.context,releaseFields),project(plans[0].context,releaseFields)))||
  !unique(plans.map(p=>p.context.experimentId))||['requestId','sessionId','operationId','projectId','executorId'].some(k=>!unique(all.map(t=>t[k]))))
  return {pass:false,livePass:false,contractPass:false,code:'M07_CAMPAIGN_SCOPE',reports};
 // Rounds are distinct and serial, never retroactively overlap authorized windows.
 for(let i=1;i<plans.length;i++){
  const prev=entries[i-1],end=Math.max(...prev.trace.events.map(e=>e.atMs),...prev.supplement.logical.rows.map(x=>x.observedAtMs),...Object.values(prev.journalSeals).map(x=>x.seal.observedAtMs));
  if(plans[i].notBefore<end)return {pass:false,livePass:false,contractPass:false,code:'M07_CAMPAIGN_NOT_DRAINED',reports};
 }
 const observedCostUsd=entries.reduce((v,x)=>v+x.trace.budget.totalUsd,0);
 if(!Number.isFinite(observedCostUsd)||observedCostUsd>limits.maxCampaignCostUsd)return {pass:false,livePass:false,contractPass:false,code:'M07_CAMPAIGN_COST',reports,observedCostUsd};
 return {pass:plans[0].mode==='live',livePass:plans[0].mode==='live',contractPass:true,reports,observedCostUsd};
}

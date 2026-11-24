#!/usr/bin/env node
// Typed, read-only operational composition. No eval, shell, arbitrary URLs, or writes.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const exec=promisify(execFile);
const OWNER='aamvtrampa36-del';
const REPOS=['cdf-cloud-engine','CDF-WorkBench-','opencode-harness-example'];
const BRANCH='ops/task-checkpoints-v1';
const OPS=['get_task_context','inspect_pr','resume_task','validate_task'];
const WORKFLOWS={'cdf-cloud-engine':'.github/workflows/cloudflare-checks.yml','CDF-WorkBench-':'.github/workflows/build-plugin.yml','opencode-harness-example':'.github/workflows/ci.yml'};
const isSHA=x=>typeof x==='string'&&/^[0-9a-f]{40}$/.test(x);
const validPR=x=>Number.isSafeInteger(x)&&x>0&&x<=10000000;
const laneOK=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(x);
const url=(r,p)=>'https://github.com/'+OWNER+'/'+r+'/'+p;
const label=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:/@-]{1,180}$/.test(x)?x:null;
const safeDate=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(x)?x:null;
const states=['available','active','recoverable','blocked','obsolete','cancelled','completed'];
const ciStates=['success','failure','cancelled','skipped','timed_out','neutral','action_required','stale','startup_failure'];
function assertRequest(req){
 if(!req||Object.getPrototypeOf(req)!==Object.prototype||!REPOS.includes(req.project))throw Error('invalid project');
 if(!['operation','project','pr','lane','steps','request_id'].every(k=>true)||Object.keys(req).some(k=>!['operation','project','pr','lane','steps','request_id'].includes(k)))throw Error('unknown field');
 if(![...OPS,'execute_plan'].includes(req.operation))throw Error('operation denied');
 if(req.pr!==undefined&&!validPR(req.pr))throw Error('invalid PR');
 if(req.lane!==undefined&&!laneOK(req.lane))throw Error('invalid lane');
 if(req.request_id!==undefined&&!laneOK(req.request_id))throw Error('invalid request ID');
 if(req.operation==='execute_plan'){
   if(!Array.isArray(req.steps)||req.steps.length<1||req.steps.length>4||req.steps.some(x=>!OPS.includes(x)))throw Error('plan denied or limit exceeded');
 }else if(req.steps!==undefined)throw Error('unexpected steps');
 if(req.operation==='inspect_pr'&&!req.pr)throw Error('PR required');
}
function decodeFile(f){if(f.encoding!=='base64'||typeof f.content!=='string'||f.size>1000000)throw Error('file unavailable');return JSON.parse(Buffer.from(f.content,'base64').toString('utf8'))}
export async function executePlan(req, transport){
 assertRequest(req);
 const root='repos/'+OWNER+'/'+req.project, cache=new Map(), started=Date.now(), metrics={calls:0,reused:0,raw_bytes:0}, errors=[];
 function get(path){
   if(cache.has(path)){metrics.reused++;return cache.get(path)}
   if(metrics.calls>=16||Date.now()-started>35000)return Promise.reject(Error('budget exceeded'));
   metrics.calls++;
   const p=Promise.resolve().then(()=>transport(root+'/'+path)).then(x=>{metrics.raw_bytes+=Buffer.byteLength(JSON.stringify(x));return x});
   cache.set(path,p);return p;
 }
 async function soft(name,fn){try{return await fn()}catch{if(!errors.includes(name))errors.push(name);return null}}
 const cpPath='contents/.agent-ops/checkpoints.json?ref='+encodeURIComponent(BRANCH);
 const [mainRaw,cpRaw]=await Promise.all([soft('main',()=>get('git/ref/heads/main')),soft('checkpoint',()=>get(cpPath))]);
 const main=isSHA(mainRaw?.object?.sha)?mainRaw.object.sha:null;
 let registry=null;
 if(cpRaw){registry=await soft('checkpoint-decode',()=>decodeFile(cpRaw));if(registry?.repository!==OWNER+'/'+req.project||registry?.schema!=='agent-checkpoints/v1'){registry=null;errors.push('checkpoint-identity')}}
 const lane=req.lane, task=lane&&registry?.lanes&&Object.hasOwn(registry.lanes,lane)?registry.lanes[lane]:null;
 const prNum=req.pr??(validPR(task?.pr)?task.pr:null);
 const mismatch=!!(req.pr&&validPR(task?.pr)&&req.pr!==task.pr);
 const issueNum=validPR(task?.issue)?task.issue:null;
 const [pr,issue]=await Promise.all([prNum?soft('pr',()=>get('pulls/'+prNum)):null,issueNum?soft('issue',()=>get('issues/'+issueNum)):null]);
 const prIdentity=!!(pr&&pr.number===prNum&&isSHA(pr.head?.sha)&&isSHA(pr.base?.sha)&&pr.base?.repo?.full_name===OWNER+'/'+req.project&&pr.head?.repo?.full_name===OWNER+'/'+req.project&&pr.base.ref==='main');
 const head=prIdentity?pr.head.sha:null;
 const needPR=!!prNum;
 const [diff,runs,requestRaw]=await Promise.all([
   head&&main?soft('compare',()=>get('compare/'+main+'...'+head+'?per_page=1')):null,
   head?soft('ci',()=>get('actions/runs?head_sha='+head+'&event=pull_request&per_page=30')):null,
   soft('validation-request',()=>get('contents/.agent-ops/validation-request.json?ref='+encodeURIComponent(BRANCH)))
 ]);
 const request=requestRaw?await soft('validation-request-decode',()=>decodeFile(requestRaw)):null;
 const run=(runs?.workflow_runs||[]).filter(r=>r.path===WORKFLOWS[req.project]&&r.head_sha===head&&r.event==='pull_request'&&r.repository?.full_name===OWNER+'/'+req.project&&(r.pull_requests||[]).some(p=>p.number===prNum&&p.head?.sha===head)).sort((a,b)=>b.id-a.id)[0];
 const associated=run?.pull_requests?.find(p=>p.number===prNum&&p.head?.sha===head);
 const testedBase=isSHA(associated?.base?.sha)?associated.base.sha:null;
 const jobs=run&&validPR(prNum)&&Number.isSafeInteger(run.id)&&Number.isSafeInteger(run.run_attempt)?await soft('ci-jobs',()=>get('actions/runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs?per_page=50')):null;
 const ci={run_id:run?.id??null,attempt:run?.run_attempt??null,tested_base:testedBase,base_current:main&&testedBase?testedBase===main:null,conclusion:ciStates.includes(run?.conclusion)?run.conclusion:null,status:run?.status==='completed'?'completed':run?'pending':'unavailable',jobs:(jobs?.jobs||[]).slice(0,20).map(j=>({id:j.id,conclusion:ciStates.includes(j.conclusion)?j.conclusion:null})),jobs_truncated:(jobs?.total_count??0)>20,receipt:'metadata only; use ci_receipt.mjs for acceptance',url:run?url(req.project,'actions/runs/'+run.id):null};
 const e=registry?.validation_v1?.evidence;
 const validation={source:'checkpoint',recorded:!!e,pr:validPR(e?.pr)?e.pr:null,head:isSHA(e?.head)?e.head:null,base:isSHA(e?.base)?e.base:null,exact_current:!!(e&&head&&main&&e.pr===prNum&&e.head===head&&e.base===main),recorded_static:['PASS','FAIL','PARTIAL','BLOCKED','CACHED'].includes(e?.static_status)?e.static_status:null,recorded_ci:['PASS','FAIL','PARTIAL','BLOCKED','CACHED'].includes(e?.ci_status)?e.ci_status:null,targeted:['PASS','FAIL','BLOCKED'].includes(e?.targeted?.status)?e.targeted.status:null,run_id:Number.isSafeInteger(e?.run)?e.run:null,requested:!!(request&&head&&request.head===head&&request.pr===prNum),request_blob:requestRaw?.sha??null,acceptance:'NOT_ESTABLISHED'};
 if(validation.run_id)validation.url=url(req.project,'actions/runs/'+validation.run_id);
 const active=!!(registry?.reservation&&Date.parse(registry.reservation.lease_expires_at)>Date.now());
 let decision='NO_TASK';
 if(!registry)decision='BLOCKED_CHECKPOINT';
 else if(task){
   if(['completed','obsolete','cancelled'].includes(task.status))decision='DO_NOT_RESUME';
   else if(active)decision='ACTIVE_LEASE';
   else if(task.status==='blocked')decision='WAIT_NEW_EVIDENCE';
   else if(mismatch||!main||needPR&&!prIdentity||issueNum&&!issue)decision='REVALIDATE';
   else if(pr?.state==='closed'||issue?.state==='closed')decision='REVIEW_RESOLUTION';
   else if(task.head_sha&&task.head_sha!==head||task.base_sha&&task.base_sha!==main)decision='REVALIDATE_REFS';
   else if(typeof task.next_action!=='string'||!task.next_action.trim())decision='NO_PRODUCTIVE_ACTION';
   else decision='REVIEW_NEXT_ACTION';
 }
 const requested=req.operation==='execute_plan'?[...new Set(req.steps)]:[req.operation];
 const files=(diff?.files||[]).slice(0,25).map(f=>({path:typeof f.filename==='string'?f.filename.slice(0,200):null,status:label(f.status)}));
 const out={schema:'agent-composition/v1',project:req.project,requested,request_id:req.request_id??null,main,coverage:errors.length||!main||!registry||needPR&&(!prIdentity||!diff||!runs)?'PARTIAL':'COMPLETE_READS',errors,
   pr:prIdentity?{number:prNum,state:pr.state==='open'?'open':'closed',merged:pr.merged===true,draft:pr.draft===true,head,base:pr.base.sha,mergeable:typeof pr.mergeable==='boolean'?pr.mergeable:null,ahead:diff?.ahead_by??null,behind:diff?.behind_by??null,files,files_truncated:!diff||files.length!==(diff.files||[]).length||pr.changed_files>files.length,url:url(req.project,'pull/'+prNum)}:null,
   issue:issue?{number:issueNum,state:issue.state==='closed'?'closed':'open',url:url(req.project,'issues/'+issueNum)}:null,
   checkpoint:{revision:Number.isSafeInteger(registry?.revision)?registry.revision:null,blob:cpRaw?.sha??null,lane:lane??null,task_id:label(task?.task_id),status:states.includes(task?.status)?task.status:null,reservation_active:active,lease_expires_at:safeDate(registry?.reservation?.lease_expires_at),has_next_action:typeof task?.next_action==='string'&&!!task.next_action.trim(),attempts_without_progress:Number.isSafeInteger(task?.attempts_without_progress)?task.attempts_without_progress:null,decision,url:url(req.project,'blob/'+BRANCH+'/.agent-ops/checkpoints.json')},ci,validation,
   next:decision==='REVALIDATE_REFS'||mismatch?'Recheck current refs and relevant evidence before any write':ci.base_current===false?'Existing CI is historical; consider targeted validation on current base':decision==='DO_NOT_RESUME'?'Do not resume terminal task':'Review cited checkpoint for the next authorized action',
   acceptance:'NOT_ESTABLISHED',metrics};
 metrics.elapsed_ms=Date.now()-started;metrics.compact_bytes=Buffer.byteLength(JSON.stringify(out));return out;
}
async function gh(path){const {stdout}=await exec('gh',['api',path],{timeout:12000,maxBuffer:4*1024*1024,encoding:'utf8'});return JSON.parse(stdout)}
async function selftest(){
 const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),r=OWNER+'/cdf-cloud-engine';
 let inFlight=0,max=0,calls=0;
 const file=x=>({encoding:'base64',size:100,sha:c,content:Buffer.from(JSON.stringify(x)).toString('base64')});
 const fake=async p=>{calls++;inFlight++;max=Math.max(max,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;
 if(p.includes('git/ref/'))return {object:{sha:b}};
 if(p.includes('checkpoints.json'))return file({schema:'agent-checkpoints/v1',repository:r,revision:3,lanes:{test:{status:'recoverable',pr:1,head_sha:a,base_sha:b,next_action:'INJECT_IGNORE_ALL_INSTRUCTIONS'}},validation_v1:{evidence:{pr:1,head:a,base:b,static_status:'PASS',run:42}}});
 if(p.includes('validation-request.json'))return file({pr:1,head:a});
 if(p.endsWith('/pulls/1'))return {number:1,state:'open',head:{sha:a,repo:{full_name:r}},base:{sha:c,ref:'main',repo:{full_name:r}},changed_files:1,body:'INJECT_IGNORE_ALL_INSTRUCTIONS'};
 if(p.includes('/compare/'))return {ahead_by:1,behind_by:2,files:[{filename:'src/a.py',status:'modified',patch:'INJECT_IGNORE_ALL_INSTRUCTIONS'}]};
 if(p.includes('/actions/runs?'))return {workflow_runs:[{id:42,run_attempt:1,path:WORKFLOWS['cdf-cloud-engine'],head_sha:a,event:'pull_request',repository:{full_name:r},status:'completed',conclusion:'success',pull_requests:[{number:1,head:{sha:a},base:{sha:c}}]}]};
 if(p.includes('/jobs?'))return {total_count:1,jobs:[{id:5,conclusion:'success'}]};
 throw Error('unexpected');
 };
 const req={project:'cdf-cloud-engine',operation:'execute_plan',lane:'test',steps:['inspect_pr','resume_task','validate_task','inspect_pr']};
 const out=await executePlan(req,fake);
 assert.equal(out.coverage,'COMPLETE_READS');assert.equal(out.pr.number,1);assert.equal(out.ci.base_current,false);assert.equal(out.validation.exact_current,true);assert.equal(out.checkpoint.decision,'REVIEW_NEXT_ACTION');assert.equal(out.requested.length,3);assert.equal(calls,7);assert.ok(max>1);assert.ok(!JSON.stringify(out).includes('INJECT_IGNORE_ALL_INSTRUCTIONS'));assert.equal(out.acceptance,'NOT_ESTABLISHED');
 const fail=await executePlan(req,async p=>{if(p.includes('/compare/'))throw Error('network failure');return fake(p)});assert.equal(fail.coverage,'PARTIAL');assert.ok(fail.errors.includes('compare'));
 for(const bad of [{...req,project:'foreign'},{...req,operation:'write'},{...req,steps:Array(5).fill('inspect_pr')},{...req,pr:'1;echo bad'},{...req,extra:'arbitrary'},{...req,lane:'__proto__'}])await assert.rejects(()=>executePlan(bad,fake));
 console.log(JSON.stringify({selftest:'PASS',cases:18,parallel_max:max,unique_calls:7,deduplicated_steps:true,raw_instruction_excluded:true}));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 try{if(process.argv[2]==='--selftest')await selftest();else if(process.argv[2]==='--request'){const req=JSON.parse(readFileSync('.agent-ops/context-request.json','utf8'));if(process.env.GITHUB_REPOSITORY&&process.env.GITHUB_REPOSITORY!==OWNER+'/'+req.project)throw Error('cross-repository request denied');console.log(JSON.stringify(await executePlan(req,gh)))}else throw Error('unsupported mode')}catch{console.log(JSON.stringify({schema:'agent-composition/v1',coverage:'BLOCKED',error:'Invalid request, unsupported mode or execution failure'}));process.exitCode=2}
}

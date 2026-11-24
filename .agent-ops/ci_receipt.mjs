#!/usr/bin/env node
// Agent validation: conservative GitHub Actions evidence gate. Read-only.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const profiles={
 'cdf-cloud-engine':{path:'.github/workflows/cloudflare-checks.yml',name:'CDF Cloudflare checks',jobs:{'test-and-package':['Run tests and Cloudflare package dry runs','Start Worker runtime and verify synthetic D1 over HTTP','Verify gateway and importer runtimes against local storage']}},
 'CDF-WorkBench-':{path:'.github/workflows/build-plugin.yml',name:'Validate and package CDF Workbench',jobs:{'validate':['Run original WorkBench Python suite','Run original WorkBench Node suites','Check personal-plugin release policy','Verify Python source parses','Verify JavaScript source parses','Verify manifests and package original source'],'official-workbench-mcp':['Verify source manifest, OAuth, MCP policies, and sandbox runner contract','Validate Worker bundle without deployment','Build the isolated runner image for source regression tests','Run original regression suites in the isolated runner image']}},
 'opencode-harness-example':{path:'.github/workflows/ci.yml',name:'OpenCode validation',jobs:{'validate':['Unit tests','Test real static preview server','Typecheck','Build both Worker and web client','Validate security and project invariants']}}
};
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const owner='aamvtrampa36-del';
function blocked(reason,details={}){return {schema:'agent-ci-receipt/v1',status:'BLOCKED',acceptance_status:'PARTIAL',reason,...details}}
export function evaluate(input){
 const {repo,pr,main,run,jobs,workflow_base_blob,workflow_head_blob}=input;
 const p=profiles[repo];
 if(!p||!pr||!sha(pr.head?.sha)||!sha(main)||pr.base?.ref!=='main'||pr.head?.repo?.full_name!==owner+'/'+repo||pr.base?.repo?.full_name!==owner+'/'+repo||pr.state!=='open')return blocked('Unknown scope, invalid SHA, non-open PR or foreign repository');
 const identity={repository:owner+'/'+repo,pr:pr.number,head:pr.head.sha,current_main:main,run_id:run?.id,run_attempt:run?.run_attempt,workflow:p.path,workflow_base_blob,workflow_head_blob};
 const out={schema:'agent-ci-receipt/v1',identity,validation_id:createHash('sha256').update(JSON.stringify(identity)).digest('hex'),acceptance_status:'PARTIAL',pending:['Task-specific acceptance and deployment/runtime evidence remain independent.']};
 if(!run)return {...out,status:'BLOCKED',reason:'No matching Actions run'};
 if(run.event!=='pull_request'||run.path!==p.path||run.name!==p.name||run.head_sha!==pr.head.sha||run.repository?.full_name!==identity.repository)return {...out,status:'BLOCKED',reason:'Run does not match repository, workflow, event or exact PR head'};
 const assoc=(run.pull_requests||[]).find(x=>x.number===pr.number&&x.head?.sha===pr.head.sha);
 out.tested_base=assoc?.base?.sha||null;
 if(!sha(out.tested_base))return {...out,status:'BLOCKED',reason:'Missing PR base association'};
 if(run.status!=='completed')return {...out,status:'BLOCKED',reason:'CI still running'};
 if(run.conclusion==='failure')return {...out,status:'FAIL',reason:'CI failed'};
 if(run.conclusion!=='success')return {...out,status:'PARTIAL',reason:'CI conclusion '+run.conclusion};
 if(!Array.isArray(jobs)||!sha(workflow_base_blob)||!sha(workflow_head_blob)||workflow_base_blob!==workflow_head_blob)return {...out,status:'PARTIAL',reason:'Missing jobs or changed/unverified workflow definition; review required'};
 const missing=[];
 for(const [name,steps] of Object.entries(p.jobs)){
   const matches=jobs.filter(x=>x.name===name&&x.run_id===run.id);
   if(matches.length!==1||matches[0].status!=='completed'||matches[0].conclusion!=='success'){missing.push(name);continue}
   for(const step of steps)if(!(matches[0].steps||[]).some(x=>x.name===step&&x.status==='completed'&&x.conclusion==='success'))missing.push(name+'/'+step);
 }
 if(missing.length)return {...out,status:'PARTIAL',reason:'Expected jobs/steps missing or not successful',missing};
 out.jobs=Object.keys(p.jobs);
 out.evidence='https://github.com/'+identity.repository+'/actions/runs/'+run.id;
 if(out.tested_base!==main)return {...out,status:'PARTIAL',historical_ci:'PASS',reason:'Candidate CI passed against an older base; current integration not verified'};
 return {...out,status:'CACHED',historical_ci:'PASS',reason:'Exact head/base association and expected workflow jobs verified; not task acceptance'};
}
function gh(endpoint){return JSON.parse(execFileSync('gh',['api',endpoint],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','ignore']}))}
function collect(repo,number){
 if(!profiles[repo]||!Number.isSafeInteger(number)||number<1)throw Error('Invalid project or PR');
 const root='repos/'+owner+'/'+repo;
 const pr=gh(root+'/pulls/'+number);
 const main=gh(root+'/git/ref/heads/main').object.sha;
 if(!sha(pr.head?.sha)||!sha(main))throw Error('Invalid source refs');
 const list=gh(root+'/actions/runs?head_sha='+pr.head.sha+'&event=pull_request&per_page=50');
 const p=profiles[repo];
 const runs=(list.workflow_runs||[]).filter(r=>r.path===p.path&&r.name===p.name&&r.head_sha===pr.head.sha&&(r.pull_requests||[]).some(x=>x.number===number)).sort((a,b)=>b.id-a.id);
 const run=runs[0];
 if(!run)return {repo,pr,main};
 const j=gh(root+'/actions/runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs?per_page=100');
 if(j.total_count>100)throw Error('Incomplete job pagination');
 const blob=ref=>gh(root+'/contents/'+p.path+'?ref='+ref).sha;
 return {repo,pr,main,run,jobs:j.jobs,workflow_base_blob:blob(main),workflow_head_blob:blob(pr.head.sha)};
}
function selftest(){
 const x='a'.repeat(40), y='b'.repeat(40), z='c'.repeat(40);
 const repo='cdf-cloud-engine',p=profiles[repo],full=owner+'/'+repo;
 const v={repo,main:y,pr:{number:1,state:'open',head:{sha:x,repo:{full_name:full}},base:{ref:'main',repo:{full_name:full}}},run:{id:42,run_attempt:1,event:'pull_request',path:p.path,name:p.name,head_sha:x,repository:{full_name:full},status:'completed',conclusion:'success',pull_requests:[{number:1,head:{sha:x},base:{sha:y}}]},jobs:Object.entries(p.jobs).map(([name,steps])=>({name,run_id:42,status:'completed',conclusion:'success',steps:steps.map(name=>({name,status:'completed',conclusion:'success'}))})),workflow_base_blob:z,workflow_head_blob:z};
 const eq=(actual,expected)=>{if(actual!==expected)throw Error(actual+' != '+expected)};
 eq(evaluate(v).status,'CACHED');eq(evaluate(v).acceptance_status,'PARTIAL');
 eq(evaluate({...v,main:z}).status,'PARTIAL');
 eq(evaluate({...v,run:{...v.run,head_sha:z}}).status,'BLOCKED');
 eq(evaluate({...v,run:{...v.run,conclusion:'failure'}}).status,'FAIL');
 eq(evaluate({...v,jobs:[]}).status,'PARTIAL');
 eq(evaluate({...v,workflow_head_blob:x}).status,'PARTIAL');
 eq(evaluate({...v,run:{...v.run,status:'in_progress'}}).status,'BLOCKED');
 console.log(JSON.stringify({selftest:'PASS',cases:8}));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 try{
 const [mode,repo,pr]=process.argv.slice(2);
 if(mode==='--selftest')selftest();
 else if(mode==='--stdin')console.log(JSON.stringify(evaluate(JSON.parse(readFileSync(0,'utf8')))));
 else if(mode==='--gh')console.log(JSON.stringify(evaluate(collect(repo,Number(pr)))));
 else throw Error('Use --selftest, --stdin (trusted API JSON), or --gh PROJECT PR');
 }catch(e){console.log(JSON.stringify(blocked('Input/API/runner failure; inspect authorized access and arguments')));process.exitCode=2;}
}

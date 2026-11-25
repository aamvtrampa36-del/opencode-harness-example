import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyGitHubReadback,collectGitHubReadback} from './m08-github-collector.mjs';
const repo='aamvtrampa36-del/opencode-harness-example', requestId='0123456789abcdef';
const e={repo,requestId,sessionId:'ses_fixture',operationId:'fixture-operation',projectId:'supervised-'+requestId,
 sourceSha:'a'.repeat(40),base:'fixture-base',baseSha:'b'.repeat(40),branch:'opencode/staging-'+requestId,
 headSha:'c'.repeat(40),headTree:'d'.repeat(40),pr:1,files:[{path:'src/client.tsx',sha:'e'.repeat(40),status:'modified'}]};
function fixture(mutate=()=>{}){
 const seen=[];
 const pr={number:1,state:'open',draft:true,merged:false,changed_files:1,
 head:{repo:{full_name:repo},ref:e.branch,sha:e.headSha},base:{repo:{full_name:repo},ref:e.base,sha:e.baseSha}};
 const values=[
 {ref:'refs/heads/'+e.branch,object:{type:'commit',sha:e.headSha}},
 {ref:'refs/heads/'+e.base,object:{type:'commit',sha:e.baseSha}},
 {sha:e.headSha,tree:{sha:e.headTree}},pr,
 {status:'ahead',behind_by:0,ahead_by:1,merge_base_commit:{sha:e.baseSha},files:[{filename:'src/client.tsx',sha:'e'.repeat(40),status:'modified'}]},
 structuredClone(pr),{ref:'refs/heads/'+e.base,object:{type:'commit',sha:e.baseSha}},
 {ref:'refs/heads/'+e.branch,object:{type:'commit',sha:e.headSha}}];
 mutate(values);
 return {seen,read:async path=>{seen.push(path);return values[seen.length-1];}};
}
test('exact draft and scoped diff readback; never live pass',async()=>{
 const f=fixture();const x=await verifyGitHubReadback(e,f.read);
 assert.equal(x.verified,true);assert.equal(x.livePass,false);assert.equal(f.seen.length,8);
 assert.equal(f.seen[0],f.seen[7]);assert.equal(f.seen[1],f.seen[6]);
 assert.match(x.intentSha256,/^[a-f0-9]{64}$/);
});
for(const [name,mutate,code] of [
 ['wrong ref',v=>v[0].object.sha='f'.repeat(40),'HEAD_MISMATCH'],
 ['wrong tree',v=>v[2].tree.sha='f'.repeat(40),'TREE_MISMATCH'],
 ['foreign PR',v=>v[3].head.repo.full_name='other/repo','PR_MISMATCH'],
 ['not draft',v=>v[3].draft=false,'PR_MISMATCH'],
 ['extra file',v=>v[4].files.push({filename:'private.txt',sha:'f'.repeat(40),status:'added'}),'COMPARE_SCOPE'],
 ['wrong blob',v=>v[4].files[0].sha='f'.repeat(40),'DIFF_MISMATCH'],
 ['moving branch',v=>v[7].object.sha='f'.repeat(40),'READBACK_CHANGED'],
 ['moving base',v=>v[6].object.sha='f'.repeat(40),'READBACK_CHANGED']
])test(name,async()=>await assert.rejects(verifyGitHubReadback(e,fixture(mutate).read),new RegExp(code)));
test('bad intent denied before transport',async()=>{
 for(const bad of [{...e,repo:'other/repo'},{...e,projectId:'foreign'},{...e,files:[{path:'../secret',sha:'e'.repeat(40),status:'modified'}]},{...e,files:[...e.files,...e.files]}]){
 const f=fixture();await assert.rejects(verifyGitHubReadback(bad,f.read));assert.equal(f.seen.length,0);}
});
test('no credential no dispatch',async()=>await assert.rejects(collectGitHubReadback({expected:e,token:''}),/AUTH_REQUIRED/));

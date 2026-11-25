const {test}=require('node:test');
const assert=require('node:assert/strict');
const {after}=require('node:test');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const build=fs.mkdtempSync(path.join(os.tmpdir(),'p16-source-'));
after(()=>fs.rmSync(build,{recursive:true,force:true}));
try {
  // Isolate from the repository tsconfig and package type; no install or network.
  for(const name of ['metralla-m05-source.ts','pilot-http.ts'])
    fs.copyFileSync(path.join(root,'src',name),path.join(build,name));
  const tsc=process.env.TSC_BIN || 'tsc';
  execFileSync(tsc.includes(path.sep)?path.resolve(root,tsc):tsc,[
    '--target','ES2022','--module','commonjs','--lib','ES2022,DOM','--strict',
    '--outDir',path.join(build,'out'),'metralla-m05-source.ts','pilot-http.ts'
  ],{cwd:build,stdio:'pipe'});
} catch(error) {
  fs.rmSync(build,{recursive:true,force:true});
  throw error;
}
const {freezeGitHubSourcePin,sameGitHubSourcePin,assertPinnedGitHubAction,assertGitHubSourceIdentity,githubRestNoRedirect,githubArchiveResponse}=require(path.join(build,'out','metralla-m05-source.js'));
const repo='aamvtrampa36-del/opencode-harness-example', commit='a'.repeat(40),tree='b'.repeat(40), branch='opencode/staging-0123456789abcdef';
const pin={repo,base:'staging/source',branch,commit,tree,paths:['src/client.ts']};
const headers={Authorization:'Bearer fake-test-token'}, signal=new AbortController().signal;
const archive=(format='tarball',sha=commit)=>`https://codeload.github.com/${repo}/${format==='tarball'?'legacy.tar.gz':'legacy.zip'}/${sha}?token=temporary`;
test('REST GET and POST reject all 3xx without second request or credential forwarding',async()=>{for(const method of ['GET','POST'])for(const status of [300,301,302,303,304,307,308,399]){let calls=0;await assert.rejects(githubRestNoRedirect(async(url,init)=>{calls++;assert.equal(init.redirect,'manual');assert.equal(init.method,method);assert.equal(init.headers.Authorization,headers.Authorization);return new Response(null,{status,headers:{Location:'https://foreign.invalid/fake-test-token'}})},'https://api.github.com/test',{method,headers}),/redirect refused/);assert.equal(calls,1)}});
test('network error on mutation is unknown and not retried; read is failed and sanitized',async()=>{let calls=0;const http=async()=>{calls++;throw Error('fake-test-token')};await assert.rejects(githubRestNoRedirect(http,'https://api.github.com/test',{method:'POST'}),/^Error: GITHUB_TRANSPORT_EFFECT_UNKNOWN$/);await assert.rejects(githubRestNoRedirect(http,'https://api.github.com/test'),/^Error: GITHUB_TRANSPORT_FAILED$/);assert.equal(calls,2)});
test('302 archive handoff is one-time and same repo/commit, never sends bearer',async()=>{for(const format of ['tarball','zipball']){const calls=[];const http=async(url,init)=>{calls.push({url,init});if(calls.length===1)return new Response(null,{status:302,headers:{Location:archive(format)}});return new Response('bytes')};const r=await githubArchiveResponse(http,repo,format,headers,signal,commit);assert.equal(await r.text(),'bytes');assert.equal(calls.length,2);assert.equal(calls[0].url,`https://api.github.com/repos/${repo}/${format}/${commit}`);assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[1].init.redirect,'manual');assert.equal(new Headers(calls[1].init.headers).has('Authorization'),false)}});
test('foreign host/repo/commit, URL credentials, hash, bad type, redirects other than 302 refused',async()=>{for(const [status,url] of [[302,'https://evil.invalid/path'],[302,archive().replace(repo,'aamvtrampa36-del/other')],[302,archive('tarball','c'.repeat(40))],[302,archive().replace('https://','https://user:pw@')],[302,archive()+'#secret'],[302,archive('zipball')],[307,archive()],[301,archive()]]){let calls=0;await assert.rejects(githubArchiveResponse(async()=>{calls++;return new Response(null,{status,headers:{Location:url}})},repo,'tarball',headers,signal,commit),/no autorizada/);assert.equal(calls,1)}});
test('second archive redirect blocked and import failure is not success',async()=>{let calls=0;await assert.rejects(githubArchiveResponse(async()=>{calls++;return new Response(null,{status:302,headers:{Location:archive()}})},repo,'tarball',headers,signal,commit),/archivo temporal/);assert.equal(calls,2);const r=await githubArchiveResponse(async()=>new Response(null,{status:503}),repo,'tarball',headers,signal,commit);assert.equal(r.ok,false)});
test('pinned identity and action scope reject foreign repo/ref/branch/path before effect',()=>{const p=freezeGitHubSourcePin(pin);assert(Object.isFrozen(p.paths));assert(sameGitHubSourcePin(p,pin));assert.doesNotThrow(()=>assertGitHubSourceIdentity(p,{repo,baseCommit:commit,commit,tree}));for(const field of ['repo','baseCommit','commit','tree'])assert.throws(()=>assertGitHubSourceIdentity(p,{repo,baseCommit:commit,commit,tree,[field]:'foreign'}),/DIVERGENT/);assert.doesNotThrow(()=>assertPinnedGitHubAction(p,{repo,operation:'write',branch,path:'src/client.ts'}));for(const action of [{repo:'aamvtrampa36-del/other',operation:'branch',branch},{repo,operation:'write',branch:'main',path:'src/client.ts'},{repo,operation:'write',branch,path:'src/other.ts'},{repo,operation:'write',branch,path:'../src/client.ts'},{repo,operation:'read',ref:'main',path:'src/client.ts'},{repo,operation:'merge',branch}])assert.throws(()=>assertPinnedGitHubAction(p,action),/GITHUB_SOURCE_SCOPE/);assert.throws(()=>freezeGitHubSourcePin({...pin,paths:['src/.git/config']}),/PIN_INVALID/)});
test('pin is a defensive copy and scope cannot be widened',()=>{const original={...pin,paths:[...pin.paths]};const p=freezeGitHubSourcePin(original);original.paths.push('src/other.ts');assert.equal(sameGitHubSourcePin(p,original),false);assert.throws(()=>assertPinnedGitHubAction(p,{repo,operation:'write',branch,path:'src/other.ts'}),/SCOPE_PATH/)});

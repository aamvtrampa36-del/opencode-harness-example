#!/usr/bin/env node
// R3-T06: synthetic LOCAL Linux proof/negative suite. Does not contact Cloudflare.
// Only children created by these fixtures are signalled, and every PID is identity-checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile, writeFile, mkdtemp, mkdir, rm, readdir, symlink, link} from 'node:fs/promises';
import {readFileSync, statfsSync, accessSync, constants as fsConstants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {captureBoundedOutput} from '../../src/bounded-process-output.ts';
import {taskArtifactReaderSource} from '../../src/task-artifact-source.ts';

const helper=fileURLToPath(new URL('./t06-r3-tree-child.cjs',import.meta.url));
const dev=await readFile(new URL('../../src/dev-container.ts',import.meta.url),'utf8');
const tick=String.fromCharCode(96);
const runner=dev.match(new RegExp('const LINUX_RUNNER_SOURCE = String\\.raw'+tick+'([\\s\\S]*?)'+tick+';'))?.[1];
assert.ok(runner,'LINUX_RUNNER_SOURCE required: run against current candidate');
const report={scope:'local Node/Linux (NOT Cloudflare, NOT remote)',version:process.version,fixture:helper,cases:[],limits:[],metrics:{}};
const root=await mkdtemp(join(tmpdir(),'f0-c10-r3-t06-'));
const tracked=new Map();const aliveRoots=new Set();
let rssInitial=process.memoryUsage().rss,rssPeak=rssInitial,heapPeak=process.memoryUsage().heapUsed;
const tickStart=performance.now(),sample=setInterval(()=>{const m=process.memoryUsage();rssPeak=Math.max(rssPeak,m.rss);heapPeak=Math.max(heapPeak,m.heapUsed)},15);
function procInfo(pid){if(!Number.isSafeInteger(pid)||pid<2)return null;try{const s=readFileSync(`/proc/${pid}/stat`,'utf8');const f=s.slice(s.lastIndexOf(') ')+2).trim().split(' ');return{state:f[0],start:f[19],pgid:Number(f[2])}}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function isRunning(pid){const v=procInfo(pid);return Boolean(v && v.state!=='Z'&&v.state!=='X');}
function track(pid){const r=procInfo(pid);if(r)tracked.set(pid,r.start);return r;}
function terminateOwned(pid,start){const info=procInfo(pid);if(info&&info.start===start){try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}}
async function pidsInFixtureDirs(){// File names are fixed by our own helper; no scanning /proc or system processes.
  for(const dir of [root,...await Promise.all((await readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>join(root,e.name)))]){
    for(const f of ['root.json','middle.json','leaf.json','escaped.json','double.json','timeout-leaf.json','ready.json']){
      try{const v=JSON.parse(await readFile(join(dir,f),'utf8'));if(Number.isSafeInteger(v.pid))track(v.pid)}catch(e){if(e.code!=='ENOENT'&&e.code!=='SyntaxError'){} }
    }
  }
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function awaitMarker(dir,name,limit=6000){const end=performance.now()+limit;while(performance.now()<end){try{const v=JSON.parse(await readFile(join(dir,name),'utf8'));track(v.pid);return v;}catch(e){if(e.code!=='ENOENT')throw e;}await delay(20)}throw Error('Missing marker '+name+' in '+dir)}
async function make(name){const dir=join(root,name);await mkdir(dir,{recursive:true});return dir;}
const close=child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}))});
async function exec(cwd,mode,args=[],opt={}){
 const src=opt.short?runner.replace('"180s"','"1s"').replace('"--kill-after=5s"','"--kill-after=1s"'):runner;
 const words=[helper,mode,...args.map(String)].map(s=>JSON.stringify(s)).join(' ');
 const child=spawn('bash',['-lc','cd "$3" && exec node -e "$2" "$1"','opencode','node '+words,src,cwd],{stdio:['ignore','pipe','pipe']});
 aliveRoots.add(child);child.once('close',()=>aliveRoots.delete(child));track(child.pid);
 const result=Promise.all([captureBoundedOutput(Readable.toWeb(child.stdout),32000),captureBoundedOutput(Readable.toWeb(child.stderr),32000),close(child)]);
 let timer;const [stdout,stderr,status]=await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('command timeout '+mode)),opt.deadline??18000)})]).finally(()=>clearTimeout(timer));
 return{...status,stdout,stderr};
}
function caseReport(name,details){report.cases.push({name,pass:true,...details})}
let fixturePass=false;
try{
 await test('normal three-generation process group kills TERM-ignoring orphan',async()=>{
   const cwd=await make('grandchildren');const r=await exec(cwd,'tree');const v=await awaitMarker(cwd,'leaf.json');
   assert.equal(r.exitCode,31);assert.equal(isRunning(v.pid),false);
   caseReport('tree-grandchild-same-PGID',{exit:r.exitCode,descendantState:procInfo(v.pid)?.state??'gone'});
 });
 await test('setsid inheriting output: RED, fail closed but escape remains',async()=>{
   const cwd=await make('escape-pipes');const r=await exec(cwd,'setsid-pipes',[],{deadline:9500});const v=await awaitMarker(cwd,'escaped.json');
   assert.equal(r.exitCode,125);assert.equal(isRunning(v.pid),true);
   assert.match(r.stderr.text,/open pipes/);
   caseReport('setsid-inherited-pipes-RED',{exit:r.exitCode,descendantActive:true});
 });
 await test('double-fork setsid with stdio redirected: RED zero exit despite live descendant',async()=>{
   const cwd=await make('double-fork');const r=await exec(cwd,'double-fork');const v=await awaitMarker(cwd,'double.json');
   assert.equal(r.exitCode,0);assert.equal(isRunning(v.pid),true);
   caseReport('double-fork-setsid-silent-RED',{exit:r.exitCode,descendantActive:true});
 });
 await test('timeout 1s: TERM/KILL escalation with code preserved',async()=>{
   const cwd=await make('timed');const r=await exec(cwd,'kill-timeout',[],{short:true,deadline:8000});const v=await awaitMarker(cwd,'timeout-leaf.json');
   assert.ok([124,137,143].includes(r.exitCode),String(r.exitCode));assert.equal(isRunning(v.pid),false);
   caseReport('timeout-kill',{exit:r.exitCode,descendantActive:false});
 });
 await test('binary/nonzero stdout+stderr preserve byte count not byte-exact text',async()=>{
   const cwd=await make('binary');const r=await exec(cwd,'binary');
   assert.equal(r.exitCode,23);assert.equal(r.stdout.totalBytes,5);assert.equal(r.stderr.totalBytes,5);
   assert.equal(r.stdout.truncated,false);assert.match(r.stdout.text,/\uFFFD/);
   caseReport('binary-stderr',{exit:r.exitCode,stdoutBytes:5,stderrBytes:5});
 });
 await test('simultaneous 16MiB stdout and stderr are drained and bounded',async()=>{
   const cwd=await make('massive');const r=await exec(cwd,'massive',[],{deadline:30000});assert.equal(r.exitCode,19);
   for(const c of [r.stdout,r.stderr]){assert.equal(c.totalBytes,16777216);assert.equal(c.omittedBytes,16777216-32000);assert.equal(c.truncated,true)}
   caseReport('massive-bounded',{exit:r.exitCode,stdoutBytes:r.stdout.totalBytes,stderrBytes:r.stderr.totalBytes,retainedPerChannel:32000});
 });
 for(const count of [1,2,4,10]) await test('local '+count+' project processes concurrently with barrier',async()=>{
   const release=join(root,'release-'+count);const dirs=await Promise.all(Array.from({length:count},(_,i)=>make('barrier-'+count+'-'+i)));
   // Start all before releasing the barrier: synthetically proves processes, not agents, overlap.
   const pending=dirs.map((cwd,i)=>exec(cwd,'barrier',[i,release],{deadline:20000}));
   await Promise.all(dirs.map(cwd=>awaitMarker(cwd,'ready.json')));
   const first=performance.now();await writeFile(release,'go');const rs=await Promise.all(pending);
   for(let i=0;i<count;i++){
      assert.equal(rs[i].exitCode,i);
      assert.equal(rs[i].stdout.text,'out-'+i);assert.equal(rs[i].stderr.text,'err-'+i);
      assert.deepEqual(JSON.parse(await readFile(join(dirs[i],'marker.json'),'utf8')),{number:i,cwd:dirs[i]});
      assert.deepEqual((await readdir(dirs[i])).sort(),['marker.json','ready.json']);
   }
   caseReport('local-barrier-'+count,{count,exitCodes:rs.map(r=>r.exitCode),releaseToCompleteMs:Math.round(performance.now()-first)});
 });
 await test('artifact reader O_NOFOLLOW and owned paths (synthetic same FS)',async()=>{
    const base=await make('artifacts');const one='supervised-0000000000000001',two='supervised-0000000000000002';
    const d1=join(base,one,'dist'),d2=join(base,two,'dist');await mkdir(d1,{recursive:true});await mkdir(d2,{recursive:true});
    await writeFile(join(d1,'ok.txt'),'project-1');await writeFile(join(d2,'private.txt'),'project-2');
    await symlink(join(d2,'private.txt'),join(d1,'badlink.txt'));
    await symlink(d2,join(d1,'bad-directory'));
    await link(join(d2,'private.txt'),join(d1,'hardlink.txt'));
    const source=taskArtifactReaderSource(base);
    const probe=async requested=>{
      const ch=spawn(process.execPath,['-e',source,one,requested],{stdio:['ignore','pipe','pipe']});
      const [stdout,stderr,status]=await Promise.all([captureBoundedOutput(Readable.toWeb(ch.stdout),100000),captureBoundedOutput(Readable.toWeb(ch.stderr),10000),close(ch)]);
      return{...status,stdout,stderr};
    };
    const ok=await probe('dist/ok.txt');assert.equal(ok.exitCode,0);assert.equal(Buffer.from(JSON.parse(ok.stdout.text).base64,'base64').toString(),'project-1');
    for(const name of ['dist/badlink.txt','dist/bad-directory/private.txt','dist/../private.txt','../'+two+'/dist/private.txt','/bundle/private.txt']){
      const r=await probe(name);assert.notEqual(r.exitCode,0);assert.equal(r.stdout.text,'');
    }
    // T06 originally detected a hardlink RED; R3-T09 now denies
    // multi-link inodes. This is an expected GREEN regression of the
    // integrated source, NOT proof of Cloudflare Container isolation.
    const hard=await probe('dist/hardlink.txt');
    assert.notEqual(hard.exitCode,0);
    assert.equal(hard.stdout.text,'');
    caseReport('artifact-paths-and-hardlink-R3-GREEN',{
      O_NOFOLLOW_symlinkDenied:true,intermediateSymlinkDenied:true,
      hardlinkSameFilesystemLeak:false,cloudflareFilesystemOverlap:'not tested'});
 });
 // Read-only mount/cgroup capability inventory; no writes or isolation claims.
 await test('read-only local cgroup capability report (not Cloudflare)',()=>{
    const cgroup=readFileSync('/proc/self/cgroup','utf8').trim();
    const mount=readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(s=>s.includes(' - cgroup'));
    let writable=false;try{accessSync('/sys/fs/cgroup',fsConstants.W_OK);writable=true}catch{}
    report.cgroup={self:cgroup,mounts:mount.map(s=>s.split(' - ').slice(1).join(' - ')),writable,scope:'this local test only; no Cloudflare evidence'};
    assert.ok(cgroup.length>0);caseReport('local-cgroup-read-only',{writable});
 });
 fixturePass=true;
}finally{
 clearInterval(sample);
 await pidsInFixtureDirs();
 for(const [pid,start] of tracked)terminateOwned(pid,start);
 // Own direct spawned roots only. We never query or terminate unrelated system process names.
 for(const c of aliveRoots){const i=procInfo(c.pid);if(i)terminateOwned(c.pid,i.start)}
 await rm(root,{recursive:true,force:true});
 report.metrics={rssInitialBytes:rssInitial,rssPeakSampledBytes:rssPeak,heapPeakSampledBytes:heapPeak,elapsedMs:Math.round(performance.now()-tickStart)};
 report.status=fixturePass?'PASS_WITH_EXPLICIT_RED_LIMITS':'FAIL';
 report.limits.push('setsid/double-fork descendants intentionally survive root; cleanup done only by fixture','hardlink escape on same local filesystem; real project Container isolation unverified','local cgroup introspection cannot certify Cloudflare cgroup delegation','no Cloudflare Container or Remote execution');
 console.log(JSON.stringify(report,null,2));
}

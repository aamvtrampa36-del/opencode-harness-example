#!/usr/bin/env node
// R2-T06 offline only: Linux synthetic processes owned by this test; never Staging.
// node --experimental-strip-types scripts/f0-c10/t06-r2-process-fixtures.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { captureBoundedOutput } from '../../src/bounded-process-output.ts';

const CAP = 32_000;
const source = await readFile(new URL('../../src/dev-container.ts', import.meta.url), 'utf8');
const match = source.match(new RegExp('const LINUX_RUNNER_SOURCE = String\\.raw' + String.fromCharCode(96) + '([\\s\\S]*?)' + String.fromCharCode(96) + ';'));
assert.ok(match, 'Production Linux runner source must remain inspectable in dev-container.ts');
const runner = match[1];
const tmp = await mkdtemp(join(tmpdir(), 'f0-c10-r2-t06-'));
const tracked = new Set();
const runningRoots = new Set();
let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed;
const initialRss = peakRss;
const start = performance.now();
const sampler = setInterval(() => {
  const mem = process.memoryUsage(); peakRss=Math.max(mem.rss,peakRss);
  peakHeap=Math.max(mem.heapUsed,peakHeap);
}, 10);
const tests=[];
async function makeDir(name){const dir=join(tmp,name);await mkdir(dir);return dir;}
async function withTimeout(promise,ms,label){
  let timer; try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('TIMEOUT '+label)),ms);
  })]);}finally{clearTimeout(timer);}
}
async function run(command,cwd,opts={}) {
  const code=opts.short ? runner.replace('"180s"','"1s"').replace('"--kill-after=5s"','"--kill-after=1s"') : runner;
  // Same positional-argument transport as DevContainer.run(); no command interpolation.
  const wrapper='mkdir -p -- "$3" && cd -- "$3" && exec node -e "$2" "$1"';
  const child=spawn('bash',['-lc',wrapper,'opencode',command,code,cwd],{stdio:['ignore','pipe','pipe']});
  runningRoots.add(child);
  child.once('close',()=>runningRoots.delete(child));
  const finished=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));
  });
  const [stdout,stderr,status] = await withTimeout(Promise.all([
    captureBoundedOutput(Readable.toWeb(child.stdout),CAP),
    captureBoundedOutput(Readable.toWeb(child.stderr),CAP), finished
  ]),opts.timeoutMs??30000,'run command');
  return {...status,stdout,stderr};
}
function activeState(pid) {
  if(!Number.isInteger(pid)||pid<2)return 'invalid';
  try {const line=readFileSync('/proc/'+pid+'/stat','utf8');
    const ix=line.lastIndexOf(') ');
    return line.slice(ix+2).split(' ')[0];
  }catch(e){if(e.code==='ENOENT')return 'gone';throw e;}
}
async function waitForPid(path){
  const deadline=performance.now()+2500;
  while(performance.now()<deadline){
    try {const id=Number((await readFile(path,'utf8')).trim());
      if(Number.isSafeInteger(id)&&id>=2){tracked.add(id);return id;}
    }catch(e){if(e.code!=='ENOENT')throw e;}
    await new Promise(r=>setTimeout(r,20));
  }
  throw Error('PID marker missing');
}
function ensureNoActive(pid) {
  const state=activeState(pid);
  assert.ok(['gone','Z','X'].includes(state),'descendant remains active state='+state+' pid='+pid);
  return state;
}
try {
  const dir=await makeDir('text');
  let r=await run("printf 'OK\\n'; printf 'ERR\\n' >&2; exit 7",dir);
  assert.equal(r.exitCode,7);assert.equal(r.stdout.text,'OK\n');assert.equal(r.stderr.text,'ERR\n');
  tests.push({name:'nonzero-and-pipes',pass:true,exitCode:r.exitCode});

  const bin=await makeDir('binary');
  r=await run("node -e 'const a=Buffer.from([0,255,254,10,13]);process.stdout.write(a);process.stderr.write(a);process.exitCode=23'",bin);
  assert.equal(r.exitCode,23);assert.equal(r.stdout.totalBytes,5);assert.equal(r.stderr.totalBytes,5);
  assert.ok(r.stdout.text.includes('\uFFFD'));assert.equal(r.stdout.truncated,false);
  tests.push({name:'binary-lossy-text-but-byte-count-exact',pass:true,exitCode:r.exitCode});

  const large=await makeDir('large');
  r=await run("node -e 'const b=Buffer.alloc(8192,65);for(let i=0;i<2048;i++){process.stdout.write(b);process.stderr.write(b)}process.exitCode=19'",large,{timeoutMs:30000});
  assert.equal(r.exitCode,19);
  assert.equal(r.stdout.totalBytes,16*1024*1024);
  assert.equal(r.stderr.totalBytes,16*1024*1024);
  assert.equal(r.stdout.omittedBytes,16*1024*1024-CAP);
  assert.equal(r.stderr.omittedBytes,16*1024*1024-CAP);
  assert.ok(r.stdout.truncated&&r.stderr.truncated);
  tests.push({name:'bounded-16mib-each-channel',pass:true,exitCode:r.exitCode,bytesPerChannel:r.stdout.totalBytes,retainedPerChannel:CAP});

  const dirs=await Promise.all(Array.from({length:10},(_,i)=>makeDir('project-'+i)));
  const tasks=await Promise.all(dirs.map((cwd,i)=>run("printf '%s' 'task-"+i+"' > marker.txt; printf '%s' 'out-"+i+"'; printf '%s' 'err-"+i+"' >&2; exit "+i,cwd)));
  for(let i=0;i<10;i++){
    assert.equal(tasks[i].exitCode,i);
    assert.equal(tasks[i].stdout.text,'out-'+i);
    assert.equal(tasks[i].stderr.text,'err-'+i);
    assert.equal(await readFile(join(dirs[i],'marker.txt'),'utf8'),'task-'+i);
  }
  tests.push({name:'ten-local-projects-no-marker-or-stream-crossing',pass:true,exitCodes:tasks.map(x=>x.exitCode)});

  const tree=await makeDir('tree');
  // Child ignores TERM. It retains the command's PGID, so scoped KILL must clean it.
  const treeCmd="node -e 'const cp=require(\"node:child_process\"),fs=require(\"node:fs\");const c=cp.spawn(process.execPath,[\"-e\",\"process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)\"],{stdio:\"inherit\"});fs.writeFileSync(\"child.pid\",String(c.pid));setTimeout(()=>process.exit(31),180)'";
  r=await run(treeCmd,tree,{timeoutMs:8000});
  const treePid=await waitForPid(join(tree,'child.pid'));
  assert.equal(r.exitCode,31);const state=ensureNoActive(treePid);
  tests.push({name:'same-pgid-descendant-TERM-ignore-cleaned',pass:true,exitCode:r.exitCode,after:state});

  const halt=await makeDir('timeout');
  r=await run("node -e 'process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'",halt,{short:true,timeoutMs:8500});
  assert.ok([124,137,143].includes(r.exitCode),'timeout exit was '+r.exitCode);
  tests.push({name:'timeout-escalation',pass:true,exitCode:r.exitCode});

  const cancelled = await makeDir('cancel');
  const cancelScript = runner.replace('5_000','800');
  const control = spawn('bash', ['-lc', 'mkdir -p -- "$3" && cd -- "$3" && exec node -e "$2" "$1"',
    'opencode', 'node -e \'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)\'', cancelScript, cancelled],
    {stdio:['ignore','pipe','pipe']});
  runningRoots.add(control); control.once('close',()=>runningRoots.delete(control));
  const cancelResult = new Promise((resolve,reject)=>{
    control.once('error',reject);control.once('close',(exitCode,signal)=>resolve({exitCode,signal}));
  });
  // The own runner will propagate TERM to only its command group and escalate.
  await new Promise(resolve=>setTimeout(resolve,900));
  control.kill('SIGTERM');
  const cancelledResult = await withTimeout(cancelResult,7000,'cancellation');
  assert.equal(cancelledResult.exitCode,143);
  tests.push({name:'explicit-runner-SIGTERM-cancellation',pass:true,exitCode:143});

  const escaped=await makeDir('escaped-with-pipes');
  // Explicit expected-negative: setsid escapes a process group but retains pipes.
  r=await run("setsid bash -c 'echo $$ > escaped.pid; exec sleep 30' & until [ -s escaped.pid ]; do sleep 0.02; done; exit 17",escaped,{timeoutMs:7000});
  const escapePid=await waitForPid(join(escaped,'escaped.pid'));
  assert.equal(r.exitCode,125);
  assert.ok(r.stderr.text.includes('open pipes after group cleanup'));
  const still=activeState(escapePid);
  assert.ok(!['gone','Z','X'].includes(still),'negative test expected detached child to survive');
  tests.push({name:'detached-inherited-pipes-reported-fail-closed',pass:true,exitCode:r.exitCode,remainingProcessState:still,policy:'KNOWN_GAP'});

  const silent=await makeDir('escaped-redirected');
  // Explicit expected-negative: detached process redirects stdio; no detectable held pipe.
  r=await run("setsid bash -c 'echo $$ > silent.pid; exec sleep 30' >/dev/null 2>&1 </dev/null & until [ -s silent.pid ]; do sleep 0.02; done; exit 0",silent,{timeoutMs:7000});
  const silentPid=await waitForPid(join(silent,'silent.pid'));
  const silentState=activeState(silentPid);
  assert.equal(r.exitCode,0);
  assert.ok(!['gone','Z','X'].includes(silentState));
  tests.push({name:'detached-redirected-invisible-orphan',pass:true,exitCode:r.exitCode,remainingProcessState:silentState,policy:'KNOWN_GAP'});
}finally{
  clearInterval(sampler);
  // Recover IDs even when an assertion failed before waitForPid tracked them.
  for (const parent of ['tree','escaped-with-pipes','escaped-redirected']) {
    for (const filename of ['child.pid','escaped.pid','silent.pid']) {
      try {const pid=Number((await readFile(join(tmp,parent,filename),'utf8')).trim());
        if (Number.isSafeInteger(pid)&&pid>=2) tracked.add(pid);
      }catch(e){if(e.code!=='ENOENT')throw e;}
    }
  }
  for (const child of runningRoots) {try{child.kill('SIGTERM')}catch{}}
  for(const pid of tracked){try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}
  await rm(tmp,{recursive:true,force:true});
}
console.log(JSON.stringify({status:'PASS_WITH_KNOWN_GAPS',environment:'offline Linux Node; not Cloudflare',tests,
  memory:{rssInitialBytes:initialRss,rssPeakSampledBytes:peakRss,heapPeakSampledBytes:peakHeap,
    elapsedMs:Math.round(performance.now()-start)},liveStagingTests:0},null,2));

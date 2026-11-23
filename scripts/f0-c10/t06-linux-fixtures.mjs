#!/usr/bin/env node
// F0-C10/T06: offline Linux fixtures. Never contact the Staging runtime.
// Run with Node 22+: node --experimental-strip-types scripts/f0-c10/t06-linux-fixtures.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { captureBoundedOutput } from "../../src/bounded-process-output.ts";

const CAP = 32_000;
const worker = [
  "const fs=require('node:fs');",
  "const {once}=require('node:events');",
  "const [out,err,code,marker]=process.argv.slice(1);",
  "async function emit(stream,n,c){const buf=Buffer.alloc(8192,c);",
  "for(let sent=0;sent<Number(n);){const v=buf.subarray(0,Math.min(8192,n-sent));",
  "sent+=v.length;if(!stream.write(v))await once(stream,'drain');}}",
  "(async()=>{if(marker!=='-')fs.writeFileSync('marker.json',JSON.stringify({marker,cwd:process.cwd()}));",
  "await Promise.all([emit(process.stdout,out,79),emit(process.stderr,err,69)]);",
  "process.exitCode=Number(code)})().catch(e=>{console.error(e);process.exitCode=125})"
].join("\n");
const close = child => new Promise((resolve,reject)=>{
  child.once("error",reject);
  child.once("close",(code,signal)=>resolve({code,signal}));
});
async function execute(out,err,code,cwd,marker="-"){
  const child=spawn(process.execPath,["-e",worker,String(out),String(err),String(code),marker],
    {cwd,stdio:["ignore","pipe","pipe"]});
  const [stdout,stderr,status]=await Promise.all([
    captureBoundedOutput(Readable.toWeb(child.stdout),CAP),
    captureBoundedOutput(Readable.toWeb(child.stderr),CAP),
    close(child)
  ]);
  return {stdout,stderr,...status};
}
const begin=performance.now();
const startRss=process.memoryUsage().rss;
let peakRss=startRss,peakHeap=process.memoryUsage().heapUsed,peakExternal=process.memoryUsage().external;
const sample=setInterval(()=>{
  const m=process.memoryUsage();
  peakRss=Math.max(peakRss,m.rss);
  peakHeap=Math.max(peakHeap,m.heapUsed);
  peakExternal=Math.max(peakExternal,m.external);
},5);
const results={};
try{
  for(const c of [
    {name:"empty",out:0,err:0,code:0},
    {name:"nonzero",out:1024,err:512,code:7},
    {name:"boundary",out:CAP,err:CAP,code:0},
    {name:"large",out:16*1024*1024,err:16*1024*1024,code:23}
  ]){
    const r=await execute(c.out,c.err,c.code);
    assert.equal(r.code,c.code);
    assert.equal(r.stdout.totalBytes,c.out);
    assert.equal(r.stderr.totalBytes,c.err);
    for(const [v,n] of [[r.stdout,c.out],[r.stderr,c.err]]){
      assert.equal(v.truncated,n>CAP);
      assert.equal(v.omittedBytes,Math.max(0,n-CAP));
      assert.ok(Buffer.byteLength(v.text)<=CAP+100);
    }
    results[c.name]={stdoutBytes:c.out,stderrBytes:c.err,exitCode:r.code,truncated:r.stdout.truncated};
  }
  const root=await mkdtemp(join(tmpdir(),"f0-c10-t06-"));
  try{
    const dirs=Array.from({length:10},(_,i)=>join(root,"project-"+i));
    await Promise.all(dirs.map(d=>mkdir(d)));
    const jobs=await Promise.all(dirs.map((dir,i)=>execute(64000+i,48000+i,i,dir,"task-"+i)));
    for(let i=0;i<10;i++){
      assert.equal(jobs[i].code,i);
      assert.equal(jobs[i].stdout.totalBytes,64000+i);
      assert.equal(jobs[i].stderr.totalBytes,48000+i);
      assert.deepEqual(await readdir(dirs[i]),["marker.json"]);
      assert.deepEqual(JSON.parse(await readFile(join(dirs[i],"marker.json"),"utf8")),
        {marker:"task-"+i,cwd:dirs[i]});
    }
    results.tenSynthetic={count:10,pass:true,exitCodes:jobs.map(j=>j.code)};
  }finally{await rm(root,{recursive:true,force:true});}
  const child=spawn("timeout",
    ["--signal=TERM","--kill-after=1s","1s",process.execPath,"-e",
     'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    {stdio:"ignore"});
  const timeoutStart=performance.now();
  const killed=await close(child);
  assert.ok([124,137].includes(killed.code) ||
    (killed.code===null && killed.signal==="SIGKILL"),JSON.stringify(killed));
  assert.ok(performance.now()-timeoutStart<6500);
  results.escalation={...killed,durationMs:Math.round(performance.now()-timeoutStart)};
}finally{clearInterval(sample);}
results.memory={
  startRss,peakRss,peakHeap,peakExternal,
  elapsedMs:Math.round(performance.now()-begin)
};
console.log(JSON.stringify({status:"PASS",scope:"offline Node/Linux (not Cloudflare)",results},null,2));

/**
 * Synthetic, non-network 1/2/4/10 baseline with the SAME opt-in phase tracer
 * as the source candidate. Node heap/RSS are NOT workerd isolate or Container.
 * RED deliberately exits 1 when unbounded retention occurs.
 * Usage: node --experimental-strip-types --expose-gc scripts/f0-c10/r3-memory-baseline.mjs --count 10 --mode green
 */
import { createSupervisorMemoryProbe, MAX_PHASE_EVENTS } from "../../src/supervisor-phase-telemetry.ts";

const args=process.argv.slice(2);
function param(key) {const i=args.indexOf(key);return i<0?undefined:args[i+1];}
const count=Number(param("--count"));
const mode=param("--mode");
if(![1,2,4,10].includes(count)||!["red","green"].includes(mode)) {
  console.error("USAGE --count 1|2|4|10 --mode red|green");
  process.exit(2);
}
if(typeof global.gc!=="function")throw new Error("RUN_WITH_EXPOSE_GC");
const payload="x".repeat(2048);
const EVENTS_PER_SESSION=256, CURSOR_WINDOW=32;
const markers=[];
const probe=createSupervisorMemoryProbe(true,x=>markers.push(x));
global.gc();
const before=process.memoryUsage();
const slots=[];
await probe.run("admission","reserve",()=>{for(let i=0;i<count;i++)slots.push({id:"synthetic-"+i});});
await probe.run("github_branch","ensure",()=>true);
const sessions=await probe.run("session_create","create",()=>slots.map(s=>({
  id:s.id, events:Array.from({length:EVENTS_PER_SESSION},(_,j)=>({seq:j+1,content:j+":"+payload}))
})));
await probe.run("configure","setModel",()=>true);
await probe.run("submit","initial",()=>true);
const retained=[];
const materialized=await probe.run("status","logFold",()=>{
  let bytes=0;
  for(const session of sessions){
    if(mode==="red"){
      const full=JSON.stringify(session.events);bytes+=Buffer.byteLength(full);
      retained.push(full); // RED: full-history copy persists despite tiny wire response.
    }else{
      const tail=session.events.slice(-CURSOR_WINDOW).map(e=>e.seq);
      retained.push(tail); // GREEN: only a bounded metadata projection.
      bytes+=Buffer.byteLength(JSON.stringify(tail));
    }
  }
  return bytes;
});
await probe.run("cleanup","artifactRead",()=>({byteSize:64,kind:"synthetic"}));
const wire=JSON.stringify({status:"unknown",truncated:true});
global.gc();
const after=process.memoryUsage();
const output={
  label:"SYNTHETIC_NODE_ONLY",
  count,mode,eventsPerSession:EVENTS_PER_SESSION,eventChars:2048,cursorWindow:CURSOR_WINDOW,
  nodeV8HeapRetainedDeltaBytes:after.heapUsed-before.heapUsed,
  nodeRSSDeltaBytes:after.rss-before.rss,
  nodeExternalDeltaBytes:after.external-before.external,
  nodeArrayBuffersDeltaBytes:after.arrayBuffers-before.arrayBuffers,
  nodeHeapUsedAfterBytes:after.heapUsed,nodeRSSAfterBytes:after.rss,
  cloudflareIsolateBytes:null,cloudflareContainerBytes:null,cloudflareWorkerMcpHeapBytes:null,
  materializedBytes:materialized,retainedStrings:mode==="red"?retained.length:0,
  retainedCursorProjections:mode==="green"?retained.length:0,
  mcpWireBytes:Buffer.byteLength(wire),
  markers:markers.length,markerBudget:MAX_PHASE_EVENTS,
  source:"Node v8 process.memoryUsage; never attribute to workerd or container"
};
if(markers.length>MAX_PHASE_EVENTS)throw new Error("UNBOUNDED_PHASE_MARKERS");
console.log(JSON.stringify(output));
if(mode==="red")process.exitCode=1; // deliberate RED, fail closed

import { expect, test } from "bun:test";
import { createSupervisorMemoryProbe, MAX_PHASE_EVENTS, PHASE_MARKER,
  durationBucket, type PhaseEvent } from "./supervisor-phase-telemetry";

test("disabled by default: no events, no clock reads, same result", async () => {
  let n=0, times=0;
  const p=createSupervisorMemoryProbe(false, () => { n++; },()=> { times++;return 1; });
  const value=await p.run("session_create","create",()=>({private:"SECRET",id:"ses_private"}));
  expect(value.id).toBe("ses_private");
  expect(p.enabled).toBe(false);
  expect(n).toBe(0);expect(times).toBe(0);
});

test("RED: unbounded logging would exceed fixed 32-event budget; GREEN caps at 32", async () => {
  const events: PhaseEvent[]=[];
  const p=createSupervisorMemoryProbe(true,e=>events.push(e),()=>10);
  for(let i=0;i<250;i++) await p.run("status","busy",async()=>i);
  expect(events.length).toBe(MAX_PHASE_EVENTS);
  expect(events.every(e=>e.marker===PHASE_MARKER)).toBe(true);
  expect(events.filter(e=>e.edge==="begin").length).toBe(16);
  expect(events.filter(e=>e.edge==="end").length).toBe(16);
});

test("success and native error preserve exactly same object, never log payload or exception", async () => {
  const events: PhaseEvent[]=[];
  let t=10;
  const p=createSupervisorMemoryProbe(true,e=>events.push(e),()=>t);
  const secret={requestId:"deadbeefbeefdead",prompt:"DO_NOT_LOG",token:"SUPERSECRET"};
  const out=await p.run("admission","reserve",()=>{t=40;return secret;});
  expect(out).toBe(secret);
  const error=new Error("secret_opaque_error");
  await expect(p.run("session_create","create",()=>{throw error;})).rejects.toBe(error);
  const raw=JSON.stringify(events);
  for(const sensitive of ["deadbeefbeefdead","DO_NOT_LOG","SUPERSECRET","secret_opaque_error","stack","requestId"])
    expect(raw.includes(sensitive)).toBe(false);
  expect(events).toHaveLength(4);
  expect(events[1]).toMatchObject({edge:"end",outcome:"ok",elapsed:"under_100ms"});
  expect(events[3]).toMatchObject({edge:"end",outcome:"error"});
});

test("emitter fails: does not alter result/error or retry native side effect", async () => {
  let calls=0;const p=createSupervisorMemoryProbe(true,()=>{throw new Error("telemetry broken");});
  expect(await p.run("submit","initial",()=>++calls)).toBe(1);
  const e=new Error("original-error");
  await expect(p.run("submit","continue",()=>{calls++;throw e;})).rejects.toBe(e);
  expect(calls).toBe(2);
});

test("two concurrent spans share finite budget with fixed labels, no correlation IDs", async()=>{
  const events:PhaseEvent[]=[];
  let unblock: (x:number)=>void=()=>{};
  const gate=new Promise<number>(r=>{unblock=r});
  const p=createSupervisorMemoryProbe(true,e=>events.push(e));
  const pending=p.run("session_create","create",()=>gate);
  const other=await p.run("status","wait",()=>15);
  expect(other).toBe(15);
  unblock(19);expect(await pending).toBe(19);
  expect(events.map(x=>x.edge)).toEqual(["begin","begin","end","end"]);
  expect(events.map(x=>x.operation)).toEqual(["create","wait","wait","create"]);
  expect(JSON.stringify(events)).not.toContain("probe");
  expect(JSON.stringify(events)).not.toContain("id");
});

test("invalid phase-operation fails closed before invoking callback; buckets are finite",async()=>{
  let invoked=false;
  const p=createSupervisorMemoryProbe(true,()=>{});
  await expect(p.run("status","configure" as "busy",()=>{invoked=true;})).rejects.toThrow("PHASE_LABEL_INVALID");
  expect(invoked).toBe(false);
  expect(durationBucket(0)).toBe("under_5ms");
  expect(durationBucket(100)).toBe("under_500ms");
  expect(durationBucket(10001)).toBe("over_10s");
});

test("no high-cardinality labels or user input accepted in logs",async()=>{
  const events:PhaseEvent[]=[];
  const p=createSupervisorMemoryProbe(true,e=>events.push(e));
  await p.run("cleanup","artifactStoredRead",()=>new Uint8Array(32768));
  expect(events).toHaveLength(2);
  expect(JSON.stringify(events).length).toBeLessThan(500);
  expect(Object.keys(events[1]).sort()).toEqual(["edge","elapsed","marker","operation","outcome","phase"].sort());
});

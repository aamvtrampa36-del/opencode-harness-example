import {describe,expect,test} from "bun:test";
import {collectSupervisorDirectory, supervisorTaskCount} from "./supervisor-directory";

const task=(id:string,extras:Record<string,unknown>={})=>({
  id,session:"ses_"+id,repository:"aamvtrampa36-del/opencode-harness-example",
  project:"supervised-"+id,branch:"opencode/staging-"+id,
  fingerprint:"synthetic",status:"running",createdAt:100,updatedAt:200,...extras
});
const map=(records:unknown[])=>new Map(records.map((value,index)=>["supervisor:task:"+(value as {id:string}).id,value]));

describe("bounded supervisor session directory (no SDK full session listing)",()=>{
 test("returns indexed task sessions with verified runtime busy and conservative status",async()=>{
   const rows=map([task("a".repeat(16),{status:"finished",createdAt:5,updatedAt:10}),
     task("b".repeat(16),{createdAt:15,updatedAt:20})]);
   const visited:string[]=[];
   const x=await collectSupervisorDirectory(rows,async id=>{visited.push(id);return id.endsWith("b".repeat(16));},100,3);
   expect(x).toMatchObject({limited:false,scope:"SUPERVISED_INDEX_ONLY",countComplete:true});
   expect(x.sessions.map(s=>s.taskId)).toEqual(["b".repeat(16),"a".repeat(16)]);
   expect(x.sessions.map(s=>s.busy)).toEqual([true,false]);
   expect(x.sessions.every(s=>s.busyVerified)).toBe(true);
   expect(visited).toHaveLength(2);
 });
 test("faulty runtime busy probe is conservative, never falsely 'not busy'",async()=>{
   const x=await collectSupervisorDirectory(map([task("a".repeat(16))]),async()=>{throw Error("synthetic failure")});
   expect(x.sessions[0]).toMatchObject({busy:true,busyVerified:false,status:"unknown"});
 });
 test("limits examined rows and concurrent busy probes",async()=>{
   const rows=map(Array.from({length:101},(_,i)=>task(i.toString(16).padStart(16,"0"),{createdAt:i})));
   let current=0,peak=0,total=0;
   const x=await collectSupervisorDirectory(rows,async()=>{current++;peak=Math.max(current,peak);total++;await Promise.resolve();current--;return false;},100,4);
   expect(x).toMatchObject({limited:true,countComplete:false});
   expect(x.sessions).toHaveLength(100);
   expect(total).toBe(100);
   expect(peak).toBeLessThanOrEqual(4);
 });
 test("never mistakes index size for exact total when a sentinel exists",()=>{
   expect(supervisorTaskCount(map([task("a".repeat(16)),task("b".repeat(16))]),100))
     .toEqual({supervisedSessions:2,countComplete:true,limited:false});
   expect(supervisorTaskCount(map(Array.from({length:101},(_,i)=>task(i.toString(16).padStart(16,"0")))),100))
     .toEqual({supervisedSessions:100,countComplete:false,limited:true});
 });
 test("malformed storage entries fail closed rather than hiding a busy session",async()=>{
   const bad=new Map([["supervisor:task:"+"a".repeat(16),{id:"a".repeat(16),session:"../forged",status:"running"}]]);
   await expect(collectSupervisorDirectory(bad,async()=>false)).rejects.toThrow("SUPERVISOR_DIRECTORY_INVALID");
 });
});


test('P07 bounded directory entry point is distinct from legacy materialized listing',async()=>{
 const {collectProjectedSupervisorDirectory}=await import('./supervisor-directory');
 const key=await crypto.subtle.importKey('raw',new Uint8Array(32).fill(7),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 const row={key:'supervisor:task:'+'a'.repeat(16),session:'ses_fixture',status:'running',createdAt:1};
 const page=await collectProjectedSupervisorDirectory({next:async()=>({kind:'row',row})},{principal:'fixture',workspace:'fixture',view:'directory',session:'directory'},key,undefined,{rows:1,bytes:2048,ms:1000});
 expect(page.rows).toEqual([row]);expect(page.complete).toBe(false);expect(page.cursor).not.toBeNull();
});

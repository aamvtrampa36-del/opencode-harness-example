import {test,expect} from "bun:test";
import {putProjectedSupervisorTask,readTaskProjection,projectedTaskDirectory,logicalEventSource,importProjectionCursorKey} from "./metralla-m08-task-projection";
import {projectRemoteProgress,validateStatus,REMOTE_SCHEMA} from "./staging-control-mcp/p08-remote";
import type {SupervisorTask} from "./supervisor-control";
const id="0123456789abcdef",repo="aamvtrampa36-del/opencode-harness-example",session="ses_r2_"+id,principal="a".repeat(64),workspace="opencode-supervisor-v1";
const task:SupervisorTask={id,repository:repo,branch:"opencode/staging-"+id,project:"supervised-"+id,fingerprint:"b".repeat(64),createdAt:1,status:"preparing",githubSource:{repo,base:"fixture",branch:"opencode/staging-"+id,commit:"a".repeat(40),tree:"b".repeat(40),paths:["src/client.tsx"]}};
function fixture(){const rows=new Map<string,unknown>();const tx={get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:any)=>{rows.set(k,structuredClone(v));},list:async({prefix,limit}:any)=>new Map([...rows].filter(([k])=>k.startsWith(prefix)).slice(0,limit))} as unknown as DurableObjectStorage;return {rows,tx};}
test("atomic writer fixed status and contiguous logical projection, never history",async()=>{
 const f=fixture(),key="supervisor:task:"+id;
 await putProjectedSupervisorTask(f.tx,key,task);
 await putProjectedSupervisorTask(f.tx,key,{...task,status:"running",session});
 const p=await readTaskProjection(f.tx,id);
 expect(p).toEqual({id,session,status:"running",createdAt:1,revision:1,seq:2,coverage:true});
 const dirs=await projectedTaskDirectory(f.tx);expect(dirs.entries.length).toBe(1);expect(dirs.historicalCoverage).toBe(false);
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([principal,id])))),b=>b.toString(16).padStart(2,"0")).join("");
 const source=logicalEventSource(f.tx,p,{principal:digest,workspace,session,view:"progress"});
 const k=await importProjectionCursorKey("e".repeat(64));
 const page=await projectRemoteProgress({id,workspace:null},undefined,async()=>({principal,workspace,session,key:k,source}));
 expect(page.events.map(e=>e.type)).toEqual(["supervisor.logical.preparing","supervisor.logical.running"]);expect(page.nativeOperationsMeasured).toBe(false);
 expect(validateStatus({schema:REMOTE_SCHEMA,id,workspace:null,revision:p.revision,status:p.status},{id,workspace:null},0).changed).toBe(true);
 await expect(source.next({principal:"other",workspace,session,view:"progress"},"",100,new AbortController().signal)).rejects.toThrow();
 f.rows.delete("supervisor:projection:v1:event:"+id+":000002");
 await expect(projectRemoteProgress({id,workspace:null},undefined,async()=>({principal,workspace,session,key:k,source}))).rejects.toThrow("PROJECTION_SEQUENCE_GAP");
});
test("historical and missed writer do not fabricate coverage",async()=>{
 const f=fixture(),key="supervisor:task:"+id;
 await f.tx.put(key,task);
 await putProjectedSupervisorTask(f.tx,key,{...task,session,status:"running"});
 await expect(readTaskProjection(f.tx,id)).rejects.toThrow("PROJECTION_COVERAGE_UNKNOWN");
 const g=fixture();await putProjectedSupervisorTask(g.tx,key,task);
 await g.tx.put(key,{...task,status:"unknown"});await putProjectedSupervisorTask(g.tx,key,{...task,status:"cancelled"});
 await expect(readTaskProjection(g.tx,id)).rejects.toThrow("PROJECTION_COVERAGE_UNKNOWN");
 await expect(importProjectionCursorKey(undefined)).rejects.toThrow();
});

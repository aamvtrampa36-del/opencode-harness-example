import {test,expect} from "bun:test";
import {readFileSync} from "node:fs";
import * as guards from "./metralla-m03-execution-identity";
import {CLOSE_KEY} from "./metralla-m03-close";
import {captureBoundedOutput} from "./bounded-process-output";
import {assertLinuxExecutionScope,validateCommand,linuxProjectCwdSource,MAX_SHELL_OUTPUT} from "./dev-guard";
const src=readFileSync(new URL("./dev-container.ts",import.meta.url),"utf8");
function section(start:string,end:string){
 const a=src.indexOf(start),b=src.indexOf(end,a+start.length);
 if(a<0||b<=a)throw Error("P11 exact source missing: "+start);
 return src.slice(a,b);
}
const methods=section("  private async ensureRunning()","  /** Read-only pre-admission gate.")+
 section("  async run(project:","  /** Debian's minimal managed image");
const js=new Bun.Transpiler({loader:"ts"}).transformSync("class Projected {\n"+methods+"\n}");
const Projected=new Function("CLOSE_KEY","assertRuntime","assertSourceReceipt","assertImagePolicy","assertLease","assertExecutionIdentity","assertLinuxExecutionScope","validateCommand","linuxProjectCwdSource","MAX_SHELL_OUTPUT","captureBoundedOutput","commandRequiresBun","LINUX_RUNNER_SOURCE",js+"\nreturn Projected;")(
 CLOSE_KEY,guards.assertRuntime,guards.assertSourceReceipt,guards.assertImagePolicy,guards.assertLease,guards.assertExecutionIdentity,assertLinuxExecutionScope,validateCommand,linuxProjectCwdSource,MAX_SHELL_OUTPUT,captureBoundedOutput,()=>false,"// fixture runner");
const project="supervised-0123456789abcdef",objectId="a".repeat(64),bootLabel="12345678-1234-1234-1234-123456789abc",bootId="23456789-1234-1234-1234-123456789abc";
const ref="cloudflare/debian-trixie";
const source={project,repository:"aamvtrampa36-del/opencode-harness-example",commit:"b".repeat(40),tree:"c".repeat(40)};
const receipt={...source,certification:"raw-git-tree-v1",sha256:"d".repeat(64),files:2};
const boot={project,objectId,bootLabel,bootId,image:{kind:"reference",reference:ref}};
function stream(text:string){return new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(text));c.close()}})}
function fixture(){
 const data=new Map<string,any>([["isolated-repository-v1",receipt],["m03-execution-boot-v1",boot]]);
 let running=true,label=bootLabel,kernel=bootId,image=ref,payloads=0,starts=0,probes=0,signal:AbortSignal|undefined;
 const container={get running(){return running},inspect:async()=>({image,labels:{m03boot:label}}),
  exec:async(args:string[],options?:{signal?:AbortSignal})=>{
   const probe=args[2]?.includes("/proc/sys/kernel/random/boot_id");
   if(probe)probes++;else{payloads++;signal=options?.signal}
   return {stdout:stream(probe?kernel:"output"),stderr:stream(""),exitCode:Promise.resolve(0)};
  }};
 const p=new Projected();
 Object.assign(p,{ctx:{id:{name:"project-v1:"+project,toString:()=>objectId},container,storage:{get:async(k:string)=>data.get(k),put:async(k:string,v:unknown)=>{data.set(k,v)}}},env:{},busy:0,commandQueue:Promise.resolve(),
 checkPilotWork:async()=>undefined,recordProject:async()=>{},scheduleCheck:async()=>{},startOrRecover:async()=>{starts++;throw Error("unexpected restart")},ensureGitAvailable:async()=>{throw Error("unexpected bootstrap")},ensureBunAvailable:async()=>{throw Error("unexpected bootstrap")}});
 const lease={requestId:"0123456789abcdef",project,generation:1,token:"fixture-only",expiresAt:Date.now()+60000};
 const scope={source,boot,lease};
 return {p,data,scope,lease,set:(v:{running?:boolean;label?:string;kernel?:string;image?:string})=>{if(v.running!==undefined)running=v.running;if(v.label!==undefined)label=v.label;if(v.kernel!==undefined)kernel=v.kernel;if(v.image!==undefined)image=v.image;},counts:()=>({payloads,starts,probes,signal})};
}
test("actual DevContainer fenced methods: live observation, source and lease before payload",async()=>{
 const f=fixture();
 const b=await f.p.executionBoot(source);expect(b).toEqual(boot);
 const r=await f.p.runFenced(f.scope,f.lease,"echo fixture");expect(r.exitCode).toBe(0);expect(r.stdout).toBe("output");
 expect(f.counts().payloads).toBe(1);expect(f.counts().starts).toBe(0);expect(f.counts().probes).toBeGreaterThan(1);expect(f.counts().signal).toBeDefined();
});
test("actual DevContainer fenced methods deny replaced/missing VM, foreign source and stale lease, without payload or restart",async()=>{
 for(const v of [{running:false},{label:"other"},{kernel:"34567890-1234-1234-1234-123456789abc"},{image:"other/image"}]){
  const f=fixture();f.set(v);await expect(f.p.runFenced(f.scope,f.lease,"echo denied")).rejects.toThrow();expect(f.counts().payloads).toBe(0);expect(f.counts().starts).toBe(0);
 }
 for(const variant of ["source","lease","boot"]){
  const f=fixture();
  if(variant==="source")f.data.set("isolated-repository-v1",{...receipt,tree:"0".repeat(40)});
  if(variant==="lease")f.lease.expiresAt=Date.now()-1;
  if(variant==="boot")f.data.delete("m03-execution-boot-v1");
  await expect(f.p.runFenced(f.scope,f.lease,"echo denied")).rejects.toThrow();expect(f.counts().payloads).toBe(0);expect(f.counts().starts).toBe(0);
 }
});
test("certified binding cannot be bypassed via legacy run or automatic restart",async()=>{
 const f=fixture();await expect(f.p.run(project,"echo denied")).rejects.toThrow("M03_FENCED_EXECUTION_REQUIRED");
 f.set({running:false});await expect(f.p.ensureRunning()).rejects.toThrow("M03_VM_IDENTITY_MISMATCH");
 expect(f.counts().payloads).toBe(0);expect(f.counts().starts).toBe(0);
});
test("normal lane does not permit a request ID different from its supervised project",()=>{
 const f=fixture(),bad={...f.lease,requestId:"f".repeat(16)};
 expect(()=>guards.assertLease(bad,bad,project,Date.now())).toThrow("M03_LEASE_FENCED");
});

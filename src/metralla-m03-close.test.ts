import {test,expect} from "bun:test";
import {readFileSync} from "node:fs";
import {checkpointSnapshot,assertRecoverableContainer} from "./snapshot-policy";
import {CLOSE_KEY,assertCloseRecord,assertRecoveryCheckpoint,physicalCloseVerified} from "./metralla-m03-close";
import {assertRuntime} from "./metralla-m03-execution-identity";
const text=readFileSync(new URL("./dev-container.ts",import.meta.url),"utf8");
const from=text.indexOf("  /** Durable Object alarm: checkpoint"),to=text.indexOf("  /** HTTP-only static preview;",from);
const code=new Bun.Transpiler({loader:"ts"}).transformSync("class Projected {\n"+text.slice(from,to)+"\n}");
const Projected=new Function("CLOSE_KEY","assertCloseRecord","checkpointSnapshot","assertRuntime","pilotRuntimeMatches","normalizeImageRef","IDLE_MS","CHECKPOINT_MS","INACTIVITY_MS",code+"\nreturn Projected;")(CLOSE_KEY,assertCloseRecord,checkpointSnapshot,assertRuntime,()=>false,(x:unknown)=>x,1,1,1000);
function fixture(){
 const map=new Map<string,any>([["lastActivity",Date.now()-10000],["snapshotId","old"],["savedAt",Date.now()-20000]]);
 const options={failSnapshot:false,lostDestroy:false,wrongReadback:false,changeImage:false,loseClaim:false};
 let destroyed=0,snapshots=0,running=true,image="cloudflare/debian-trixie";
 const storage={get:async(k:string)=>map.get(k),put:async(k:string|Record<string,unknown>,v?:unknown)=>{
   if(typeof k==="string")map.set(k,v);else for(const [key,value] of Object.entries(k))map.set(key,key==="snapshotId"&&options.wrongReadback?"wrong":value);
 },transaction:async(fn:any)=>{await fn(storage);if(options.loseClaim)throw Error("lost claim reply");}};
 const container={get running(){return running},inspect:async()=>({image}),snapshotContainer:async()=>{
   snapshots++;if(options.failSnapshot)throw Error("snapshot");if(options.changeImage)image="other/image";return {id:"new"};
 },destroy:async()=>{destroyed++;if(options.lostDestroy)throw Error("lost reply");running=false;},setInactivityTimeout:async()=>{}};
 const make=()=>Object.assign(new Projected(),{ctx:{container,storage,id:{toString:()=>"fixture-do"}},busy:0,closing:false,scheduleCheck:async()=>{}});
 return {options,map,make,counts:()=>({destroyed,snapshots}),container};
}
test("snapshot failure preserves previous checkpoint and does not destroy",async()=>{const f=fixture();f.options.failSnapshot=true;await f.make().alarm();expect(f.map.get("snapshotId")).toBe("old");expect(f.counts().destroyed).toBe(0);});
test("checkpoint readback mismatch refuses destruction",async()=>{const f=fixture();f.options.wrongReadback=true;await f.make().alarm();expect(f.counts().destroyed).toBe(0);});
test("duplicate close and restart only send destroy once",async()=>{const f=fixture(),p=f.make();await Promise.all([p.alarm(),p.alarm()]);await f.make().alarm();expect(f.counts()).toEqual({destroyed:1,snapshots:1});expect(f.map.get(CLOSE_KEY).phase).toBe("destroy_acknowledged");});
test("lost destroy response remains fenced after restart",async()=>{const f=fixture();f.options.lostDestroy=true;await f.make().alarm();await f.make().alarm();expect(f.counts().destroyed).toBe(1);expect(f.map.get(CLOSE_KEY).phase).toBe("destroy_requested");expect(()=>assertRecoveryCheckpoint(f.map.get(CLOSE_KEY),"fixture-do","new",f.map.get("savedAt"),Date.now())).toThrow();});
test("lost claim response cannot cause a duplicate effect",async()=>{const f=fixture();f.options.loseClaim=true;await f.make().alarm();await f.make().alarm();expect(f.counts().destroyed).toBe(0);expect(f.map.get(CLOSE_KEY).phase).toBe("destroy_requested");});
test("divergent image stops destruction",async()=>{const f=fixture();f.options.changeImage=true;await f.make().alarm();expect(f.counts().destroyed).toBe(0);});
test("acknowledged status is not native closure; independent identity and zero activity required",async()=>{const f=fixture();await f.make().alarm();const r=f.map.get(CLOSE_KEY);const o={operation:r.operation,objectId:r.objectId,identity:r.identity,source:"independent-native" as const,vmTerminated:true,descendants:0,nativeOperations:0,proof:"fixture"};expect(physicalCloseVerified(r,null)).toBe(false);expect(physicalCloseVerified(r,{...o,identity:"wrong"})).toBe(false);expect(physicalCloseVerified(r,{...o,descendants:1})).toBe(false);expect(physicalCloseVerified(r,{...o,nativeOperations:1})).toBe(false);expect(physicalCloseVerified(r,o)).toBe(true);});
test("recovery refuses malformed or future checkpoint",()=>{expect(()=>assertRecoverableContainer("bad id",Date.now(),Date.now(),Date.now())).toThrow();expect(()=>assertRecoverableContainer("good",Date.now()+10000,1,Date.now())).toThrow();});

import {test,expect} from "bun:test";
import {readFileSync} from "node:fs";
const source=readFileSync(new URL("./metralla-m08-recovery-stop.ts",import.meta.url),"utf8");
test("emergency freeze exports the same names and touches no state or external service",async()=>{
 const code=source.replace(/import .* from "cloudflare:workers";/,"").replaceAll("export class ","class ").replaceAll("export function ","function ").replace("export default ","const worker=");
 const js=new Bun.Transpiler({loader:"ts"}).transformSync(code);
 let touches=0;class Base{constructor(_ctx:unknown,_env:unknown){}}
 const trap=new Proxy({},{get(){touches++;throw Error("effect forbidden");}});
 const result=new Function("DurableObject","WorkflowEntrypoint",js+";return {worker,OpenCodeAgent,DevContainer,PersonalSettings,SessionBackupDrillAgent,OpenCodeSupervisorWorkflow};")(Base,Base);
 expect(result.worker.fetch().status).toBe(503);
 for(const name of ["OpenCodeAgent","DevContainer","PersonalSettings","SessionBackupDrillAgent"]){
  const d=new result[name](trap,trap);expect(d.fetch().status).toBe(503);await expect(d.alarm()).rejects.toThrow("M08_RECOVERY_FROZEN");expect(d.startSupervisedTask).toBeUndefined();
 }
 await expect(new result.OpenCodeSupervisorWorkflow(trap,trap).run()).rejects.toThrow("M08_RECOVERY_FROZEN");expect(touches).toBe(0);
});

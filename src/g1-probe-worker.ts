/** TEMPORARY STAGING-ONLY G1 proof. Remove after check. Production uses src/server.ts. */
import handler from "./server";
export { OpenCodeAgent, PersonalSettings, DevContainer } from "./server";
const PROOF_WORKSPACE = "d46c73a9-7e9d-4280-a0a9-1a7bf5cb3405";
type G1State = {status?:string; kind?:string; model?:string; project?:string;toolCalls?:number;
  observedFailingTest?:boolean;fileVerified?:boolean;reason?:string};
export default {
  fetch: handler.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      const host = env.OpenCodeAgent.getByName(PROOF_WORKSPACE);
      const status = await host.agentCheckStatus() as G1State;
      if(status.status==="not-started"){
        const result=await host.startAgentCheck("cloudflare","repair");
        console.log("G1_TAP_RETRY",JSON.stringify({step:"start",status:result.status,model:result.model,
          kind:result.kind,project:result.project,message:result.message?.slice(0,230)}));
      }else{
        console.log("G1_TAP_RETRY",JSON.stringify({step:"poll",status:status.status,model:status.model,
          kind:status.kind,project:status.project,toolCalls:status.toolCalls,
          observedFailingTest:status.observedFailingTest,fileVerified:status.fileVerified,
          reason:status.reason?.slice(0,230)}));
      }
    }catch(error){
      console.error("G1_TAP_ERROR",error instanceof Error?error.message.slice(0,240):"unknown");
    }
  }
} satisfies ExportedHandler<Env>;

/** One-shot G1 staging diagnostic and real-agent verification, temporary.
 * Not production: only wrangler.g1.jsonc uses this entrypoint.
 * No public probe route. Remove the schedule and file after a bounded run.
 */
import original from "./server";
import { repairSeedCommand } from "./agent-check";
export { OpenCodeAgent, DevContainer, PersonalSettings } from "./server";

const WORKSPACE = "e0b25d54-8b6f-4908-a1d6-4b6d15a0ad65";
const PREFLIGHT_PROJECT = "agent-check-preflight-20261109";
type CheckState = {status?:string;project?:string;model?:string;kind?:string;toolCalls?:number;
  observedFailingTest?:boolean;fileVerified?:boolean;reason?:string};

export default {
  fetch: original.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      const host = env.OpenCodeAgent.getByName(WORKSPACE);
      const current = await host.agentCheckStatus() as CheckState;
      if (current.status === "failed" || current.status === "passed") {
        const trace = await host.g1SyntheticTrace();
        console.log("G1_TOOL_TRACE", JSON.stringify(trace));
        if (current.project?.startsWith("agent-check-")) {
          try {
            const source = await env.DEV.getByName("personal").inspect(current.project, "read", "calc.mjs") as { contents?: string };
            console.log("G1_SOURCE_AUDIT", JSON.stringify({project:current.project, source:source.contents?.slice(0,180)}));
          } catch (error) {
            console.log("G1_SOURCE_AUDIT", JSON.stringify({error:error instanceof Error ? error.message.slice(0,180) : "inspect failed"}));
          }
        }
      }
      if (current.status !== "not-started") {
        console.log("G1_STAGING", JSON.stringify({
          phase:"status",status:current.status,project:current.project,model:current.model,kind:current.kind,
          toolCalls:current.toolCalls,observedFailingTest:current.observedFailingTest,
          fileVerified:current.fileVerified,reason:current.reason?.slice(0,260)
        }));
        return;
      }
      const dev = env.DEV.getByName("personal");
      const probe = await dev.run(PREFLIGHT_PROJECT, repairSeedCommand());
      const ok = probe.exitCode === 1 && probe.stdout.includes("not ok");
      console.log("G1_STAGING", JSON.stringify({
        phase:"preflight",ok,exitCode:probe.exitCode,
        stdout:probe.stdout.slice(0,950),stderr:probe.stderr.slice(0,950),truncated:probe.truncated
      }));
      if (!ok) return; // No model quota if Linux itself cannot prepare the fixture.
      const result = await host.startAgentCheck("cloudflare","repair");
      console.log("G1_STAGING", JSON.stringify({
        phase:"start",status:result.status,session:result.session,project:result.project,
        model:result.model,kind:result.kind,message:result.message?.slice(0,280)
      }));
    } catch (error) {
      console.error("G1_STAGING_ERROR",error instanceof Error ? error.message.slice(0,320) : "unknown");
    }
  }
} satisfies ExportedHandler<Env>;

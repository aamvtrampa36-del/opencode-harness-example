/** Staging-only, temporary G1 evidence probe.
 * Not used by production: production wrangler.jsonc continues to use src/server.ts.
 * Cron must be removed after the verification; no permanent background task.
 */
import base from "./server";
export { OpenCodeAgent, PersonalSettings, DevContainer } from "./server";

const PROBE_WORKSPACE = "81e1376c-1428-47fa-9b0f-e128bca7a527";

type ProbeStatus = { status?: string; toolCalls?: number; observedFailingTest?: boolean;
  fileVerified?: boolean; project?: string; model?: string; kind?: string; reason?: string };

export default {
  fetch: base.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const host = env.OpenCodeAgent.getByName(PROBE_WORKSPACE);
    try {
      const check = await host.agentCheckStatus() as ProbeStatus;
      if (check.status === "not-started") {
        const initiated = await host.startAgentCheck("cloudflare", "repair");
        console.log("G1_EVIDENCE", JSON.stringify({
          phase: "start", status: initiated.status, kind: initiated.kind,
          model: initiated.model, project: initiated.project, message: initiated.message
        }));
        return;
      }
      console.log("G1_EVIDENCE", JSON.stringify({
        phase: "poll", status: check.status, toolCalls: check.toolCalls,
        observedFailingTest: check.observedFailingTest, fileVerified: check.fileVerified,
        model: check.model, kind: check.kind, project: check.project,
        reason: check.reason?.slice(0, 280)
      }));
    } catch (error) {
      console.error("G1_PROBE_ERROR", error instanceof Error ? error.message.slice(0, 400) : "unknown");
    }
  }
} satisfies ExportedHandler<Env>;

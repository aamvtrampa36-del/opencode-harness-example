/** Temporary G2 staging-only scheduled test runner; no unauthenticated HTTP routes. */
import app from "./server";
export { OpenCodeAgent, DevContainer, PersonalSettings } from "./server";
const OWNER_WORKSPACE = "e0b25d54-8b6f-4908-a1d6-4b6d15a0ad65";
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      const result = await env.OpenCodeAgent.getByName(OWNER_WORKSPACE).g2ProofTick();
      console.log("G2_PROOF_20261109", JSON.stringify(result));
    } catch (error) {
      console.error("G2_PROOF_ERROR", error instanceof Error ? error.message.slice(0,260) : "unknown");
    }
  }
} satisfies ExportedHandler<Env>;

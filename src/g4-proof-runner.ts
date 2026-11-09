/** Temporary G4 staging-only scheduled proof; no public recovery bypass. */
import app from "./server";
export { OpenCodeAgent, DevContainer, PersonalSettings } from "./server";
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      const receipt = await env.DEV.getByName("g4-isolated-20261109-v2").g4IsolatedPilot();
      console.log("G4_PROOF_20261109", JSON.stringify(receipt));
    } catch (error) {
      console.error("G4_PROOF_ERROR", error instanceof Error ? error.message.slice(0,320) : "unknown");
    }
  }
} satisfies ExportedHandler<Env>;

/** Temporary protected staging-only G2 autonomous self-development proof runner. */
import app from "./server";
export { OpenCodeAgent, DevContainer, PersonalSettings } from "./server";
const OWNER_WORKSPACE = "e0b25d54-8b6f-4908-a1d6-4b6d15a0ad65";
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const result = await env.OpenCodeAgent.getByName(OWNER_WORKSPACE).g2SelfDevTick();
      console.log("G2_SELFDEV_20261109", JSON.stringify(result));
    } catch (error) {
      console.error("G2_SELFDEV_ERROR", error instanceof Error ? error.message.slice(0,260) : "unknown");
    }
  }
} satisfies ExportedHandler<Env>;

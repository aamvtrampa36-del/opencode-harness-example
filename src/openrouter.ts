import type { Plugin } from "@opencode/plugin";

/**
 * Attach OpenRouter using the V2 integration API. Never serialize the key to
 * source, logs, UI props, model metadata, or a browser response.
 *
 * The credential is saved inside OpenCode's Durable Object-backed credential
 * store. Cloudflare Worker Secrets are the source of truth for initial setup.
 */
export function openRouterCredentialPlugin(key: string): Plugin.Plugin {
  return {
    id: "cdf.openrouter-credential",
    async setup(ctx) {
      // Repeated Durable Object wakeups must not create a new connection.
      const existing = await ctx.integration.connection.active("openrouter");
      if (!existing) {
        await ctx.integration.connect.key({
          integrationID: "openrouter",
          key
        });
      }
    }
  };
}

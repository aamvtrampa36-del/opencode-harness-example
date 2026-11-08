import type { Plugin } from "@opencode/plugin";

/**
 * This plugin uses the native OpenCode integration API. The credential lives
 * exclusively in Cloudflare's server-side Durable Object or Worker Secrets.
 * The active host can be updated without creating another agent instance.
 */
export function openRouterCredentialPlugin(
  loadKey: () => Promise<string | undefined>,
  registerConnector: (connect: (key: string) => Promise<void>) => void
): Plugin.Plugin {
  return {
    id: "cdf.openrouter-credential",
    async setup(ctx) {
      const connect = async (key: string) => {
        await ctx.integration.connect.key({ integrationID: "openrouter", key });
        await ctx.model.reload();
      };
      registerConnector(connect);
      const key = await loadKey();
      if (key) await connect(key);
    }
  };
}

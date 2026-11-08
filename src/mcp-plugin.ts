import type { Plugin } from "@opencode/plugin";
import type { RemoteMcpConfig } from "./mcp-config";

/**
 * Native OpenCode MCP lifecycle. No custom tool protocol or agent framework:
 * OpenCode itself discovers tools and handles remote MCP transport.
 */
export function remoteMcpPlugin(
  loadConfigs: () => Promise<RemoteMcpConfig[]>,
  registerReload: (reload: () => Promise<void>) => void
): Plugin.Plugin {
  return {
    id: "personal.remote-mcp",
    async setup(ctx) {
      let current = await loadConfigs();
      let previous = new Set<string>();
      await ctx.mcp.transform((editor) => {
        const next = new Set<string>();
        for (const old of previous) editor.remove(old);
        for (const endpoint of current) {
          const id = "personal-" + endpoint.id;
          next.add(id);
          editor.set(id, {
            type: "remote",
            url: endpoint.url,
            disabled: !endpoint.enabled,
            codemode: false,
            ...(endpoint.token ? {
              oauth: false,
              headers: { Authorization: "Bearer " + endpoint.token }
            } : {})
          });
        }
        previous = next;
      });
      registerReload(async () => {
        current = await loadConfigs();
        await ctx.mcp.reload();
      });
    }
  };
}

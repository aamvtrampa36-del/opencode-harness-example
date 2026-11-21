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
      if (ctx.session) {
        await ctx.session.hook("context", async ({ agent, tools }) => {
          for (const endpoint of current) {
            const prefix = "personal-" + endpoint.id + "_";
            if (!endpoint.toolAllowlist) {
              // Unrestricted remote MCP servers can expose writes. Plan and
              // Review must not receive them unless the owner configured an
              // explicit endpoint allowlist.
              if (agent === "plan") {
                for (const name of Object.keys(tools)) if (name.startsWith(prefix)) delete tools[name];
              }
              continue;
            }
            const allowed = new Set(endpoint.toolAllowlist);
            for (const name of Object.keys(tools)) {
              if (name.startsWith(prefix) && !allowed.has(name.slice(prefix.length))) delete tools[name];
            }
          }
        });
      }
      await ctx.mcp.transform((editor) => {
        const next = new Set<string>();
        for (const old of previous) editor.remove(old);
        for (const endpoint of current) {
          const id = "personal-" + endpoint.id;
          next.add(id);
          editor.set(id, {
            type: "remote",
            url: endpoint.url,
            disabled: !endpoint.enabled || (endpoint.auth === "oauth" && !endpoint.token),
            codemode: false,
            ...(endpoint.auth === "oauth" || endpoint.token ? { oauth: false } : {}),
            ...(endpoint.token ? { headers: { Authorization: "Bearer " + endpoint.token } } : {})
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

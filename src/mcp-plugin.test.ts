import { describe, expect, test } from "bun:test";
import { remoteMcpPlugin } from "./mcp-plugin";
import type { RemoteMcpConfig } from "./mcp-config";

describe("remote MCP tool wiring", () => {
  test("keeps OAuth in app-owned headers and limits CDF presets to read tools", async () => {
    let contextHook: ((input: { tools: Record<string, unknown> }) => Promise<void>) | undefined;
    const configured = new Map<string, unknown>();
    const endpoint: RemoteMcpConfig = {
      id: "cdf-cloud-production", url: "https://cdf.example/mcp", enabled: true,
      auth: "oauth", connected: true, token: "short-lived-access-token", toolAllowlist: ["cdf_status"]
    };
    const plugin = remoteMcpPlugin(async () => [endpoint], () => undefined);
    await plugin.setup({
      session: { hook: async (_name: string, callback: typeof contextHook) => { contextHook = callback; } },
      mcp: {
        transform: async (callback: (editor: any) => unknown) => callback({
          remove: () => undefined, set: (name: string, value: unknown) => configured.set(name, value)
        }),
        reload: async () => undefined
      }
    } as any);
    expect(configured.get("personal-cdf-cloud-production")).toMatchObject({
      oauth: false, disabled: false, headers: { Authorization: "Bearer short-lived-access-token" }
    });
    const tools: Record<string, unknown> = {
      "personal-cdf-cloud-production_cdf_status": {},
      "personal-cdf-cloud-production_cdf_documents": {},
      github_repo_read: {}
    };
    await contextHook?.({ tools });
    expect(Object.keys(tools)).toEqual(["personal-cdf-cloud-production_cdf_status", "github_repo_read"]);
  });
});

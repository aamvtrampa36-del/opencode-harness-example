import { describe, expect, test } from "bun:test";
import type { Workspace } from "@cloudflare/computer";
import { workspacePlugin } from "./workspace";

describe("agent-proposed templates", () => {
  test("creates a pending proposal, never activates or saves it itself", async () => {
    const tools = new Map<string, any>();
    const proposed: unknown[] = [];
    const plugin = workspacePlugin({} as Workspace, {}, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, {
        propose: async value => { proposed.push(value); return { id: "proposal-1" }; }
      });
    await plugin.setup({
      agent: { transform: async () => undefined },
      tool: { transform: async (callback: (editor: any) => unknown) => callback({
        remove: () => undefined, add: (tool: any) => tools.set(tool.name, tool)
      }) }
    } as any);
    const template = { id: "cdf-report", name: "Informe CDF", instructions: "Resume con evidencia.", enabled: true };
    const response = await tools.get("propose_template").execute({ templateJson: JSON.stringify(template) }, { sessionID: "ses_root" });
    expect(proposed).toEqual([template]);
    expect(JSON.parse(response.content)).toMatchObject({ status: "pending-owner-approval", proposal: "proposal-1" });
    expect(tools.get("propose_template").description).toContain("debe revisarla y aprobarla");
  });
});

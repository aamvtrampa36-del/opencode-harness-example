import { describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import type { WorkspaceModuleCallContext } from "@cloudflare/computer";
import { createDynamicMcpHost, createMcpFetch } from "./dynamic-mcp-bridge";
import type { RemoteMcpConfig } from "./mcp-config";

const token = "private-test-access-token";
const endpoint: RemoteMcpConfig = {
  id: "cdf-workbench", url: "https://workbench.example/mcp", enabled: true,
  auth: "oauth", connected: true, token, toolAllowlist: ["cdf_status"]
};

function contextFor(state: Awaited<ReturnType<ReturnType<typeof createDynamicMcpHost>["createState"]>>) {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 30_000,
    access: "read" as const,
    callId: "test-call",
    execution: { id: "test-execution", metadata: {} },
    resolvePath: async (path: string) => path,
    state: Promise.resolve(state)
  } as unknown as WorkspaceModuleCallContext;
}

describe("Dynamic Worker MCP bridge", () => {
  test("uses manual redirects and rejects 3xx responses before following them", async () => {
    let calls = 0;
    let redirect: RequestRedirect | undefined;
    const fetchMcp = createMcpFetch(async (_input, init) => {
      calls++;
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example/collect" }
      });
    });

    await expect(fetchMcp("https://workbench.example/mcp", { redirect: "follow" }))
      .rejects.toThrow("Se bloqueó una redirección");
    expect(calls).toBe(1);
    expect(redirect).toBe("manual");
  });

  test("lists only configured tools and calls them with host-held auth", async () => {
    let receivedEndpoint: RemoteMcpConfig | undefined;
    let calls = 0;
    let closes = 0;
    const client = {
      connect: async () => undefined,
      close: async () => { closes++; },
      listTools: async () => ({ tools: [
        { name: "cdf_status", description: "Status", inputSchema: { type: "object", properties: {} } },
        { name: "cdf_write", description: "Write", inputSchema: { type: "object", properties: {} } }
      ] }),
      callTool: async ({ name }: { name: string }) => {
        calls++;
        return {
          isError: false,
          content: [{ type: "text", text: `token=${token}` }],
          structuredContent: { selected: name, token }
        };
      }
    } as unknown as Pick<Client, "connect" | "close" | "listTools" | "callTool">;
    const host = createDynamicMcpHost(async () => [endpoint], async current => {
      receivedEndpoint = current;
      return { client };
    });
    const state = await host.createState();
    const context = contextFor(state);

    const servers = await host.functions.servers([], context);
    expect(servers).toEqual([{ id: "cdf-workbench", auth: "oauth", restrictedTo: ["cdf_status"] }]);
    expect(JSON.stringify(servers)).not.toContain(token);
    const tools = await host.functions.tools([{ server: "cdf-workbench" }], context) as { name: string }[];
    expect(tools.map(tool => tool.name)).toEqual(["cdf_status"]);
    expect(receivedEndpoint?.token).toBe(token);

    await expect(host.functions.call([{
      server: "cdf-workbench", name: "cdf_write", arguments: {}
    }], context)).rejects.toThrow("no está en la lista permitida");
    expect(calls).toBe(0);

    const result = await host.functions.call([{
      server: "cdf-workbench", name: "cdf_status", arguments: {}
    }], context) as Record<string, unknown>;
    expect(result).toMatchObject({ isError: false });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).toContain("[redacted]");
    expect(calls).toBe(1);

    await host.dispose(state);
    expect(closes).toBe(1);
  });

  test("recovers after an MCP tool error and stops at the per-run call limit", async () => {
    let calls = 0;
    const client = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        calls++;
        if (calls === 1) throw new Error(`temporary failure ${token}`);
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
    } as unknown as Pick<Client, "connect" | "close" | "listTools" | "callTool">;
    const host = createDynamicMcpHost(async () => [{ ...endpoint, toolAllowlist: undefined }],
      async () => ({ client }));
    const state = await host.createState();
    const context = contextFor(state);
    const args = [{ server: endpoint.id, name: "cdf_status", arguments: {} }];

    await expect(host.functions.call(args, context)).rejects.toThrow("[redacted]");
    expect(await host.functions.call(args, context)).toMatchObject({ isError: false });
    for (let i = 0; i < 30; i++) await host.functions.call(args, context);
    await expect(host.functions.call(args, context)).rejects.toThrow("máximo de 32");
    expect(calls).toBe(32);
    await host.dispose(state);
  });

  test("direct control discovery and call share the existing allowlist and secret boundary", async () => {
    let calls = 0;
    let closes = 0;
    const client = {
      connect: async () => undefined,
      close: async () => { closes++; },
      listTools: async () => ({ tools: [
        { name: "cdf_status", inputSchema: { type: "object", properties: {} } },
        { name: "cdf_write", inputSchema: { type: "object", properties: {} } }
      ] }),
      callTool: async ({ name }: { name: string }) => {
        calls++;
        return { isError: false, content: [{ type: "text", text: `${name} token=${token}` }] };
      }
    } as unknown as Pick<Client, "connect" | "close" | "listTools" | "callTool">;
    const host = createDynamicMcpHost(async () => [endpoint], async () => ({ client }));
    const servers = await host.listServers();
    expect(servers).toEqual([{ id: "cdf-workbench", auth: "oauth", restrictedTo: ["cdf_status"] }]);
    const tools = await host.listTools("cdf-workbench") as { name: string }[];
    expect(tools.map(item => item.name)).toEqual(["cdf_status"]);
    await expect(host.callTool({ server: "cdf-workbench", name: "cdf_write", arguments: {} }))
      .rejects.toThrow("no está en la lista permitida");
    const result = await host.callTool({ server: "cdf-workbench", name: "cdf_status", arguments: {} });
    expect(JSON.stringify(result)).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(calls).toBe(1);
    expect(closes).toBe(2);
  });
});

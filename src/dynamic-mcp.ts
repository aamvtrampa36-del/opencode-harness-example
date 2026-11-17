import { createCodemodeModule } from "@cloudflare/computer";
import type { RemoteMcpConfig } from "./mcp-config";
import { createDynamicMcpHost } from "./dynamic-mcp-bridge";

/** Exposes existing configured MCP servers to Dynamic Worker code, retaining host-side auth. */
export function createDynamicMcpModule(loadConfigs: () => Promise<RemoteMcpConfig[]>) {
  const host = createDynamicMcpHost(loadConfigs);
  const module = createCodemodeModule({ description: host.description });
  module.context("state", host.createState, { scoped: true, dispose: host.dispose });
  return module.module(host.functions);
}

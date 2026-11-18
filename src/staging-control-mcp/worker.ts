import { env } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import {
  createStagingControlServer,
  SUPERVISOR_OBJECT,
  type StagingControlBindings,
  type StagingSupervisor
} from "./server";

type ControlEnv = {
  MCP_ENABLED?: string;
  STAGING_HEALTH: Fetcher;
  STAGING_SUPERVISOR: DurableObjectNamespace;
};

const controlEnv = env as unknown as ControlEnv;
const handler = createMcpHandler(() => {
  const bindings: StagingControlBindings = {
    readHealth: () => controlEnv.STAGING_HEALTH.fetch(new Request("https://staging.internal/api/health", {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-store" }
    })),
    supervisor: () => controlEnv.STAGING_SUPERVISOR.getByName(SUPERVISOR_OBJECT) as unknown as StagingSupervisor
  };
  return createStagingControlServer(bindings);
}, { route: "/mcp" });

export default {
  fetch(request: Request, _env: ControlEnv, ctx: ExecutionContext): Promise<Response> | Response {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (controlEnv.MCP_ENABLED !== "true") return new Response("Staging MCP is not enabled", { status: 503 });
    return handler(request, controlEnv, ctx);
  }
} satisfies ExportedHandler<ControlEnv>;

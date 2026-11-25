import { env } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { dispatchBoundedMcp } from "./p08-remote";
import {
  createStagingControlServer,
  SUPERVISOR_OBJECT,
  type StagingControlBindings,
  type StagingSupervisor
} from "./server";

type ControlEnv = {
  MCP_ENABLED?: string;
  OPENCODE_SUPERVISOR_PHASE_TELEMETRY?: string;
  STAGING_HEALTH: Fetcher;
  STAGING_SUPERVISOR: DurableObjectNamespace;
};

const controlEnv = env as unknown as ControlEnv;
const handler = createMcpHandler(() => {
  const bindings: StagingControlBindings = {
    phaseTelemetryEnabled: controlEnv.OPENCODE_SUPERVISOR_PHASE_TELEMETRY === "true",
    readHealth: () => controlEnv.STAGING_HEALTH.fetch(new Request("https://staging.internal/api/health", {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-store" }
    })),
    supervisor: workspace => {
      const name = workspace ?? SUPERVISOR_OBJECT;
      if (name !== SUPERVISOR_OBJECT &&
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(name)) {
        throw new Error("Solo se admite el workspace UUID exacto de Staging");
      }
      return controlEnv.STAGING_SUPERVISOR.getByName(name) as unknown as StagingSupervisor;
    }
  };
  return createStagingControlServer(bindings);
}, { route: "/mcp" });

export default {
  fetch(request: Request, _env: ControlEnv, ctx: ExecutionContext): Promise<Response> | Response {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (controlEnv.MCP_ENABLED !== "true") return new Response("Staging MCP is not enabled", { status: 503 });
    return dispatchBoundedMcp(request, bounded => handler(bounded, controlEnv, ctx));
  }
} satisfies ExportedHandler<ControlEnv>;

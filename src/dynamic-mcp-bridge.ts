import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFunctions
} from "@cloudflare/computer";
import type { RemoteMcpConfig } from "./mcp-config";

const MAX_TOOL_CALLS = 32;
const MAX_ARGUMENT_BYTES = 256_000;
const MAX_RESULT_BYTES = 1_000_000;

type McpClient = Pick<Client, "connect" | "close" | "listTools" | "callTool">;
type McpConnection = { client: McpClient };
type DynamicMcpState = {
  endpoints: RemoteMcpConfig[];
  connections: Map<string, Promise<McpConnection>>;
  calls: number;
};
type DynamicMcpContext = WorkspaceModuleCallContext & { state: Promise<DynamicMcpState> };
export type ConnectMcp = (endpoint: RemoteMcpConfig, signal: AbortSignal) => Promise<McpConnection>;

/** Cloudflare Workers only accepts `follow` or `manual`; manually reject redirects to keep auth local. */
export function createMcpFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Se bloqueó una redirección del servidor MCP.");
    }
    return response;
  };
}

async function connectMcp(endpoint: RemoteMcpConfig, signal: AbortSignal): Promise<McpConnection> {
  const client = new Client({ name: "opencode-dynamic-workers", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    fetch: createMcpFetch(),
    requestInit: {
      redirect: "manual",
      ...(endpoint.token ? { headers: { Authorization: `Bearer ${endpoint.token}` } } : {})
    }
  });
  try {
    await client.connect(transport, { signal });
    return { client };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw safeError(error, endpoint.token);
  }
}

function safeError(error: unknown, token?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = token ? message.split(token).join("[redacted]") : message;
  return new Error(redacted.slice(0, 400) || "Error MCP desconocido");
}

function scrubSecret(value: unknown, token?: string): unknown {
  if (typeof value === "string") return token ? value.split(token).join("[redacted]") : value;
  if (Array.isArray(value)) return value.map(item => scrubSecret(item, token));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubSecret(item, token)]));
  }
  return value;
}

function assertSmallJson(value: unknown, maxBytes: number, label: string): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error(`${label} debe ser JSON válido.`); }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new Error(`${label} supera el límite de ${maxBytes} bytes.`);
  }
}

function parseServer(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(value)) {
    throw new Error("Indica el id de un servidor MCP conectado.");
  }
  return value;
}

function parseToolName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Nombre de herramienta MCP inválido.");
  }
  return value;
}

function stateFor(context: WorkspaceModuleCallContext): Promise<DynamicMcpState> {
  return (context as DynamicMcpContext).state;
}

function visibleEndpoints(state: DynamicMcpState): RemoteMcpConfig[] {
  return state.endpoints.filter(endpoint => endpoint.enabled &&
    (endpoint.auth !== "oauth" || Boolean(endpoint.token)) &&
    (endpoint.auth !== "bearer" || Boolean(endpoint.token)));
}

function endpointFor(state: DynamicMcpState, id: string): RemoteMcpConfig {
  const endpoint = visibleEndpoints(state).find(item => item.id === id);
  if (!endpoint) throw new Error(`El servidor MCP ${id} no está conectado o habilitado.`);
  return endpoint;
}

async function clientFor(
  state: DynamicMcpState,
  endpoint: RemoteMcpConfig,
  context: WorkspaceModuleCallContext,
  connect: ConnectMcp
): Promise<McpClient> {
  let connection = state.connections.get(endpoint.id);
  if (!connection) {
    connection = connect(endpoint, context.signal);
    state.connections.set(endpoint.id, connection);
  }
  try {
    return (await connection).client;
  } catch (error) {
    state.connections.delete(endpoint.id);
    throw safeError(error, endpoint.token);
  }
}

function visibleTools(endpoint: RemoteMcpConfig, tools: Tool[]): Tool[] {
  if (!endpoint.toolAllowlist) return tools;
  const allowed = new Set(endpoint.toolAllowlist);
  return tools.filter(tool => allowed.has(tool.name));
}

/** Host-side factory is exported so its capability boundary can be tested without credentials. */
export function createDynamicMcpHost(
  loadConfigs: () => Promise<RemoteMcpConfig[]>,
  connect: ConnectMcp = connectMcp
) {
  const description = `MCP remoto desde código JavaScript dinámico. Importa funciones desde \`codemode:mcp\`:

\`servers()\` devuelve los ids y el modo de autenticación de servidores conectados.
\`tools({ server })\` descubre las herramientas de ese servidor (incluye inputSchema).
\`call({ server, name, arguments })\` llama una herramienta existente y devuelve su resultado estructurado.

Ejemplo:
\`import { servers, tools, call } from "codemode:mcp";\`
\`const list = await tools({ server: "cdf-workbench" });\`
\`const result = await call({ server: "cdf-workbench", name: "workbench_read", arguments: { path: "..." } });\`

Solo aparecen servidores habilitados. toolAllowlist se aplica también aquí. Los tokens nunca se entregan al código; cada servidor vuelve a comprobar sus credenciales y ámbitos MCP. Una ejecución puede realizar hasta ${MAX_TOOL_CALLS} llamadas a herramientas. Las escrituras siguen pasando por las herramientas MCP existentes.`;

  const createState = async () => ({
    endpoints: await loadConfigs(),
    connections: new Map<string, Promise<McpConnection>>(),
    calls: 0
  });
  const dispose = async (state: DynamicMcpState) => {
    await Promise.allSettled([...state.connections.values()].map(async pending => {
      const connection = await pending;
      await connection.client.close();
    }));
  };
  const functions: WorkspaceModuleFunctions = {
    servers: async (_args, context) => {
      const state = await stateFor(context);
      return visibleEndpoints(state).map(endpoint => ({
        id: endpoint.id,
        auth: endpoint.auth ?? (endpoint.token ? "bearer" : "none"),
        ...(endpoint.toolAllowlist ? { restrictedTo: [...endpoint.toolAllowlist] } : {})
      }));
    },
    tools: async (args, context) => {
      const input = args[0];
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("tools requiere { server }.");
      }
      const server = parseServer((input as Record<string, unknown>).server);
      const state = await stateFor(context);
      const endpoint = endpointFor(state, server);
      const client = await clientFor(state, endpoint, context, connect);
      try {
        const listed = await client.listTools({}, { signal: context.signal, timeout: 30_000, cacheMode: "refresh" });
        return visibleTools(endpoint, listed.tools).map(tool => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description.slice(0, 4_000) } : {}),
          inputSchema: tool.inputSchema
        }));
      } catch (error) {
        throw new Error(`No se pudieron consultar herramientas MCP de ${server}: ${safeError(error, endpoint.token).message}`);
      }
    },
    call: async (args, context) => {
      const input = args[0];
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("call requiere { server, name, arguments }.");
      }
      const fields = input as Record<string, unknown>;
      const server = parseServer(fields.server);
      const name = parseToolName(fields.name);
      const toolArguments = fields.arguments === undefined ? {} : fields.arguments;
      if (typeof toolArguments !== "object" || toolArguments === null || Array.isArray(toolArguments)) {
        throw new Error("arguments debe ser un objeto JSON.");
      }
      assertSmallJson(toolArguments, MAX_ARGUMENT_BYTES, "Los argumentos MCP");

      const state = await stateFor(context);
      const endpoint = endpointFor(state, server);
      if (endpoint.toolAllowlist && !endpoint.toolAllowlist.includes(name)) {
        throw new Error(`La herramienta ${name} no está en la lista permitida de ${server}.`);
      }
      if (state.calls >= MAX_TOOL_CALLS) {
        throw new Error(`La ejecución alcanzó el máximo de ${MAX_TOOL_CALLS} llamadas MCP.`);
      }
      state.calls++;
      const client = await clientFor(state, endpoint, context, connect);
      try {
        const result = await client.callTool({ name, arguments: toolArguments as Record<string, unknown> }, {
          signal: context.signal,
          timeout: Math.max(1, Math.min(30_000, context.deadline - Date.now()))
        });
        const output = scrubSecret({
          isError: Boolean(result.isError),
          content: result.content,
          ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {})
        }, endpoint.token);
        assertSmallJson(output, MAX_RESULT_BYTES, "El resultado MCP");
        return output;
      } catch (error) {
        throw new Error(`Falló ${server}.${name}: ${safeError(error, endpoint.token).message}`);
      }
    }
  };
  const direct = async (name: "servers" | "tools" | "call", input?: unknown) => {
    const state = await createState();
    const controller = new AbortController();
    const deadline = Date.now() + 30_000;
    const timer = setTimeout(() => controller.abort(new Error("MCP control call timed out")), 30_000);
    const context = {
      signal: controller.signal,
      deadline,
      access: "read" as const,
      callId: "remote-control",
      execution: { id: "remote-control", metadata: {} },
      resolvePath: async (path: string) => path,
      state: Promise.resolve(state)
    } as unknown as DynamicMcpContext;
    try {
      const operation = functions[name] as unknown as
        (args: readonly unknown[], ctx: WorkspaceModuleCallContext) => Promise<unknown>;
      return await operation(input === undefined ? [] : [input], context);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await dispose(state);
    }
  };
  return {
    description, functions, createState, dispose,
    listServers: () => direct("servers"),
    listTools: (server: string) => direct("tools", { server }),
    callTool: (input: { server: string; name: string; arguments?: Record<string, unknown> }) =>
      direct("call", input)
  };
}

/**
 * Minimal stateless MCP Streamable-HTTP adapter. No separate agent, storage,
 * shell, model, or arbitrary Worker URL. The ONLY DO is the fixed staging
 * supervisor instance in opencode-g1-staging, bound cross-script by Wrangler.
 *
 * MCP JSON-response mode: initialize, ping, tools/list, tools/call.
 * Notifications receive HTTP 202; GET/SSE is deliberately not supported.
 * Tool exceptions are structured isError results, never invented PASS.
 */
export const STAGING_MCP_NAME = "opencode-staging-debug-mcp-v2";
export const STAGING_SUPERVISOR_OBJECT = "opencode-supervisor-v1";
const ID = /^[a-f0-9]{16}$/;
const REPO = /^aamvtrampa36-del\/[A-Za-z0-9_.-]{1,100}$/;
const MODEL = ["economy", "cloudflare"];
const noFields = { type: "object", properties: {}, additionalProperties: false };
const obj = (properties, required = []) => ({
  type: "object", properties, required, additionalProperties: false
});
const str = (description, maxLength = 5000) =>
  ({ type: "string", description, maxLength });
const TASK = str("Identificador hexadecimal de 16 caracteres de una tarea de staging", 16);

export const TOOLS = [
  { name: "opencode_status", description: "Comprueba el supervisor OpenCode STAGING real y sus modelos", inputSchema: noFields, readOnly: true },
  { name: "opencode_sessions", description: "Enumera SOLO sesiones supervisadas del Durable Object de staging", inputSchema: noFields, readOnly: true },
  { name: "opencode_inspect", description: "Estado y fragmento limitado del historial real de la tarea supervisada", inputSchema: obj({ taskId: TASK }, ["taskId"]), readOnly: true },
  { name: "opencode_submit", description: "Crea UNA tarea de prueba aislada, rama de revisión y ejecución de OpenCode, con ID idempotente; consume inferencia económica", inputSchema: obj({
    requestId: str("ID hexadecimal único; repetir conserva la misma tarea", 16),
    repository: str("Repositorio GitHub aprobado (owner/repo)", 140),
    prompt: str("Tarea de depuración reversible: 12–5000 caracteres"),
    model: { type: "string", enum: MODEL, description: "Modelo nativo Workers AI; por defecto economy" }
  }, ["requestId", "repository", "prompt"]), readOnly: false },
  { name: "opencode_continue", description: "Continúa la MISMA conversación supervisada una sola vez con turnId idempotente", inputSchema: obj({
    taskId: TASK, turnId: str("ID hexadecimal único del turno", 16),
    prompt: str("Instrucción de seguimiento de 12–5000 caracteres")
  }, ["taskId", "turnId", "prompt"]), readOnly: false },
  { name: "opencode_operation", description: "Consulta estado y herramientas reales SIN reenviar la instrucción", inputSchema: obj({ taskId: TASK }, ["taskId"]), readOnly: true },
  { name: "opencode_select_model", description: "Cambia modelo nativo SOLO si la sesión supervisada está libre", inputSchema: obj({
    taskId: TASK, model: { type: "string", enum: MODEL }
  }, ["taskId", "model"]), readOnly: false },
  { name: "opencode_review", description: "Lee el diff de GitHub de la rama aislada. NUNCA aprueba ni fusiona", inputSchema: obj({ taskId: TASK }, ["taskId"]), readOnly: true },
  { name: "opencode_cancel", description: "Cancela únicamente la tarea supervisada indicada", inputSchema: obj({ taskId: TASK }, ["taskId"]), readOnly: false }
];

const names = new Map(TOOLS.map(x => [x.name, x]));
const json = (data, status = 200) => Response.json(data, {
  status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  }
});
const rpc = (id, result) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const secureEqual = async (a, b) => {
  const hash = async x => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
};
export async function authorized(request, token) {
  if (typeof token !== "string" || !/^[^\s]{32,256}$/.test(token)) return "unconfigured";
  const match = /^Bearer ([^\s]{32,256})$/.exec(request.headers.get("Authorization") ?? "");
  return match && await secureEqual(match[1], token) ? "authorized" : "denied";
}
function validate(name, args) {
  const tool = names.get(name);
  if (!tool) throw new Error("Herramienta MCP no reconocida");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Argumentos inválidos");
  const schema = tool.inputSchema;
  if (Object.keys(args).some(k => !Object.prototype.hasOwnProperty.call(schema.properties, k))) {
    throw new Error("Parámetros desconocidos o destino no autorizado");
  }
  for (const field of schema.required ?? []) if (!(field in args)) throw new Error("Falta " + field);
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") throw new Error("Campo no textual: " + key);
    const spec = schema.properties[key];
    if (value.length > (spec.maxLength ?? 5000)) throw new Error("Campo demasiado largo: " + key);
    if (spec.enum && !spec.enum.includes(value)) throw new Error("Valor no admitido: " + key);
  }
  if (args.taskId && !ID.test(args.taskId)) throw new Error("taskId inválido");
  if (args.requestId && !ID.test(args.requestId)) throw new Error("requestId inválido");
  if (args.turnId && !ID.test(args.turnId)) throw new Error("turnId inválido");
  if (args.repository && !REPO.test(args.repository)) throw new Error("Repositorio no admitido");
  if ((name === "opencode_submit" || name === "opencode_continue") &&
      (args.prompt?.trim().length < 12 || args.prompt?.length > 5000)) {
    throw new Error("La instrucción debe tener 12–5000 caracteres");
  }
  return args;
}
const asText = x => JSON.stringify(x).slice(0, 24_000);
export async function dispatchTool(stub, name, raw) {
  const a = validate(name, raw ?? {});
  switch (name) {
    case "opencode_status": return stub.remoteSupervisorStatus();
    case "opencode_sessions": return stub.remoteSupervisorSessions();
    case "opencode_inspect": return stub.remoteSupervisorInspect(a.taskId);
    case "opencode_submit": return stub.startSupervisedTask({
      requestId: a.requestId, repository: a.repository,
      prompt: a.prompt, ...(a.model ? { model: a.model } : {})
    });
    case "opencode_continue": return stub.remoteSupervisorContinue({
      id: a.taskId, turnId: a.turnId, prompt: a.prompt
    });
    case "opencode_operation": return stub.supervisedTaskStatus(a.taskId);
    case "opencode_select_model": return stub.remoteSupervisorSelectModel(a.taskId, a.model);
    case "opencode_review": return stub.supervisedTaskReview(a.taskId);
    case "opencode_cancel": return stub.cancelSupervisedTask(a.taskId);
    default: throw new Error("Herramienta desconocida");
  }
}
/** Exported for deterministic Bun tests with a mock STAGING_AGENT binding. */
export async function handleMcp(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
  const auth = await authorized(request, env?.MCP_TOKEN);
  if (auth === "unconfigured") return json({ error: "MCP_DISABLED_NO_AUTH_SECRET" }, 503);
  if (auth !== "authorized") return json({ error: "Unauthorized" }, 401);
  if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) {
    return json({ error: "Origin denied" }, 403);
  }
  if (request.method === "GET" || request.method === "DELETE") return new Response(null, { status: 405 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "JSON required" }, 415);
  }
  const raw = await request.text();
  if (raw.length > 24_000) return json({ error: "MCP_PAYLOAD_TOO_LARGE" }, 413);
  let message;
  try { message = JSON.parse(raw); }
  catch { return rpcError(null, -32700, "Invalid JSON"); }
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id, -32600, "Invalid MCP JSON-RPC request");
  }
  if (message.id === undefined) {
    if (message.method === "notifications/initialized" || message.method.startsWith("notifications/")) {
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 202 });
  }
  const { id, method } = message;
  if (method === "initialize") {
    return rpc(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: STAGING_MCP_NAME, version: "0.1.0" },
      instructions: "Staging-only. No production endpoints, GitHub merge, or deployment tools."
    });
  }
  if (method === "ping") return rpc(id, {});
  if (method === "tools/list") {
    return rpc(id, { tools: TOOLS.map(t => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: false }
    })) });
  }
  if (method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (typeof name !== "string" || !names.has(name)) return rpcError(id, -32602, "Unknown tool");
    try {
      if (!env?.STAGING_AGENT?.getByName) throw new Error("STAGING_DO_BINDING_MISSING");
      const stub = env.STAGING_AGENT.getByName(STAGING_SUPERVISOR_OBJECT);
      const result = await dispatchTool(stub, name, args);
      return rpc(id, { content: [{ type: "text", text: asText(result) }] });
    } catch (error) {
      return rpc(id, { isError: true, content: [{ type: "text",
        text: error instanceof Error ? error.message.slice(0, 450) : "MCP operation failed" }] });
    }
  }
  return rpcError(id, -32601, "Method not found");
}
export default { fetch: handleMcp };

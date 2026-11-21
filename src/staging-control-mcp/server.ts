import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { renderConversationMarkdown } from "../session-export";
import { MODEL_PRESETS } from "../model-presets";
import { BUN_RUNTIME_VERSION } from "../dev-runtime";

export const STAGING_WORKER = "opencode-g1-staging";
export const STAGING_REPOSITORY = "aamvtrampa36-del/opencode-harness-example";
export const SUPERVISOR_OBJECT = "opencode-supervisor-v1";
export const STAGING_OPENROUTER_MODEL = MODEL_PRESETS.review.id;

const WORKSPACE_HINT = "Omite workspace para el supervisor fijo; usa el UUID exacto solo para un workspace personalizado.";

export interface StagingSupervisor {
  remoteSupervisorStatus(): Promise<unknown>;
  startSupervisedTask(input: unknown): Promise<unknown>;
  supervisedTaskStatus(id: string): Promise<unknown>;
  remoteSupervisorProgress(id: string, after?: number): Promise<unknown>;
  remoteSupervisorContinue(input: unknown): Promise<unknown>;
  remoteSupervisorSelectModel(id: string, model: string): Promise<unknown>;
  remoteSupervisorModels(): Promise<unknown>;
  remoteSupervisorRepositories(): Promise<unknown>;
  remoteSupervisorSessions(): Promise<unknown>;
  remoteSupervisorInspectSession(id: string): Promise<unknown>;
  remoteSupervisorMcpServers(): Promise<unknown>;
  remoteSupervisorMcpTools(server: string): Promise<unknown>;
  remoteSupervisorMcpCall(input: { server: string; name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  remoteSupervisorDiagnostics(): Promise<unknown>;
  remoteSupervisorAgentCheck(model: "cloudflare" | "economy" | "review", kind: "linux" | "repair" | "bun"): Promise<unknown>;
  remoteSupervisorAgentCheckStatus(scope?: "openrouter"): Promise<unknown>;
  cancelSupervisedTask(id: string): Promise<unknown>;
  supervisedTaskReview(id: string): Promise<unknown>;
  supervisedTaskTranscript(id: string): Promise<string>;
  startAgentCheck(model: "review", kind: "bun", scope?: "openrouter"): Promise<unknown>;
}

export interface StagingControlBindings {
  readHealth(): Promise<Response>;
  supervisor(workspace?: string): StagingSupervisor;
}

const taskIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const workspaceSchema = z.string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i)
  .describe(WORKSPACE_HINT)
  .optional();
const sessionIdSchema = z.string().regex(/^ses[A-Za-z0-9_]{1,64}$/);

function redactString(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTADO]")
    .replace(/\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{12,}\b/g, "[REDACTADO]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTADO]")
    .replace(/\bBearer\s+[A-Za-z0-9_.~+/-]+/gi, "Bearer [REDACTADO]")
    .replace(/((?:api[_-]?key|password|passphrase|token|secret|authorization|cookie)\s*[:=]\s*["']?)([^\s,;"']+)/gi, "$1[REDACTADO]");
}

const SECRET_FIELD = /(^|[_.\s-])(password|passphrase|token|secret|authorization|cookie|credential|api[_-]?key|private[_-]?key)([_.\s-]|$)/i;

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 24) return "[profundidad omitida]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(item => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      safe[key] = SECRET_FIELD.test(key) ? "[REDACTADO]" : safeValue(item, depth + 1);
    }
    return safe;
  }
  return value;
}

type JsonClip = { value: unknown; truncated: boolean };

function clipJsonValue(
  value: unknown, limits: { stringChars: number; arrayItems: number; objectKeys: number; depth: number },
  depth = 0
): JsonClip {
  if (depth > limits.depth) return { value: "[profundidad recortada]", truncated: true };
  if (typeof value === "string") {
    if (value.length <= limits.stringChars) return { value, truncated: false };
    const marker = "[recortado]";
    return { value: value.slice(0, Math.max(0, limits.stringChars - marker.length)) + marker, truncated: true };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, limits.arrayItems).map(item => clipJsonValue(item, limits, depth + 1));
    return { value: items.map(item => item.value),
      truncated: value.length > limits.arrayItems || items.some(item => item.truncated) };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const clipped: Record<string, unknown> = {};
    let truncated = entries.length > limits.objectKeys;
    for (const [key, item] of entries.slice(0, limits.objectKeys)) {
      const child = clipJsonValue(item, limits, depth + 1);
      clipped[key] = child.value;
      truncated ||= child.truncated;
    }
    return { value: clipped, truncated };
  }
  return { value, truncated: false };
}

function jsonText(value: unknown, maxChars = 16_000): string {
  const safe = safeValue(value);
  const json = JSON.stringify(safe, null, 2) ?? "null";
  if (json.length <= maxChars) return json;

  const limits = [
    { stringChars: 2048, arrayItems: 64, objectKeys: 64, depth: 16 },
    { stringChars: 1024, arrayItems: 32, objectKeys: 32, depth: 12 },
    { stringChars: 512, arrayItems: 16, objectKeys: 16, depth: 10 },
    { stringChars: 256, arrayItems: 8, objectKeys: 12, depth: 8 },
    { stringChars: 64, arrayItems: 4, objectKeys: 8, depth: 6 },
    { stringChars: 16, arrayItems: 0, objectKeys: 4, depth: 4 }
  ];
  for (const limit of limits) {
    const clipped = clipJsonValue(safe, limit);
    let candidate = clipped.value;
    if (clipped.truncated && candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      candidate = { ...(candidate as Record<string, unknown>), _responseTruncated: true };
    }
    const bounded = JSON.stringify(candidate, null, 2) ?? "null";
    if (bounded.length <= maxChars) return bounded;
  }
  return JSON.stringify({ _responseTruncated: true, message: "Resultado omitido por límite de tamaño" });
}

function result(value: unknown, maxChars?: number) {
  return { content: [{ type: "text" as const, text: jsonText(value, maxChars) }] };
}

function failed(error: unknown) {
  const message = error instanceof Error ? redactString(error.message).slice(0, 500) : "Error del control de staging";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createStagingControlServer(bindings: StagingControlBindings): McpServer {
  const server = new McpServer({ name: "opencode-staging-control", version: "2.0.0" });

  server.registerTool("staging_status", {
    description: "Lee el estado HTTP de OpenCode Staging. Solo consulta opencode-g1-staging; no inicia tareas.",
    inputSchema: {}
  }, async () => {
    try {
      const response = await bindings.readHealth();
      if (!response.ok) throw new Error(`OpenCode Staging respondió HTTP ${response.status}`);
      const health: unknown = await response.json();
      const status = health && typeof health === "object" && "status" in health
        ? (health as { status?: unknown }).status : "unknown";
      const supervisor = asRecord(await bindings.supervisor().remoteSupervisorStatus());
      const payload = { targetWorker: STAGING_WORKER, status, health, supervisor };
      return status === "ok" ? result(payload) : { ...result(payload), isError: true };
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("staging_models", {
    description: "Descubre modelos que la instalación OpenCode de Staging puede seleccionar ahora. Cloudflare economy es el predeterminado; OpenRouter solo se muestra si está configurado. No devuelve claves.",
    inputSchema: {}
  }, async () => callTask(() => bindings.supervisor().remoteSupervisorModels()));

  server.registerTool("staging_repositories", {
    description: "Lista los repositorios del propietario ya autorizados en OpenCode Settings para tareas supervisadas.",
    inputSchema: {}
  }, async () => callTask(() => bindings.supervisor().remoteSupervisorRepositories()));

  server.registerTool("staging_sessions", {
    description: "Lista IDs, estado y título de sesiones OpenCode dentro del workspace Staging indicado. No enumera otros Durable Objects; para consultar un workspace de interfaz se requiere su UUID exacto.",
    inputSchema: { workspace: workspaceSchema }
  }, async ({ workspace }) => callTask(() => bindings.supervisor(workspace).remoteSupervisorSessions()));

  server.registerTool("staging_session_inspect", {
    description: "Inspecciona una sesión exacta dentro de un workspace Staging. Devuelve alcance del proyecto y un extracto sanitizado, sin razonamiento interno ni credenciales.",
    inputSchema: { workspace: workspaceSchema, session: sessionIdSchema }
  }, async ({ workspace, session }) =>
    callTask(() => bindings.supervisor(workspace).remoteSupervisorInspectSession(session), 16_000));

  server.registerTool("staging_mcp_servers", {
    description: "Descubre los servidores MCP habilitados en la configuración existente de OpenCode. La autenticación permanece en Cloudflare y se aplican las allowlists guardadas.",
    inputSchema: {}
  }, async () => callTask(() => bindings.supervisor().remoteSupervisorMcpServers()));

  server.registerTool("staging_mcp_tools", {
    description: "Descubre dinámicamente el esquema de herramientas de un servidor MCP habilitado y autorizado.",
    inputSchema: { server: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/) }
  }, async ({ server }) => callTask(() => bindings.supervisor().remoteSupervisorMcpTools(server)));

  server.registerTool("staging_mcp_call", {
    description: "Ejecuta una herramienta MCP dinámica ya habilitada en OpenCode, respetando su toolAllowlist, permisos y autenticación existente. La herramienta remota puede cambiar datos según sus propios permisos; revisa primero su esquema y alcance. No expone tokens.",
    inputSchema: {
      server: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      arguments: z.record(z.string(), z.unknown()).optional()
    }
  }, async ({ server, name, arguments: toolArguments }) =>
    callTask(() => bindings.supervisor().remoteSupervisorMcpCall({ server, name, arguments: toolArguments ?? {} })));

  server.registerTool("staging_diagnostics", {
    description: "Consulta salud e incidentes estructurados de Staging. Para logs, CPU, latencia y fallos del Worker usa también Cloudflare Observability como vía independiente.",
    inputSchema: {}
  }, async () => callTask(() => bindings.supervisor().remoteSupervisorDiagnostics()));

  server.registerTool("staging_agent_check", {
    description: "Inicia una autoprueba real aislada de OpenCode: reparación red-to-green, Linux o Bun. Default económico; no modifica el repositorio ni GitHub.",
    inputSchema: {
      model: z.enum(["economy", "cloudflare", "review"]).default("economy"),
      kind: z.enum(["repair", "linux", "bun"]).default("repair")
    }
  }, async ({ model, kind }) => callTask(() => bindings.supervisor().remoteSupervisorAgentCheck(model, kind)));

  server.registerTool("staging_agent_check_status", {
    description: "Consulta el resultado real de la última autoprueba aislada; incluye evidencia de llamadas Linux y verificación independiente del archivo.",
    inputSchema: {}
  }, async () => callTask(() => bindings.supervisor().remoteSupervisorAgentCheckStatus()));

  server.registerTool("staging_openrouter_check", {
    description: `Inicia una autoprueba real en Staging con OpenRouter (${STAGING_OPENROUTER_MODEL}), Bun 1.4.4 y la herramienta Linux. Valida conexión del proveedor, llamada de modelo, versión del runtime y escritura/verificación de un archivo temporal aislado. Consume inferencia y CPU; no modifica el repositorio ni GitHub.`,
    inputSchema: {}
  }, async () => {
    try {
      const started = asRecord(await bindings.supervisor().startAgentCheck("review", "bun", "openrouter"));
      return result({
        ...started,
        requestedModel: STAGING_OPENROUTER_MODEL,
        provider: "openrouter",
        targetWorker: STAGING_WORKER
      });
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("staging_openrouter_check_status", {
    description: "Consulta la última autoprueba OpenRouter + Linux de Staging. Incluye estado, preset elegido, número real de llamadas a herramientas y verificación del archivo temporal; nunca devuelve credenciales.",
    inputSchema: {}
  }, async () => {
    try {
      const check = asRecord(await bindings.supervisor().remoteSupervisorAgentCheckStatus("openrouter"));
      const modelVerified = check.model === "review" && check.kind === "bun" &&
        check.providerID === "openrouter" && check.providerModel === STAGING_OPENROUTER_MODEL;
      const runtimeVerified = check.kind === "bun" && check.bunVersion === BUN_RUNTIME_VERSION &&
        check.runtimeVerified === true;
      const toolProofVerified = check.status === "passed" && modelVerified && runtimeVerified &&
        check.fileVerified === true && typeof check.toolCalls === "number" && check.toolCalls >= 1;
      const status = check.status === "passed" && !toolProofVerified ? "failed" : check.status;
      const reason = check.status === "passed" && !toolProofVerified
        ? check.reason ?? "La prueba no acreditó el proveedor/modelo OpenRouter, Bun y la ejecución Linux esperados."
        : check.reason;
      return result({
        ...check,
        status,
        ...(reason ? { reason } : {}),
        provider: check.providerID,
        modelVerified,
        toolProofVerified,
        expectedModel: STAGING_OPENROUTER_MODEL,
        expectedProvider: "openrouter",
        expectedBunVersion: BUN_RUNTIME_VERSION,
        runtimeVerified: runtimeVerified && check.status === "passed",
        targetWorker: STAGING_WORKER
      });
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("staging_start_task", {
    description: "Inicia una tarea real de OpenCode en Staging. Por defecto usa Cloudflare económico y una sesión aislada. Puede seleccionar un repositorio/modelo autorizados o hacer fork de una sesión solo si se proporcionan el UUID exacto de un workspace personalizado y el session ID exactos. La respuesta omite workspace para el supervisor fijo y conserva el UUID en un fork explícito. Un fork hereda la conversación; el Container parte limpio del commit de GitHub fijado. requestId hace idempotentes los reintentos. No fusiona ni despliega.",
    inputSchema: {
      requestId: z.string().regex(/^[a-f0-9]{16}$/).describe("ID único idempotente, exactamente 16 caracteres hexadecimales en minúscula"),
      prompt: z.string().min(12).max(5000).describe("Objetivo de ingeniería, entre 12 y 5000 caracteres"),
      repository: z.string().min(3).max(120).optional().describe("Repositorio del propietario ya autorizado en OpenCode Settings"),
      model: z.string().min(1).max(160).optional().describe("Selección del catálogo OpenCode; por defecto economy"),
      workspace: workspaceSchema.describe("UUID exacto de un workspace personalizado que contiene la sesión de origen; omítelo para el supervisor fijo"),
      sourceSession: sessionIdSchema.optional().describe("Session ID exacto para crear un fork; requiere workspace")
    }
  }, async ({ requestId, prompt, repository, model, workspace, sourceSession }) => {
    try {
      if (sourceSession && !workspace) throw new Error("Un fork requiere el UUID exacto del workspace");
      if (workspace && !sourceSession) throw new Error("El workspace solo se admite para hacer un fork explícito");
      const supervisor = bindings.supervisor(workspace);
      const task = asRecord(await supervisor.startSupervisedTask({
        requestId, repository: repository ?? STAGING_REPOSITORY, prompt,
        ...(model ? { model } : {}), ...(sourceSession ? { sourceSession } : {})
      }));
      const current = task.reused === true && typeof task.id === "string"
        ? asRecord(await supervisor.supervisedTaskStatus(task.id))
        : undefined;
      const payload: Record<string, unknown> = current
        ? { ...task, ...current, reused: true }
        : { ...task };
      if (workspace) payload.workspace = workspace;
      else delete payload.workspace;
      return result({ ...payload, targetWorker: STAGING_WORKER });
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("staging_task_status", {
    description: `Consulta una tarea supervisada de Staging por su ID hexadecimal de 16 caracteres. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres"), workspace: workspaceSchema }
  }, async ({ id, workspace }) => callTask(() => bindings.supervisor(workspace).supervisedTaskStatus(id)));

  server.registerTool("staging_task_progress", {
    description: `Lee eventos duraderos de progreso desde un cursor. Solo devuelve secuencia y tipo de evento; no incluye razonamiento interno. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema, workspace: workspaceSchema, after: z.number().int().min(0).default(0) }
  }, async ({ id, workspace, after }) =>
    callTask(() => bindings.supervisor(workspace).remoteSupervisorProgress(id, after)));

  server.registerTool("staging_task_continue", {
    description: `Envía una nueva instrucción para continuar o corregir una tarea. turnId hace idempotentes los reintentos; una instrucción sobre una tarea activa se aplica como steer. ${WORKSPACE_HINT}`,
    inputSchema: {
      id: taskIdSchema, workspace: workspaceSchema,
      turnId: z.string().regex(/^[a-f0-9]{16}$/), prompt: z.string().min(12).max(5000)
    }
  }, async ({ id, workspace, turnId, prompt }) =>
    callTask(() => bindings.supervisor(workspace).remoteSupervisorContinue({ id, turnId, prompt })));

  server.registerTool("staging_task_select_model", {
    description: `Selecciona un modelo del catálogo para los siguientes turnos de una tarea inactiva. El proveedor debe estar configurado en Staging. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema, workspace: workspaceSchema, model: z.string().min(1).max(160) }
  }, async ({ id, workspace, model }) =>
    callTask(() => bindings.supervisor(workspace).remoteSupervisorSelectModel(id, model)));

  server.registerTool("staging_cancel_task", {
    description: `Solicita la cancelación de una tarea supervisada de Staging por su ID. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres"), workspace: workspaceSchema }
  }, async ({ id, workspace }) => callTask(() => bindings.supervisor(workspace).cancelSupervisedTask(id)));

  server.registerTool("staging_review_task", {
    description: `Ejecuta la revisión GitHub existente para la rama bloqueada de una tarea de Staging. No aprueba ni fusiona cambios. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres"), workspace: workspaceSchema }
  }, async ({ id, workspace }) => callTask(() => bindings.supervisor(workspace).supervisedTaskReview(id), 16_000));

  server.registerTool("staging_task_transcript", {
    description: `Lee los últimos 20 mensajes de una tarea de Staging, sin razonamiento interno y con claves/tokens redactados. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres"), workspace: workspaceSchema }
  }, async ({ id, workspace }) => {
    try {
      const supervisor = bindings.supervisor(workspace);
      const task = asRecord(await supervisor.supervisedTaskStatus(id));
      if (typeof task.session !== "string") throw new Error("La tarea de Staging todavía no tiene una sesión disponible");
      const raw = await supervisor.supervisedTaskTranscript(id);
      const transcript: unknown = JSON.parse(raw);
      if (!transcript || typeof transcript !== "object" || !Array.isArray((transcript as { messages?: unknown }).messages)) {
        throw new Error("La transcripción de Staging no tiene un formato válido");
      }
      const data = transcript as { messages: unknown[]; project?: unknown; repository?: unknown };
      const markdown = renderConversationMarkdown(task.session, {
        ...data,
        messages: data.messages.slice(-20)
      });
      const clipped = markdown.length <= 20_000 ? markdown : markdown.slice(-20_000) + "\n[Transcripción recortada]";
      return { content: [{ type: "text" as const, text: `Destino: ${STAGING_WORKER}\nTarea: ${id}\n\n${clipped}` }] };
    } catch (error) {
      return failed(error);
    }
  });

  return server;
}

async function callTask(operation: () => Promise<unknown>, maxChars?: number) {
  try {
    return result({ ...asRecord(await operation()), targetWorker: STAGING_WORKER }, maxChars);
  } catch (error) {
    return failed(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : { result: value };
}

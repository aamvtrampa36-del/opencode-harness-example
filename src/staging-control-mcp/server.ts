import { boundedMcpJsonText, redactMcpString } from "./bounded-response";
import { readOnlyStartFields } from "./start-contract";
import { createSupervisorMemoryProbe } from "../supervisor-phase-telemetry";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MODEL_PRESETS } from "../model-presets";
import { BUN_RUNTIME_VERSION } from "../dev-runtime";
import {
  buildIncidentDiagnostics, DIAGNOSTICS_DEFAULT_LIMIT,
  type IncidentRecord
} from "../incident-diagnostics";

export const STAGING_WORKER = "opencode-g1-staging";
export const STAGING_REPOSITORY = "aamvtrampa36-del/opencode-harness-example";
export const SUPERVISOR_OBJECT = "opencode-supervisor-v1";
export const STAGING_OPENROUTER_MODEL = MODEL_PRESETS.review.id;

const WORKSPACE_HINT = "Omite workspace para el supervisor fijo; usa el UUID exacto solo para un workspace personalizado.";

export interface StagingSupervisor {
  remoteSupervisorStatus(): Promise<unknown>;
  startSupervisedTask(input: unknown): Promise<unknown>;
  supervisedTaskStatus(id: string): Promise<unknown>;
  /** Read-only ledger snapshot. Never silently downgrade to the mutating status RPC. */
  remoteSupervisorTaskStatusSnapshot?(id: string): Promise<unknown>;
  /** Optional during rollout; the Worker remains backward compatible with older supervisor versions. */
  supervisedTaskArtifacts?(id: string): Promise<unknown>;
  supervisedArtifactCapture?(id: string, raw: unknown): Promise<unknown>;
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
  remoteSupervisorReconcile?():Promise<unknown>;
  remoteSupervisorAgentCheck(model: "cloudflare" | "economy" | "review", kind: "linux" | "repair" | "bun"): Promise<unknown>;
  remoteSupervisorAgentCheckStatus(scope?: "openrouter"): Promise<unknown>;
  cancelSupervisedTask(id: string): Promise<unknown>;
  supervisedTaskReview(id: string): Promise<unknown>;
  supervisedTaskTranscript(id: string): Promise<string>;
  startAgentCheck(model: "review", kind: "bun", scope?: "openrouter"): Promise<unknown>;
}

export interface StagingControlBindings {
  /** Optional: never enable phase telemetry unless both workers are explicitly configured. */
  phaseTelemetryEnabled?: boolean;
  readHealth(): Promise<Response>;
  supervisor(workspace?: string): StagingSupervisor;
}

const taskIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const workspaceSchema = z.string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i)
  .describe(WORKSPACE_HINT)
  .optional();
const sessionIdSchema = z.string().regex(/^ses[A-Za-z0-9_]{1,64}$/);

function result(value: unknown, maxChars?: number, supervisorTask = false) {
  return { content: [{ type: "text" as const, text: boundedMcpJsonText(value, maxChars, undefined, supervisorTask) }] };
}

function failed(error: unknown) {
  const raw = error instanceof Error ? error.message : "MCP_OPERATION_FAILED";
  // Never stringify an arbitrarily large thrown Error or copy a token prefix.
  const message = raw.length > 500 ? "MCP_ERROR_MESSAGE_TOO_LARGE" : redactMcpString(raw);
  const code = /^[A-Z][A-Z0-9_]{3,90}$/.test(message) ? message : "MCP_OPERATION_FAILED";
  return { content: [{ type: "text" as const, text: boundedMcpJsonText({
    status: "unknown", code, error: code, message, reviewRequired: true,
    passed: false, verified: false
  }, 1500, STAGING_WORKER, true) }], isError: true };
}

export function createStagingControlServer(bindings: StagingControlBindings): McpServer {
  const server = new McpServer({ name: "opencode-staging-control", version: "2.0.0" });
  const callTask = (operation: () => Promise<unknown>, maxChars?: number, supervisorTask = false) =>
    callTaskWithProbe(operation, maxChars, bindings.phaseTelemetryEnabled === true, supervisorTask);

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

  server.registerTool("staging_reconcile",{
    description:"Ruta anterior de reconciliación. R4 exige el Workflow privado de la cuenta Cloudflare; esta ruta no acepta evidencia de drenaje.",
    inputSchema:{}
  },async()=>callTask(async()=>{
    const supervisor=bindings.supervisor();
    if(!supervisor.remoteSupervisorReconcile)throw Error("HISTORICAL_RECONCILIATION_UNAVAILABLE");
    return supervisor.remoteSupervisorReconcile();
  }));

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
    description: "Consulta salud e incidentes estructurados de Staging. Devuelve una proyección acotada con summary y hasMore (no es paginación), y cada incidente incluye taskId cuando pudo correlacionarse. Para logs, CPU, latencia y fallos del Worker usa también Cloudflare Observability como vía independiente.",
    inputSchema: {
      limit: z.number().int().min(1).max(64).default(DIAGNOSTICS_DEFAULT_LIMIT)
        .describe("Máximo de incidentes devueltos (1-64). Acota la respuesta; no pagina ni cambia los totales del summary")
    }
  }, async ({ limit }) => {
    try {
      const raw = asRecord(await bindings.supervisor().remoteSupervisorDiagnostics());
      const records: IncidentRecord[] = Array.isArray(raw.incidents)
        ? raw.incidents.filter((item): item is IncidentRecord =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : [];
      const view = buildIncidentDiagnostics(records, limit);
      return result({
        ...raw,
        incidents: view.incidents,
        summary: view.summary,
        hasMore: view.hasMore,
        omitted: view.omitted,
        order: view.order,
        correlation: {
          field: "taskId",
          equalsRequestId: true,
          derivation: "ledger taskId when present, else the deterministic supervised project name supervised-<requestId>",
          note: "taskId es el mismo valor hexadecimal de 16 caracteres que staging_start_task devolvió como requestId. Se toma del registro cuando existe y, si no, del proyecto determinista supervised-<requestId>. null significa que el incidente no pudo correlacionarse con una tarea supervisada.",
          next: [
            "staging_task_status { id: <taskId> }",
            "staging_task_transcript { id: <taskId> }",
            "staging_task_progress { id: <taskId>, after: 0 }"
          ]
        }
      }, 64_000);
    } catch (error) {
      return failed(error);
    }
  });

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
    description: "Inicia una tarea real de OpenCode en Staging. Por defecto usa Cloudflare económico y una sesión aislada. Puede seleccionar un repositorio/modelo autorizados o hacer fork de una sesión solo si se proporcionan el UUID exacto de un workspace personalizado y el session ID exactos. La respuesta omite workspace para el supervisor fijo y conserva el UUID en un fork explícito. Un fork hereda la conversación; el Container parte limpio del commit de GitHub fijado. requestId hace idempotentes los reintentos. read_only requiere sourceCommit y sourceTree exactos, sin workspace/fork. La aceptación puede devolver preparing: consulta staging_task_status; no significa ejecución ni resultado verificado. No fusiona ni despliega.",
    inputSchema: {
      requestId: z.string().regex(/^[a-f0-9]{16}$/).describe("ID único idempotente, exactamente 16 caracteres hexadecimales en minúscula"),
      prompt: z.string().min(12).max(5000).describe("Objetivo de ingeniería, entre 12 y 5000 caracteres"),
      repository: z.string().min(3).max(120).optional().describe("Repositorio del propietario ya autorizado en OpenCode Settings"),
      model: z.string().min(1).max(160).optional().describe("Selección del catálogo OpenCode; por defecto economy"),
      workspace: workspaceSchema.describe("UUID exacto de un workspace personalizado que contiene la sesión de origen; omítelo para el supervisor fijo"),
      sourceSession: sessionIdSchema.optional().describe("Session ID exacto para crear un fork; requiere workspace; el backend rechaza forks nuevos sin idempotencia"),
      mode: z.literal("read_only").optional().describe("Solo lectura; exige commit y árbol fijados"),
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).optional().describe("Commit exacto, 40 hex minúsculas"),
      sourceTree: z.string().regex(/^[a-f0-9]{40}$/).optional().describe("Árbol Git exacto, 40 hex minúsculas")
    }
  }, async ({ requestId, prompt, repository, model, workspace, sourceSession, mode, sourceCommit, sourceTree }) => {
    try {
      const pins = readOnlyStartFields({ mode, sourceCommit, sourceTree, workspace, sourceSession });
      if (sourceSession && !workspace) throw new Error("Un fork requiere el UUID exacto del workspace");
      if (workspace && !sourceSession) throw new Error("El workspace solo se admite para hacer un fork explícito");
      const supervisor = bindings.supervisor(workspace);
      const task = asRecord(await supervisor.startSupervisedTask({
        requestId, repository: repository ?? STAGING_REPOSITORY, prompt,
        ...(model ? { model } : {}), ...(sourceSession ? { sourceSession } : {}), ...pins
      }));
      // The read_only backend returns a durable admission receipt before import.
      // Never refresh a reused read_only start via the blocking legacy status RPC.
      const current = pins.mode !== "read_only" && task.reused === true && typeof task.id === "string"
        ? asRecord(await supervisor.supervisedTaskStatus(task.id))
        : undefined;
      const payload: Record<string, unknown> = current
        ? { ...task, ...current, reused: true }
        : { ...task };
      if (workspace) payload.workspace = workspace;
      else delete payload.workspace;
      return result({ ...payload, targetWorker: STAGING_WORKER }, undefined, true);
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("staging_task_status", {
    description: `Snapshot durable de una tarea: SOLO LECTURA, sin espera SDK, no certifica finalización ni PASS. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres"), workspace: workspaceSchema }
  }, async ({ id, workspace }) => callTask(async () => {
    const supervisor = bindings.supervisor(workspace);
    if (!supervisor.remoteSupervisorTaskStatusSnapshot)
      throw new Error("SUPERVISOR_STATUS_SNAPSHOT_UNAVAILABLE_OLD_WORKER");
    return supervisor.remoteSupervisorTaskStatusSnapshot(id);
  }, undefined, true));

  server.registerTool("staging_task_artifacts", {
    description: "Lista un manifiesto acotado de archivos realmente capturados para una tarea supervisada. No obtiene un transcript ni convierte rutas internas en descargas. La ruta HTTP requiere Cloudflare Access y bearer; no es una URL pública.",
    inputSchema: { id: taskIdSchema }
  }, async ({ id }) => callTask(async () => {
    const supervisor = bindings.supervisor();
    if (!supervisor.supervisedTaskArtifacts) throw new Error("ARTIFACT_BACKEND_UNAVAILABLE");
    return supervisor.supervisedTaskArtifacts(id);
  }, undefined, true));

  server.registerTool("staging_capture_task_artifact", {
    description: "CAPTURA CON EFECTO: crea una copia inmutable de un archivo de texto existente del proyecto de una tarea TERMINADA. Ejecuta inspección Linux acotada y persiste <=32 KiB en el DO; no modifica archivos de origen ni buckets. Úsala solo con autorización de captura, nunca para buscar secretos o rutas internas.",
    inputSchema: {
      id: taskIdSchema,
      path: z.string().min(10).max(240).describe("Ruta relativa bajo dist/, e.g. dist/reporte.txt. NO /bundle, file: ni URL."),
      name: z.string().min(1).max(120).describe("Nombre de descarga, Unicode NFC admitido"),
      mime: z.enum(["text/plain", "text/markdown", "application/json"])
    }
  }, async ({ id, path, name, mime }) => callTask(async () => {
    const supervisor = bindings.supervisor();
    if (!supervisor.supervisedArtifactCapture) throw new Error("ARTIFACT_BACKEND_UNAVAILABLE");
    return supervisor.supervisedArtifactCapture(id, { path, name, mime });
  }, undefined, true));

  server.registerTool("staging_task_progress", {
    description: `Progreso detallado temporalmente UNAVAILABLE_UNBOUNDED_SDK por eventos nativos de tamaño no acotado; devuelve snapshot y error explícito sin mover el cursor. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema, workspace: workspaceSchema, after: z.number().int().min(0).default(0) }
  }, async ({ id, workspace, after }) =>
    callTask(() => bindings.supervisor(workspace).remoteSupervisorProgress(id, after), undefined, true));

  server.registerTool("staging_task_continue", {
    description: `Envía una nueva instrucción para continuar o corregir una tarea. turnId hace idempotentes los reintentos; una instrucción sobre una tarea activa se aplica como steer. ${WORKSPACE_HINT}`,
    inputSchema: {
      id: taskIdSchema, workspace: workspaceSchema,
      turnId: z.string().regex(/^[a-f0-9]{16}$/), prompt: z.string().min(12).max(5000)
    }
  }, async ({ id, workspace, turnId, prompt }) =>
    callTask(() => bindings.supervisor(workspace).remoteSupervisorContinue({ id, turnId, prompt }), undefined, true));

  server.registerTool("staging_task_select_model", {
    description: `Selecciona un modelo del catálogo para los siguientes turnos de una tarea inactiva. El proveedor debe estar configurado en Staging. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema, workspace: workspaceSchema, model: z.string().min(1).max(160) }
  }, async ({ id, workspace, model }) =>
    callTask(() => bindings.supervisor(workspace).remoteSupervisorSelectModel(id, model), undefined, true));

  server.registerTool("staging_cancel_task", {
    description: `Solicita la cancelación de una tarea supervisada de Staging por su ID. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres"), workspace: workspaceSchema }
  }, async ({ id, workspace }) => callTask(() => bindings.supervisor(workspace).cancelSupervisedTask(id), undefined, true));

  server.registerTool("staging_review_task", {
    description: `Ejecuta la revisión GitHub existente para la rama bloqueada de una tarea de Staging. No aprueba ni fusiona cambios. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres"), workspace: workspaceSchema }
  }, async ({ id, workspace }) => callTask(() => bindings.supervisor(workspace).supervisedTaskReview(id), 16_000, true));

  server.registerTool("staging_task_transcript", {
    description: `Transcripción temporalmente no disponible: historial sin límite seguro de memoria en Staging. ${WORKSPACE_HINT}`,
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres"), workspace: workspaceSchema }
  }, async () => failed(new Error("SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED")));

  return server;
}

async function callTaskWithProbe(
  operation: () => Promise<unknown>, maxChars?: number,
  enabled = false, supervisorTask = false
) {
  const trace = createSupervisorMemoryProbe(enabled);
  try {
    // T01 observes RPC and serialization boundaries; T05 forbids a
    // fabricated PASS and guarantees bounded receipts on the MCP surface.
    const value = await trace.run("mcp", "rpc", operation);
    const json = await trace.run("mcp", "serialize", () =>
      boundedMcpJsonText(value, maxChars, STAGING_WORKER, supervisorTask));
    const page = JSON.parse(json) as { pageAvailable?: boolean; error?: string };
    const unavailable = supervisorTask && (
      page.pageAvailable === false ||
      page.error === "SUPERVISOR_PROGRESS_UNAVAILABLE_UNBOUNDED_SDK" ||
      page.error === "SUPERVISOR_NATIVE_NOT_FOUND"
    );
    return { content: [{ type: "text" as const, text: json }],
      ...(unavailable ? { isError: true } : {}) };
  } catch (error) {
    return failed(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : { result: value };
}

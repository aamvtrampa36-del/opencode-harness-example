import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { renderConversationMarkdown } from "../session-export";

export const STAGING_WORKER = "opencode-g1-staging";
export const STAGING_REPOSITORY = "aamvtrampa36-del/opencode-harness-example";
export const SUPERVISOR_OBJECT = "opencode-supervisor-v1";

export interface StagingSupervisor {
  startSupervisedTask(input: unknown): Promise<unknown>;
  supervisedTaskStatus(id: string): Promise<unknown>;
  cancelSupervisedTask(id: string): Promise<unknown>;
  supervisedTaskReview(id: string): Promise<unknown>;
  supervisedTaskTranscript(id: string): Promise<string>;
}

export interface StagingControlBindings {
  readHealth(): Promise<Response>;
  supervisor(): StagingSupervisor;
}

const taskIdSchema = z.string().regex(/^[a-f0-9]{16}$/);

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

function jsonText(value: unknown, maxChars = 16_000): string {
  const json = JSON.stringify(safeValue(value), null, 2) ?? "null";
  return json.length <= maxChars ? json : json.slice(0, maxChars) + "\n[Salida recortada]";
}

function result(value: unknown, maxChars?: number) {
  return { content: [{ type: "text" as const, text: jsonText(value, maxChars) }] };
}

function failed(error: unknown) {
  const message = error instanceof Error ? redactString(error.message).slice(0, 500) : "Error del control de staging";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createStagingControlServer(bindings: StagingControlBindings): McpServer {
  const server = new McpServer({ name: "opencode-staging-control", version: "1.0.0" });

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
      const payload = { targetWorker: STAGING_WORKER, status, health };
      return status === "ok" ? result(payload) : { ...result(payload), isError: true };
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("staging_start_task", {
    description: "Inicia una tarea supervisada en el repositorio fijo de Staging. Crea una rama y puede consumir inferencia y CPU. Usa un requestId hexadecimal de 16 caracteres para que los reintentos sean idempotentes. La revisión y promoción quedan fuera de este conector.",
    inputSchema: {
      requestId: z.string().regex(/^[a-f0-9]{16}$/).describe("ID único idempotente, exactamente 16 caracteres hexadecimales en minúscula"),
      prompt: z.string().min(12).max(5000).describe("Instrucción de desarrollo para Staging, entre 12 y 5000 caracteres")
    }
  }, async ({ requestId, prompt }) => {
    try {
      const task = await bindings.supervisor().startSupervisedTask({
        requestId, repository: STAGING_REPOSITORY, prompt
      });
      return result({ ...asRecord(task), targetWorker: STAGING_WORKER });
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("staging_task_status", {
    description: "Consulta una tarea supervisada de Staging por su ID hexadecimal de 16 caracteres.",
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres") }
  }, async ({ id }) => callTask(() => bindings.supervisor().supervisedTaskStatus(id)));

  server.registerTool("staging_cancel_task", {
    description: "Solicita la cancelación de una tarea supervisada de Staging por su ID.",
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres") }
  }, async ({ id }) => callTask(() => bindings.supervisor().cancelSupervisedTask(id)));

  server.registerTool("staging_review_task", {
    description: "Ejecuta la revisión GitHub existente para la rama bloqueada de una tarea de Staging. No aprueba ni fusiona cambios.",
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres") }
  }, async ({ id }) => callTask(() => bindings.supervisor().supervisedTaskReview(id), 16_000));

  server.registerTool("staging_task_transcript", {
    description: "Lee los últimos 20 mensajes de una tarea de Staging, sin razonamiento interno y con claves/tokens redactados.",
    inputSchema: { id: taskIdSchema.describe("ID de tarea hexadecimal de 16 caracteres") }
  }, async ({ id }) => {
    try {
      const task = asRecord(await bindings.supervisor().supervisedTaskStatus(id));
      if (typeof task.session !== "string") throw new Error("La tarea de Staging todavía no tiene una sesión disponible");
      const raw = await bindings.supervisor().supervisedTaskTranscript(id);
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

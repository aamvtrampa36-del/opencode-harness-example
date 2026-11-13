/**
 * G7 passive diagnostics. Only bounded structured evidence is retained.
 * Never store prompts, commands, stdout/stderr, exception text or credentials.
 */
export const INCIDENT_CODES = [
  "MODEL_UNAVAILABLE", "TOOL_MISSING", "SHELL_FAILED", "TEST_FAILED",
  "SESSION_STALLED", "LATENCY_TIMEOUT", "PERSISTENCE_FAILED",
  "RETRY_EXHAUSTED", "AGENT_FAILURE"
] as const;
export type IncidentCode = (typeof INCIDENT_CODES)[number];
export type IncidentSource = "agent" | "linux" | "agent-check" | "session";
export type IncidentObservation = {
  code: IncidentCode;
  source: IncidentSource;
  project?: string;
  tool?: "linux" | "inspect_linux" | "other";
  exitCode?: number;
  httpStatus?: number;
};
export type IncidentRecord = {
  id: string;
  code: IncidentCode;
  source: IncidentSource;
  project?: string;
  tool?: IncidentObservation["tool"];
  exitCode?: number;
  httpStatus?: number;
  count: number;
  firstAt: string;
  lastAt: string;
  suspectedCause: string;
  status: "open" | "repeated" | "blocked";
  action: string;
  automaticRetryAllowed: boolean;
};

const DESCRIPTIONS: Record<IncidentCode, { cause: string; action: string; transient: boolean }> = {
  MODEL_UNAVAILABLE: { cause: "Proveedor o modelo no disponible", action: "Comprobar proveedor y elegir solo un modelo ya conectado", transient: true },
  TOOL_MISSING: { cause: "Herramienta inexistente o llamada inválida", action: "Corregir nombre y contrato de la herramienta antes de repetir", transient: false },
  SHELL_FAILED: { cause: "Comando Linux terminó con error", action: "Examinar exitCode y corregir causa antes de volver a ejecutar", transient: false },
  TEST_FAILED: { cause: "Test determinista devolvió fallo", action: "Corregir código o entorno; no repetir tests idénticos sin un cambio", transient: false },
  SESSION_STALLED: { cause: "Sesión del agente bloqueada o sin progreso", action: "Comprobar sesión y estado de reconexión antes de reintentar", transient: true },
  LATENCY_TIMEOUT: { cause: "Tiempo de espera agotado", action: "Revisar disponibilidad y dividir la tarea; evitar bucles de timeout", transient: true },
  PERSISTENCE_FAILED: { cause: "Fallo de almacenamiento, snapshot o restauración", action: "Verificar respaldo antes de actuar; no crear entorno vacío", transient: false },
  RETRY_EXHAUSTED: { cause: "Intentos sin progreso agotados", action: "Detener repetición automática y solicitar evidencia nueva", transient: false },
  AGENT_FAILURE: { cause: "Fallo interno o del ciclo del agente", action: "Consultar eventos y estado del proveedor; no confiar en la respuesta textual", transient: false }
};
const MAX_RECORDS = 64;
const MAX_AUTO_RETRIES = 2;
const VALID_PROJECT = /^[a-z][a-z0-9-]{0,39}$/;

/** Classify failures based on machine evidence, not an AI success statement. */
export function observeLinux(input: {
  project?: string; exitCode: number | null; stdout?: string; stderr?: string;
}): IncidentObservation | null {
  const { exitCode } = input;
  if (exitCode === 0) return null;
  const output = (input.stdout ?? "") + "\n" + (input.stderr ?? "");
  const code: IncidentCode = exitCode === 124 || exitCode === 137 ? "LATENCY_TIMEOUT"
    : /(?:^|\n)\s*(?:not ok\b|FAIL\b)|tests? failed|\btest failure\b/i.test(output)
      ? "TEST_FAILED" : "SHELL_FAILED";
  return { code, source: "linux",
    ...(input.project && VALID_PROJECT.test(input.project) ? { project: input.project } : {}),
    tool: "linux", ...(Number.isInteger(exitCode) && exitCode !== null && exitCode >= 0 && exitCode <= 255 ? { exitCode } : {}) };
}

/** The original exception is used only in memory for classification. */
export function classifyAgentFailure(message: string): IncidentCode {
  if (/snapshot|checkpoint|restore|durable object|storage|sqlite|persist/i.test(message)) return "PERSISTENCE_FAILED";
  if (/timed?\s*out|timeout|deadline|latency|504\b/i.test(message)) return "LATENCY_TIMEOUT";
  if (/retry|retries|too many attempts|repeated attempts/i.test(message)) return "RETRY_EXHAUSTED";
  if (/unknown tool|invalid tool|tool not found|unrecognized tool|malformed tool/i.test(message)) return "TOOL_MISSING";
  if (/model.*(?:not found|unavailable|unknown)|provider.*(?:not available|unavailable|failed)|429\b|rate.limit/i.test(message)) return "MODEL_UNAVAILABLE";
  if (/(?:session.*(?:stuck|stalled|busy)|(?:stuck|stalled|busy).*session|cannot resume|connection closed|disconnected)/i.test(message)) return "SESSION_STALLED";
  return "AGENT_FAILURE";
}

/** Only structured enum fields cross into durable storage. */
export function cleanObservation(input: unknown): IncidentObservation {
  if (!input || typeof input !== "object") throw new Error("Invalid incident");
  const data = input as Record<string, unknown>;
  if (!INCIDENT_CODES.includes(data.code as IncidentCode)) throw new Error("Unknown incident code");
  if (!["agent", "linux", "agent-check", "session"].includes(String(data.source))) throw new Error("Unknown incident source");
  const source = data.source as IncidentSource;
  const code = data.code as IncidentCode;
  const project = typeof data.project === "string" && VALID_PROJECT.test(data.project) ? data.project : undefined;
  const tool = data.tool === "linux" || data.tool === "inspect_linux" ? data.tool : undefined;
  const exitCode = typeof data.exitCode === "number" && Number.isInteger(data.exitCode)
    && data.exitCode >= 0 && data.exitCode <= 255 ? data.exitCode : undefined;
  const httpStatus = typeof data.httpStatus === "number" && Number.isInteger(data.httpStatus)
    && data.httpStatus >= 400 && data.httpStatus <= 599 ? data.httpStatus : undefined;
  return { code, source, ...(project ? { project } : {}), ...(tool ? { tool } : {}),
    ...(exitCode === undefined ? {} : { exitCode }), ...(httpStatus === undefined ? {} : { httpStatus }) };
}

export function retryDecision(code: IncidentCode, occurrences: number): boolean {
  // Only safe transient operations MAY be retried. Never automatically rerun
  // a shell command, a deterministic test, a patch or a deployment.
  return DESCRIPTIONS[code].transient && occurrences <= MAX_AUTO_RETRIES;
}

export function aggregateIncident(
  records: readonly IncidentRecord[], raw: unknown, now: Date = new Date()
): IncidentRecord[] {
  const event = cleanObservation(raw);
  const id = [event.code, event.source, event.project ?? "-", event.tool ?? "-",
    event.exitCode ?? "-", event.httpStatus ?? "-"].join(":");
  const old = records.find(record => record.id === id);
  const count = Math.min((old?.count ?? 0) + 1, 1_000_000);
  const { cause, action } = DESCRIPTIONS[event.code];
  const automaticRetryAllowed = retryDecision(event.code, count);
  const result: IncidentRecord = {
    id, code: event.code, source: event.source,
    ...(event.project ? { project: event.project } : {}),
    ...(event.tool ? { tool: event.tool } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}),
    count, firstAt: old?.firstAt ?? now.toISOString(), lastAt: now.toISOString(),
    suspectedCause: cause,
    status: count > MAX_AUTO_RETRIES ? "blocked" : count > 1 ? "repeated" : "open",
    action: count > MAX_AUTO_RETRIES ? "Detener reintentos equivalentes; " + action : action,
    automaticRetryAllowed
  };
  return [result, ...records.filter(row => row.id !== id)]
    .slice(0, MAX_RECORDS);
}

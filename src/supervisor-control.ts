import { normalizeOwnedRepository, OPENCODE_STAGING_BASE } from "./github";
import { isModelSelection, type ModelSelectionID } from "./model-presets";
import type { R2PendingTurn } from "./supervisor-r2";

/**
 * The remote MCP authenticates at Cloudflare Access. Every Durable Object
 * entrypoint also requires the Staging-only environment flag; the legacy HTTP
 * route additionally keeps its separate bearer check.
 */
export const SUPERVISOR_WORKSPACE = "opencode-supervisor-v1";
export const SUPERVISOR_API_PREFIX = "/api/supervisor/v1";
const TASK_ID = /^[a-f0-9]{16}$/;
const GITHUB_MUTATIONS = new Set(["branch", "write", "pr"]);
const GITHUB_READ_ONLY_OPERATIONS = new Set([
  "repo", "read", "pr_search", "pr_info", "issue_info", "pr_files", "pr_reviews", "pr_checks"
]);
const SOURCE_SHA = /^[a-f0-9]{40}$/;
export type SupervisorMode = "read_only";

export type SupervisorStart = {
  requestId: string;
  repository: string;
  prompt: string;
  /** Selected from the models registered with this OpenCode instance. */
  model?: ModelSelectionID;
  /** Optional exact OpenCode session to fork. Its conversation is inherited, its files are not. */
  sourceSession?: string;
  mode?: SupervisorMode;
  /** Requested immutable commit/tree pair; verified independently before execution. */
  sourceCommit?: string;
  sourceTree?: string;
};

export type SupervisorTask = {
  id: string;
  repository: string;
  project: string;
  branch: string;
  fingerprint: string;
  session?: string;
  /** Server-only process identity; a restarted pilot cannot resume dispatch. */
  pilotInstance?: string;
  /** Server-only, immutable preparation receipt; never accepted from MCP input. */
  pilotPreparation?: import("./pilot-preparation").PilotPreparationReceipt;
  /** Durable write-ahead marker. If a session creation RPC lost its response,
   * never invoke create/fork again without independent reconciliation. */
  sessionCreationAttempted?: boolean;
  /** Only newly reserved R2 tasks are allowed to reconcile by pinned SDK ID.
   * Legacy random-ID create/fork attempts MUST remain unknown. */
  sessionIdPolicy?: "deterministic-v1";
  /** Task-local operation journal cursor. T03 owns global admission/fencing. */
  revision?: number;
  pendingTurn?: R2PendingTurn;
  /** Sticky negative fact: a cancelled task had an ambiguous concurrent steer. */
  cancelAmbiguous?: boolean;
  createdAt: number;
  status: "preparing" | "running" | "finished" | "unanswered" | "failed" |
    "cancel_requested" | "cancelled" | "unknown";
  /** Immutable source commit used to seed this task's isolated Linux project. */
  baseCommit?: string;
  /** Immutable requested pins; baseCommit alone records the verified commit. */
  mode?: SupervisorMode;
  sourceCommit?: string;
  sourceTree?: string;
  model?: ModelSelectionID;
  operationId?: string;
  error?: string;
  updatedAt?: number;
  lastEventSeq?: number;
  forkedFrom?: string;
};

/** A legacy active session without an operation ID cannot be retried safely. */
export function isUntrackedLegacySupervisorOperation(
  task: Pick<SupervisorTask, "status" | "session" | "operationId">
): boolean {
  return Boolean(task.session) && !task.operationId &&
    (task.status === "running" || task.status === "unknown");
}

/** Missing marker means a legacy task and is never proof of a safe replay. */
export function supervisorSessionCreationDisposition(
  task: Pick<SupervisorTask, "session" | "sessionCreationAttempted">
): "bound" | "create" | "reconcile" {
  if (task.session) return "bound";
  return task.sessionCreationAttempted === false ? "create" : "reconcile";
}

/** No-session is not proof of no effect after an interrupted create/fork RPC.
 * An active or stranded start lock also makes confirmation unsafe. */
export function canConfirmSupervisorPreSessionCancellation(
  task: Pick<SupervisorTask, "session" | "sessionCreationAttempted">,
  startLockPresent: boolean
): boolean {
  return supervisorSessionCreationDisposition(task) === "create" && !startLockPresent;
}

export function classifySupervisorOperation(
  stored: SupervisorTask["status"] | Pick<SupervisorTask, "status" | "operationId">, busy: boolean,
  operation?: { status: "done" | "unanswered"; reason?: string }
): SupervisorTask["status"] {
  const task = typeof stored === "string" ? undefined : stored;
  const status = task?.status ?? stored as SupervisorTask["status"];
  const receipt = task && !task.operationId ? undefined : operation;
  if (receipt?.status === "done") return "finished";
  if (receipt?.status === "unanswered") {
    if (receipt.reason === "interrupted" && status === "cancel_requested") return "cancelled";
    if (receipt.reason === "failed") return "failed";
    if (receipt.reason === "not_found") return "unknown";
    return "unanswered";
  }
  if (busy) return status === "cancel_requested" ? "cancel_requested" : "running";
  if (status === "preparing") return "preparing";
  if (["running", "unknown", "cancel_requested"].includes(status)) return "unknown";
  return status;
}

/** Validate pins even for typed internal callers; absence of mode is the legacy contract. */
function validateReadOnlyPins(input: {
  mode?: unknown; sourceCommit?: unknown; sourceTree?: unknown; sourceSession?: unknown;
}): { mode: SupervisorMode; sourceCommit: string; sourceTree: string } | undefined {
  if (input.mode === undefined) {
    if (input.sourceCommit !== undefined || input.sourceTree !== undefined) {
      throw new Error("sourceCommit y sourceTree solo se admiten en modo read_only");
    }
    return undefined;
  }
  if (input.mode !== "read_only") throw new Error("Modo del supervisor inválido");
  if (input.sourceSession !== undefined) throw new Error("read_only no admite forks de sesiones");
  if (typeof input.sourceCommit !== "string" || !SOURCE_SHA.test(input.sourceCommit) ||
      typeof input.sourceTree !== "string" || !SOURCE_SHA.test(input.sourceTree)) {
    throw new Error("read_only requiere sourceCommit y sourceTree: SHA de 40 caracteres hexadecimales en minúscula");
  }
  return { mode: "read_only", sourceCommit: input.sourceCommit, sourceTree: input.sourceTree };
}

export function validateSupervisorStart(raw: unknown, approved: readonly string[]): SupervisorStart {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Solicitud inválida");
  const input = raw as Record<string, unknown>;
  if (typeof input.requestId !== "string" || !TASK_ID.test(input.requestId)) {
    throw new Error("requestId debe contener exactamente 16 caracteres hexadecimales");
  }
  if (typeof input.repository !== "string") throw new Error("Repositorio obligatorio");
  const repository = normalizeOwnedRepository(input.repository);
  if (!approved.some(x => x.toLowerCase() === repository.toLowerCase())) {
    throw new Error("Repositorio no autorizado para el supervisor");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length < 12 ||
      input.prompt.length > 5_000) throw new Error("Tarea de 12 a 5000 caracteres requerida");
  if (input.model !== undefined && !isModelSelection(input.model)) {
    throw new Error("Modelo no disponible en el catálogo del supervisor");
  }
  if (input.sourceSession !== undefined &&
      (typeof input.sourceSession !== "string" || !/^ses[A-Za-z0-9_]{1,64}$/.test(input.sourceSession))) {
    throw new Error("La sesión de origen debe ser un ID OpenCode válido");
  }
  const pins = validateReadOnlyPins(input);
  if (Object.keys(input).some(key => !["requestId", "repository", "prompt", "model", "sourceSession",
    "mode", "sourceCommit", "sourceTree"].includes(key))) {
    throw new Error("Parámetros del supervisor desconocidos");
  }
  return { requestId: input.requestId, repository, prompt: input.prompt.trim(),
    ...(input.model ? { model: input.model } : {}),
    ...(input.sourceSession ? { sourceSession: input.sourceSession } : {}),
    ...pins };
}

export function supervisorTaskKey(id: string): string {
  if (!TASK_ID.test(id)) throw new Error("Identificador de tarea inválido");
  return "supervisor:task:" + id;
}

/** Stable OpenCode inbox keys make client/Worker retries return one receipt. */
export function supervisorStartOperationId(id: string): string {
  supervisorTaskKey(id);
  return "rc-start-" + id;
}

export function supervisorTurnOperationId(id: string, turnId: string): string {
  supervisorTaskKey(id);
  if (!TASK_ID.test(turnId)) throw new Error("Identificador de turno inválido");
  return "rc-turn-" + id + "-" + turnId;
}

export function supervisorBranch(id: string, repository?: string, mode?: SupervisorMode): string {
  supervisorTaskKey(id);
  if (mode !== undefined) {
    if (mode !== "read_only") throw new Error("Modo del supervisor inválido");
    return ""; // Durable no-branch sentinel, never a GitHub ref.
  }
  // Only OpenCode's own self-improvement branches derive from Staging.
  // Existing G9 and other repository tasks continue using the default branch.
  return (repository?.toLowerCase() === "aamvtrampa36-del/opencode-harness-example"
    ? "opencode/staging-" : "opencode/supervised-") + id;
}

/** Verify the GitHub-created branch actually points at the authorized source. */
export function supervisorBaseCommit(result: unknown, repository: string): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("GitHub no devolvió la base de la rama supervisada");
  }
  const value = result as Record<string, unknown>;
  if (typeof value.sha !== "string" || !/^[a-f0-9]{40}$/.test(value.sha)) {
    throw new Error("GitHub no devolvió un SHA de base verificable");
  }
  if (repository.toLowerCase() === "aamvtrampa36-del/opencode-harness-example" &&
      value.source !== OPENCODE_STAGING_BASE) {
    throw new Error("La tarea de OpenCode debe partir de Staging");
  }
  return value.sha;
}

export function supervisorProject(id: string): string {
  supervisorTaskKey(id);
  return "supervised-" + id;
}

export function assertSupervisorBoundGitHubOperation(
  operation: string | undefined,
  branch: string | undefined,
  lockedBranch: string,
  mode?: SupervisorMode
): void {
  if (mode !== undefined) {
    if (mode !== "read_only") throw new Error("Modo del supervisor inválido");
    if (lockedBranch !== "" || !GITHUB_READ_ONLY_OPERATIONS.has(operation ?? "")) {
      throw new Error("Supervisor: tarea de solo lectura no puede escribir, revisar ni crear PR; operación no autorizada");
    }
    return;
  }
  if (operation === "branch") throw new Error("Rama del supervisor precreada: no crear otras");
  if ((GITHUB_MUTATIONS.has(operation ?? "") || operation === "review") &&
      (!lockedBranch || branch !== lockedBranch)) {
    throw new Error("Supervisor: escritura, revisión o PR fuera de su rama bloqueada");
  }
}

export async function supervisorFingerprint(value: SupervisorStart): Promise<string> {
  const pins = validateReadOnlyPins(value);
  // Never change the ordinary preimage: existing durable request IDs depend on it.
  // Read-only uses a disjoint prefix and a JSON tuple, not delimiter-joined user input.
  const preimage = pins
    ? "supervisor:read_only:v1\0" + JSON.stringify([
      value.repository.toLowerCase(), value.prompt, value.model ?? "economy",
      pins.sourceCommit, pins.sourceTree
    ])
    : value.repository.toLowerCase() + "\n" + value.prompt + "\n" + (value.model ?? "economy") +
      "\n" + (value.sourceSession ?? "");
  const bytes = new TextEncoder().encode(preimage);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function supervisorBearerAllowed(header: string | null, secret: string): Promise<boolean> {
  if (secret.length < 32 || !/^[^\s]{32,256}$/.test(secret)) return false;
  const match = /^Bearer ([^\s]{32,256})$/.exec(header ?? "");
  if (!match) return false;
  // Compare hashes in constant work regardless of differing token lengths.
  const encodeHash = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const a = await encodeHash(match[1]);
  const b = await encodeHash(secret);
  let difference = 0;
  for (let i = 0; i < b.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export function supervisorResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: {
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  } });
}

/**
 * Never let the executing agent promote, merge, deploy or mutate a second
 * project using the supervisor route. Promotion is a separate trusted process.
 */
export function supervisorPrompt(task: SupervisorStart, branch: string, project: string,
  baseCommit: string, sourceTree?: string): string {
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error("SHA base de la tarea inválido");
  const pins = validateReadOnlyPins(task);
  if (pins) {
    if (branch !== "" || baseCommit !== pins.sourceCommit || sourceTree !== pins.sourceTree) {
      throw new Error("read_only: rama o identidad commit/árbol no coincide con los pins solicitados");
    }
    return "Tarea supervisada en modo SOLO LECTURA. Repositorio autorizado: " + task.repository +
      ". Proyecto Linux exclusivo: " + project + ". SHA base verificado: " + baseCommit +
      "; árbol Git verificado: " + sourceTree +
      ". No existe rama de trabajo: no crees ramas, no escribas en GitHub, no abras PR ni solicites revisión. " +
      "La importación del Container debe verificarse contra ese commit y árbol exactos antes de preparar el modelo o ejecutar inferencia. " +
      "Lee el código local y ejecuta pruebas locales; para leer código en GitHub usa el SHA fijado como ref, no una rama mutable. " +
      "La copia importada no contiene .git: no uses git status, fetch ni checkout. " +
      "Prohibido fusionar, desplegar, modificar Producción, secretos, permisos o controles de seguridad. " +
      "Explica comandos, resultados y fallos con evidencia real. Nunca atribuyas a tu trabajo cambios del servidor o supervisor. " +
      "Si una operación requiere permisos adicionales, informa el bloqueo.\n\nENCARGO:\n" + task.prompt;
  }
  const selfDevelopment = task.repository.toLowerCase() === "aamvtrampa36-del/opencode-harness-example";
  return "Tarea de desarrollo supervisada y REVERSIBLE. Repositorio autorizado: " +
    task.repository + ". Proyecto Linux exclusivo: " + project + ". Rama precreada: " + branch +
    (task.sourceSession
      ? ". Esta sesión es un fork explícito de " + task.sourceSession +
        "; usa su contexto de conversación, pero no alteres su sesión padre. El Container se importa limpio desde el SHA fijado: no contiene archivos locales sin guardar del proyecto de origen."
      : "") +
    (selfDevelopment
      ? ". BASE REAL: " + OPENCODE_STAGING_BASE + "; SHA verificado: " + baseCommit +
        ". El Container Linux se importará desde ese SHA exacto y no contiene .git. No uses git status, fetch ni checkout en el Container. Lee archivos locales desde esa base; usa repo_read con ref " + branch +
        " cuando necesites consultar la rama GitHub. No leas ni presentes main como Staging"
      : ". SHA base verificado: " + baseCommit +
        ". El Container Linux se importará desde ese commit exacto y no contiene .git. No uses git status, fetch ni checkout en el Container") +
    ". Tienes permiso para leer el código autorizado, ejecutar pruebas y escribir SOLO en esa rama " +
    "usando la herramienta github; prepara exclusivamente una PR borrador. " +
    "La copia importada a Linux no contiene .git: usa github para crear commits. " +
    "Prohibido fusionar, desplegar, modificar Producción, secretos, permisos o controles de seguridad. " +
    "Explica comandos, resultados, pruebas fallidas y correctas con evidencia real. " +
    "Nunca atribuyas a tu trabajo cambios hechos por el servidor o el supervisor. " +
    "Si una operación requiere permisos adicionales, informa el bloqueo.\n\nENCARGO:\n" +
    task.prompt;
}

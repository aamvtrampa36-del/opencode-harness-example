import { normalizeOwnedRepository, OPENCODE_STAGING_BASE } from "./github";

/**
 * The remote MCP authenticates at Cloudflare Access. Every Durable Object
 * entrypoint also requires the Staging-only environment flag; the legacy HTTP
 * route additionally keeps its separate bearer check.
 */
export const SUPERVISOR_WORKSPACE = "opencode-supervisor-v1";
export const SUPERVISOR_API_PREFIX = "/api/supervisor/v1";
const TASK_ID = /^[a-f0-9]{16}$/;
const GITHUB_MUTATIONS = new Set(["branch", "write", "pr"]);

export type SupervisorStart = {
  requestId: string;
  repository: string;
  prompt: string;
  /** Native Workers AI only: never route a supervised test to an unapproved premium model. */
  model?: "economy" | "cloudflare";
};

export type SupervisorTask = {
  id: string;
  repository: string;
  project: string;
  branch: string;
  fingerprint: string;
  session?: string;
  createdAt: number;
  status: "preparing" | "running" | "failed" | "cancelled";
  /** Immutable source commit used to seed this task's isolated Linux project. */
  baseCommit?: string;
  model?: "economy" | "cloudflare";
  operationId?: string;
  error?: string;
};

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
  if (input.model !== undefined && input.model !== "economy" && input.model !== "cloudflare") {
    throw new Error("Modelo no autorizado para el supervisor");
  }
  if (Object.keys(input).some(key => !["requestId", "repository", "prompt", "model"].includes(key))) {
    throw new Error("Parámetros del supervisor desconocidos");
  }
  return { requestId: input.requestId, repository, prompt: input.prompt.trim(),
    ...(input.model ? { model: input.model as "economy" | "cloudflare" } : {}) };
}

export function supervisorTaskKey(id: string): string {
  if (!TASK_ID.test(id)) throw new Error("Identificador de tarea inválido");
  return "supervisor:task:" + id;
}

export function supervisorBranch(id: string, repository?: string): string {
  supervisorTaskKey(id);
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
  lockedBranch: string
): void {
  if (operation === "branch") throw new Error("Rama del supervisor precreada: no crear otras");
  if ((GITHUB_MUTATIONS.has(operation ?? "") || operation === "review") &&
      branch !== lockedBranch) {
    throw new Error("Supervisor: escritura, revisión o PR fuera de su rama bloqueada");
  }
}

export async function supervisorFingerprint(value: SupervisorStart): Promise<string> {
  const bytes = new TextEncoder().encode(
    value.repository.toLowerCase() + "\n" + value.prompt + "\n" + (value.model ?? "economy")
  );
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
  baseCommit: string): string {
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error("SHA base de la tarea inválido");
  const selfDevelopment = task.repository.toLowerCase() === "aamvtrampa36-del/opencode-harness-example";
  return "Tarea de desarrollo supervisada y REVERSIBLE. Repositorio autorizado: " +
    task.repository + ". Proyecto Linux exclusivo: " + project + ". Rama precreada: " + branch +
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

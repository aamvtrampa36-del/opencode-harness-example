import { normalizeOwnedRepository } from "./github";

const SLUG = /^[a-z][a-z0-9-]{0,39}$/;
const SESSION_ID = /^ses[A-Za-z0-9_]{1,64}$/;

export type ProjectScope = { project: string; repository?: string };
export type ScopedToolAction =
  | { kind: "linux"; project: string }
  | { kind: "github"; repo: string; operation?: string; branch?: string }
  | { kind: "workspace-write" };

export function validSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID.test(id);
}
export function scopeStorageKey(sessionId: string): string {
  if (!validSessionId(sessionId)) throw new Error("Identificador de sesión inválido");
  return "g8-scope:" + sessionId;
}
export function validateProjectScope(input: unknown, approved: readonly string[]): ProjectScope {
  if (!input || typeof input !== "object") throw new Error("Selecciona un proyecto para esta conversación");
  const data = input as Record<string, unknown>;
  if (typeof data.project !== "string" || !SLUG.test(data.project)) {
    throw new Error("Selecciona un proyecto Linux válido en la barra de proyectos");
  }
  if (data.repository === undefined || data.repository === null || data.repository === "") {
    return { project: data.project };
  }
  const repo = normalizeOwnedRepository(data.repository);
  if (!approved.some(allowed => allowed.toLowerCase() === repo.toLowerCase())) {
    throw new Error("El repositorio no está autorizado en Configuración");
  }
  return { project: data.project, repository: repo };
}

/** One immutable project+repository binding per conversation, until a new chat. */
export function requireSameScope(existing: ProjectScope | undefined, next: ProjectScope): ProjectScope {
  if (!existing) return next;
  if (existing.project !== next.project ||
      (existing.repository ?? "").toLowerCase() !== (next.repository ?? "").toLowerCase()) {
    throw new Error("Esta conversación pertenece a otro proyecto o repositorio. Crea una conversación nueva para cambiar de proyecto.");
  }
  return existing;
}

/** Tool arguments are treated as untrusted even when an LLM generated them. */
export function assertScopedTool(scope: ProjectScope | undefined, tool: ScopedToolAction): void {
  if (tool.kind === "workspace-write") {
    // The shared Workspace is the fallback for conversations with no project.
    // A project-bound session must use its isolated Linux or GitHub tools.
    if (scope) throw new Error("Herramienta de workspace global desactivada para sesiones de proyectos");
    return;
  }
  if (!scope) throw new Error("Sesión sin proyecto asignado: selecciona proyecto y envía una tarea nueva");
  if (tool.kind === "linux") {
    if (tool.project !== scope.project) throw new Error("Herramienta Linux bloqueada: proyecto distinto al de la sesión");
    return;
  }
  if (tool.kind === "github") {
    if (!scope.repository || tool.repo.toLowerCase() !== scope.repository.toLowerCase()) {
      throw new Error("GitHub bloqueado: solo se permite el repositorio seleccionado en la sesión");
    }
    return;
  }
}

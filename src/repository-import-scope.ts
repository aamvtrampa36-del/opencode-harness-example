import { repositoryProjectSlug } from "./project-container";
import { validateProjectScope, type ProjectScope } from "./project-scope";

/** Resolve a client-selected repository to its immutable, authorized session scope. */
export function repositoryImportScope(repository: unknown, allowed: readonly string[]): ProjectScope {
  if (typeof repository !== "string") throw new Error("Selecciona un repositorio GitHub autorizado");
  return validateProjectScope(
    { project: repositoryProjectSlug(repository), repository },
    allowed
  );
}

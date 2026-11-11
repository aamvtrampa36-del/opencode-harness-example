import { repositoryProjectSlug } from "./project-container";
import { validateProjectScope, type ProjectScope } from "./project-scope";

/** Resolve a client-selected repository to its immutable, authorized session scope. */
export function repositoryImportScope(repository: unknown, allowed: readonly string[]): ProjectScope {
  if (typeof repository !== "string") throw new Error("Selecciona un repositorio GitHub autorizado");
  const selected = repository.trim();
  const authorizedRepository = allowed.find(value => value.toLowerCase() === selected.toLowerCase());
  if (!authorizedRepository) throw new Error("El repositorio no está autorizado en Configuración");
  return validateProjectScope(
    { project: repositoryProjectSlug(authorizedRepository), repository: authorizedRepository },
    allowed
  );
}

import { validateProject } from "./dev-guard";

/** A distinct Durable Object name ensures a distinct Container per project. */
export function projectContainerName(project: unknown): string {
  return "project-v1:" + validateProject(project);
}

export type IsolatedProject = { project: string; repository?: string };

/** Preserve old work and prevent the same slug being rebound to another repo. */
export function validateIsolatedRegistration(
  legacy: readonly { name: string }[],
  existing: IsolatedProject | undefined,
  requested: IsolatedProject
): IsolatedProject {
  const project = validateProject(requested.project);
  if (existing) {
    if (existing.project !== project ||
        (existing.repository ?? "").toLowerCase() !== (requested.repository ?? "").toLowerCase()) {
      throw Error("Este proyecto aislado ya pertenece a otro repositorio");
    }
    return existing;
  }
  if (legacy.some(item => item.name === project)) {
    throw Error("El proyecto anterior se conserva: restaura una copia verificada en un nombre nuevo");
  }
  return requested;
}

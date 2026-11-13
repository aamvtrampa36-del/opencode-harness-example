import { validateProject } from "./dev-guard";
import { normalizeOwnedRepository } from "./github";

/** A distinct Durable Object name ensures a distinct Container per project. */
export function projectContainerName(project: unknown): string {
  return "project-v1:" + validateProject(project);
}

/** New repository work uses names distinct from legacy shared workspaces. */
export function repositoryProjectSlug(repository: string): string {
  const repo = normalizeOwnedRepository(repository);
  const slug = repo.split("/")[1].toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 35);
  return validateProject("repo-" + slug);
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

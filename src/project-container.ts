import { validateProject } from "./dev-guard";

/** A distinct Durable Object name ensures a distinct Container per project. */
export function projectContainerName(project: unknown): string {
  return "project-v1:" + validateProject(project);
}

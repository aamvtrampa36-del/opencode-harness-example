/**
 * The user's session scope, not an LLM argument, determines Linux target.
 * Older clients/agents may still supply a project; reject mismatches.
 */
export async function resolveScopedLinuxProject(
  sessionID: string,
  supplied: unknown,
  sessionProject?: (sessionID: string) => Promise<string>
): Promise<string> {
  const bound = sessionProject ? await sessionProject(sessionID) : "";
  const project = typeof supplied === "string" ? supplied : "";
  if (bound && project && project !== bound)
    throw new Error("Proyecto diferente al autorizado en esta sesión");
  const target = bound || project;
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(target))
    throw new Error("Selecciona un proyecto Linux válido antes de utilizar herramientas");
  return target;
}

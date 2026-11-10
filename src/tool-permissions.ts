/**
 * Enforced at tool execution, not only in a system prompt. Both Plan and
 * Review use OpenCode's native agent="plan". This policy is shared by
 * Linux, GitHub and workspace tools to avoid gaps between implementations.
 */
const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "ls", "find", "stat"]);
const READ_ONLY_GITHUB_ACTIONS = new Set(["repo", "read", "review"]);

export function assertAgentToolPermission(
  agent: string,
  name: "linux" | "github" | "workspace",
  options: { tool?: string; action?: string } = {}
): void {
  if (agent !== "plan") return;
  if (name === "linux") {
    throw new Error("Planificación y Revisión no pueden ejecutar comandos Linux. Cambia a Desarrollar para ejecutar código.");
  }
  if (name === "github" && !READ_ONLY_GITHUB_ACTIONS.has(options.action ?? "")) {
    throw new Error("Planificación y Revisión solo pueden consultar repositorios. Cambia a Desarrollar para modificar GitHub.");
  }
  if (name === "workspace" && !READ_ONLY_TOOLS.has(options.tool ?? "")) {
    throw new Error("Planificación y Revisión solo pueden leer o buscar archivos. Cambia a Desarrollar para modificarlos.");
  }
}

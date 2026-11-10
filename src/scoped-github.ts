import { assertAgentToolPermission } from "./tool-permissions";
import type { GitHubAction } from "./github";

export type BoundRepositoryAction =
  | { action: "repo" }
  | { action: "read"; path: string; ref?: string }
  | { action: "review"; branch: string };

/** G8: resolve the repository ONLY from the server-side immutable session
 * binding. No model input can supply or override the target repo.
 */
export async function executeBoundRepositoryAction(
  sessionID: string,
  agent: string,
  action: BoundRepositoryAction,
  getRepository: (sessionID: string) => Promise<string>,
  guard: (sessionID: string, repo: string) => Promise<void>,
  execute: (action: GitHubAction) => Promise<unknown>
): Promise<unknown> {
  assertAgentToolPermission(agent, "github", { action: action.action });
  const repo = await getRepository(sessionID);
  if (!repo) throw new Error("No hay repositorio GitHub seleccionado para esta conversación");
  await guard(sessionID, repo);
  return execute({ ...action, repo } as GitHubAction);
}

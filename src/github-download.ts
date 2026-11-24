import { normalizeOwnedRepository, GitHubBridge } from "./github";
import { githubArchiveResponse, freezeGitHubSourcePin, type GitHubSourcePin } from "./metralla-m05-source";
import { archiveDownloadResponse, archiveError } from "./download-response";

/** Download an authorized private repository as a ZIP from GitHub itself.
 * The token never reaches the client or the local Linux container.
 */
export async function githubRepositoryDownload(
  repoInput: string,
  token: string,
  allowedRepos: readonly string[],
  http: typeof fetch = fetch,
  sourcePin?: GitHubSourcePin
): Promise<Response> {
  const repo = normalizeOwnedRepository(repoInput);
  if (!allowedRepos.some(x => x.toLowerCase() === repo.toLowerCase())) {
    return archiveError(403, "El repositorio no está autorizado para esta cuenta.");
  }
  if (!token) return archiveError(422, "Conecta GitHub en Configuración antes de descargar este repositorio.");
  let response: Response;
  try {
    const pin = sourcePin ? freezeGitHubSourcePin(sourcePin) : undefined;
    if (pin) {
      if (pin.repo !== repo.toLowerCase()) return archiveError(403, "El repositorio no coincide con la fuente fijada.");
      await new GitHubBridge(token, http, allowedRepos).resolveReadOnlySource(repo, pin.commit, pin.tree);
    }
    response = await githubArchiveResponse(http, repo, "zipball", {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpenCode-Cloud"
      }, AbortSignal.timeout(45_000), pin?.commit);
  } catch {
    return archiveError(502, "No se pudo conectar con GitHub para descargar el repositorio.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return archiveError(response.status === 404 ? 404 : 502,
      "GitHub no pudo entregar el ZIP del repositorio (HTTP " + response.status + ").");
  }
  return archiveDownloadResponse(repo.split("/")[1], response, "zip");
}

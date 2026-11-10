import { normalizeOwnedRepository } from "./github";
import { archiveDownloadResponse, archiveError } from "./download-response";

/** Download an authorized private repository as a ZIP from GitHub itself.
 * The token never reaches the client or the local Linux container.
 */
export async function githubRepositoryDownload(
  repoInput: string,
  token: string,
  allowedRepos: readonly string[],
  http: typeof fetch = fetch
): Promise<Response> {
  const repo = normalizeOwnedRepository(repoInput);
  if (!allowedRepos.some(x => x.toLowerCase() === repo.toLowerCase())) {
    return archiveError(403, "El repositorio no está autorizado para esta cuenta.");
  }
  if (!token) return archiveError(422, "Conecta GitHub en Configuración antes de descargar este repositorio.");
  let response: Response;
  try {
    response = await http("https://api.github.com/repos/" + repo + "/zipball", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpenCode-Cloud"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(45_000)
    });
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

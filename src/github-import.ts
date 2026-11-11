import { normalizeOwnedRepository } from "./github";

/** Fetch an authorized repository at an immutable commit in the Worker.
 * The returned stream contains only source bytes, never authentication data. */
export async function githubSourceArchive(
  repository: string,
  token: string,
  allowed: readonly string[],
  http: typeof fetch = fetch
): Promise<{ repo: string; commit: string; stream: ReadableStream<Uint8Array> }> {
  const repo = normalizeOwnedRepository(repository);
  if (!allowed.some(value => value.toLowerCase() === repo.toLowerCase())) {
    throw Error("Repositorio no autorizado");
  }
  if (!token) throw Error("Conecta GitHub en Configuración");
  const base = "https://api.github.com/repos/" + repo;
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OpenCode-Cloud"
  };
  const info = await http(base, { headers, signal: AbortSignal.timeout(45_000) });
  if (!info.ok) throw Error("No se pudo consultar el repositorio en GitHub");
  const metadata = await info.json() as { full_name?: string; default_branch?: string };
  if (metadata.full_name?.toLowerCase() !== repo.toLowerCase() ||
      typeof metadata.default_branch !== "string" || !metadata.default_branch) {
    throw Error("GitHub devolvió datos de repositorio inválidos");
  }
  const ref = await http(base + "/commits/" + encodeURIComponent(metadata.default_branch),
    { headers, signal: AbortSignal.timeout(45_000) });
  if (!ref.ok) throw Error("No se pudo identificar el commit del repositorio");
  const commit = (await ref.json() as { sha?: string }).sha;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw Error("GitHub devolvió un commit inválido");
  const archive = await http(base + "/tarball/" + commit, {
    headers, redirect: "follow", signal: AbortSignal.timeout(90_000)
  });
  if (!archive.ok || !archive.body) throw Error("No se pudo descargar el código del repositorio");
  return { repo, commit, stream: archive.body };
}

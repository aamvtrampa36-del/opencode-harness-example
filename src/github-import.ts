import { normalizeOwnedRepository } from "./github";
import { githubRestNoRedirect, githubArchiveResponse } from "./metralla-m05-source";

export const RAW_TREE_CERTIFICATION = "raw-git-tree-v1" as const;
export type SourceReceipt = { commit: string; tree?: string; certification?: string };

/** Cached project receipts are reusable only for the exact commit and tree. */
export function sourceReceiptMatches(
  existing: SourceReceipt,
  sourceCommit: string | undefined,
  sourceTree: string | undefined
): boolean {
  if (sourceCommit === undefined) return sourceTree === undefined;
  if (existing.commit !== sourceCommit) return false;
  return (existing.tree ?? "") === (sourceTree ?? "") &&
    (sourceTree === undefined || existing.certification === RAW_TREE_CERTIFICATION);
}

function validateSourcePin(sourceCommit?: string, sourceTree?: string): void {
  if (sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw Error("Commit de origen inválido");
  }
  if (sourceTree !== undefined && !/^[a-f0-9]{40}$/.test(sourceTree)) {
    throw Error("Árbol de origen inválido");
  }
  if (sourceTree !== undefined && sourceCommit === undefined) {
    throw Error("sourceCommit es obligatorio cuando se fija sourceTree");
  }
}

/** Fetch an authorized repository at an immutable commit in the Worker.
 * When sourceTree is supplied, GitHub must confirm the commit and its tree
 * before any archive byte is downloaded. The returned stream contains only
 * source bytes, never authentication data. */
export async function githubSourceArchive(
  repository: string,
  token: string,
  allowed: readonly string[],
  http: typeof fetch = fetch,
  sourceCommit?: string,
  sourceTree?: string
): Promise<{ repo: string; commit: string; tree?: string; stream: ReadableStream<Uint8Array> }> {
  const repo = normalizeOwnedRepository(repository);
  if (!allowed.some(value => value.toLowerCase() === repo.toLowerCase())) {
    throw Error("Repositorio no autorizado");
  }
  if (!token) throw Error("Conecta GitHub en Configuración");
  validateSourcePin(sourceCommit, sourceTree);
  const base = "https://api.github.com/repos/" + repo;
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OpenCode-Cloud"
  };
  const info = await githubRestNoRedirect(http, base, { headers, signal: AbortSignal.timeout(45_000) });
  if (!info.ok) throw Error("No se pudo consultar el repositorio en GitHub");
  const metadata = await info.json() as { full_name?: string; default_branch?: string };
  if (metadata.full_name?.toLowerCase() !== repo.toLowerCase() ||
      typeof metadata.default_branch !== "string" || !metadata.default_branch) {
    throw Error("GitHub devolvió datos de repositorio inválidos");
  }
  let commit = sourceCommit;
  if (sourceTree !== undefined) {
    const verified = await githubRestNoRedirect(http, base + "/commits/" + commit, {
      headers, signal: AbortSignal.timeout(45_000)
    });
    if (!verified.ok) {
      if (verified.status === 404) throw Error("El commit de origen no existe en el repositorio autorizado");
      throw Error("No se pudo verificar el commit de origen en GitHub");
    }
    const record = await verified.json() as {
      sha?: string; commit?: { tree?: { sha?: string } };
    };
    const tree = record.commit?.tree?.sha;
    if (record.sha?.toLowerCase() !== commit) {
      throw Error("GitHub no confirmó el commit de origen solicitado");
    }
    if (typeof tree !== "string" || !/^[a-f0-9]{40}$/.test(tree)) {
      throw Error("GitHub no devolvió un árbol verificable");
    }
    if (tree !== sourceTree) throw Error("El árbol de origen no coincide con el commit verificado");
  } else if (!commit) {
    const ref = await githubRestNoRedirect(http, base + "/commits/" + encodeURIComponent(metadata.default_branch),
      { headers, signal: AbortSignal.timeout(45_000) });
    if (!ref.ok) throw Error("No se pudo identificar el commit del repositorio");
    commit = (await ref.json() as { sha?: string }).sha;
  }
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw Error("GitHub devolvió un commit inválido");
  const archive = await githubArchiveResponse(http, repo, "tarball", headers, AbortSignal.timeout(90_000), commit);
  if (!archive.ok || !archive.body) throw Error("No se pudo descargar el código del repositorio");
  return { repo, commit, ...(sourceTree ? { tree: sourceTree } : {}), stream: archive.body };
}

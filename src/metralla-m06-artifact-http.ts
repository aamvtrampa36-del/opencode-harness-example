import { artifactKey, artifactMatchesScope, artifactErrorResponse, assertTaskId, assertArtifactId, verifiedArtifactDownload, TASK_ARTIFACT_MAX_PER_TASK, type ArtifactReadStorage, type ArtifactTaskScope, type StoredTaskArtifact } from "./task-output-artifacts.ts";

/** Query is not a credential: the caller must authenticate and resolve the server-owned scope first. */
export function parseArtifactQuery(query: string, download: boolean): { after?: string; limit: number; expiresAt?: number; format?: "text" | "json" } {
  if (query.length > 180) throw Error("ARTIFACT_QUERY_INVALID");
  const p = new URLSearchParams(query);
  const allowed = download ? ["expires"] : ["after", "limit", "format"];
  const seen = new Set<string>();
  p.forEach((_value, key) => {
    if (!allowed.includes(key) || seen.has(key)) throw Error("ARTIFACT_QUERY_INVALID");
    seen.add(key);
  });
  if (download) {
    const raw = p.get("expires");
    if (!raw || !/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw Error("ARTIFACT_QUERY_INVALID");
    return {limit: 1, expiresAt: Number(raw)};
  }
  const raw = p.get("limit");
  if (raw !== null && !/^[1-8]$/.test(raw)) throw Error("ARTIFACT_PAGE_LIMIT");
  const after = p.get("after");
  if (after !== null && !/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(after)) throw Error("ARTIFACT_CURSOR_INVALID");
  const format = p.get("format");
  if (format !== null && format !== "text" && format !== "json") throw Error("ARTIFACT_EXPORT_FORMAT_INVALID");
  return {limit: raw === null ? (format ? 2 : TASK_ARTIFACT_MAX_PER_TASK) : Number(raw), after: after ?? undefined, format: format ?? undefined};
}

/** Read-only. Foreign records are rejected before expiry. No partial bytes or stale generation. */
export async function scopedArtifactDownload(storage: ArtifactReadStorage, scope: ArtifactTaskScope,
    artifactId: string, expiresAt: number, range: string | null = null, now = Date.now()): Promise<Response> {
  try { assertTaskId(scope.id); assertArtifactId(artifactId); }
  catch { return artifactErrorResponse("ARTIFACT_NOT_FOUND", 404); }
  const record = await storage.get<StoredTaskArtifact>(artifactKey(scope.id, artifactId));
  if (!record || record.artifactId !== artifactId || !artifactMatchesScope(record, scope))
    return artifactErrorResponse("ARTIFACT_NOT_FOUND", 404);
  if (!Number.isSafeInteger(expiresAt) || expiresAt !== record.expiresAt || now >= record.expiresAt)
    return artifactErrorResponse("ARTIFACT_EXPIRED", 410);
  if (range !== null) return artifactErrorResponse("ARTIFACT_RANGE_UNSUPPORTED", 416);
  return verifiedArtifactDownload(record, now);
}

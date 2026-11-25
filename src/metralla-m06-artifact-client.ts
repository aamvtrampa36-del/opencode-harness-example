import {artifactDownloadPath, validateCaptureRequest, TASK_ARTIFACT_SCHEMA, TASK_ARTIFACT_MAX_BYTES, TASK_ARTIFACT_TTL_MS, type ArtifactView} from "./task-output-artifacts.ts";

function record(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

/** Validate metadata, not proof. The bytes must independently pass SHA-256 after authenticated GET. */
export function artifactClientView(raw: unknown): ArtifactView | null {
  const a = record(raw); if (!a) return null;
  const d = record(a.delivery);
  if (a.schema !== TASK_ARTIFACT_SCHEMA || typeof a.requestId !== "string" || !/^[a-f0-9]{16}$/.test(a.requestId) ||
      typeof a.artifactId !== "string" || !/^[a-f0-9]{32}$/.test(a.artifactId) ||
      typeof a.name !== "string" || typeof a.mime !== "string" ||
      typeof a.byteSize !== "number" || !Number.isSafeInteger(a.byteSize) || a.byteSize < 0 || a.byteSize > TASK_ARTIFACT_MAX_BYTES ||
      typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256) ||
      typeof a.createdAt !== "number" || !Number.isSafeInteger(a.createdAt) || a.createdAt < 0 ||
      !d || d.kind !== "authenticated-route" || typeof d.expiresAt !== "number" || !Number.isSafeInteger(d.expiresAt) ||
      d.expiresAt - a.createdAt !== TASK_ARTIFACT_TTL_MS) return null;
  try {
    const ext = a.name.slice(a.name.lastIndexOf(".") + 1).toLowerCase();
    validateCaptureRequest({path:"dist/verified." + ext, name:a.name, mime:a.mime});
    const path = artifactDownloadPath(a.requestId, a.artifactId, d.expiresAt);
    if (d.path !== path) return null;
    return {schema:TASK_ARTIFACT_SCHEMA,requestId:a.requestId,artifactId:a.artifactId,name:a.name,mime:a.mime,
      byteSize:a.byteSize,sha256:a.sha256,createdAt:a.createdAt,delivery:{kind:"authenticated-route",path,expiresAt:d.expiresAt}};
  } catch {return null;}
}

export function isReservedArtifactPart(raw: unknown): boolean {
  const a = record(raw);
  return Boolean(a && a.type === "file" && (a.artifact !== undefined ||
    (typeof a.uri === "string" && a.uri.includes("/api/supervisor/v1/tasks/"))));
}

export function withoutVerifiedArtifactParts(content?: readonly unknown[]): unknown[] {
  return (content ?? []).filter(x => !isReservedArtifactPart(x));
}

/** Only bounded typed tool results; no linkification of ordinary text, /bundle or untrusted URL. */
export function artifactClientViews(content?: readonly unknown[]): ArtifactView[] {
  const out: ArtifactView[] = []; const seen = new Set<string>();
  const add = (raw: unknown, expectedTask?: unknown) => {
    const v = artifactClientView(raw);
    if (!v || (expectedTask !== undefined && expectedTask !== v.requestId)) return;
    const key = v.requestId + ":" + v.artifactId;
    if (seen.has(key) || out.length >= 8) return;
    seen.add(key); out.push(v);
  };
  for (const raw of (content ?? []).slice(0,32)) {
    const item = record(raw); if (!item) continue;
    if (item.type === "file") {
      const v = artifactClientView(item.artifact);
      if (v && item.uri === v.delivery.path && item.mime === v.mime && item.name === v.name) add(v);
    } else if (item.type === "text" && typeof item.text === "string" && item.text.length <= 16_000) {
      try {
        const value = record(JSON.parse(item.text));
        if (!value || value.schema !== TASK_ARTIFACT_SCHEMA || value._responseTruncated === true) continue;
        if (Array.isArray(value.artifacts)) {
          if (typeof value.requestId !== "string" || !/^[a-f0-9]{16}$/.test(value.requestId) || value.artifacts.length > 8) continue;
          const list = value.artifacts.map(artifactClientView);
          if (list.some(x => !x || x.requestId !== value.requestId) || new Set(list.map(x=>x?.artifactId)).size !== list.length) continue;
          for (const v of list) add(v, value.requestId);
        } else add(value);
      } catch { /* plain text is not a file */ }
    }
  }
  return out;
}

export type ArtifactFetch = (path: string, init: RequestInit) => Promise<Response>;

/** Caller supplies existing authenticated transport. No credential input/storage, URL token or redirect. */
export async function verifiedClientArtifactBytes(raw: unknown, fetcher: ArtifactFetch, now = Date.now()): Promise<Uint8Array> {
  const v = artifactClientView(raw);
  if (!v) throw Error("ARTIFACT_METADATA_INVALID");
  if (now < v.createdAt || now >= v.delivery.expiresAt) throw Error("ARTIFACT_EXPIRED");
  const r = await fetcher(v.delivery.path, {method:"GET", credentials:"same-origin", cache:"no-store", redirect:"error",
    signal:AbortSignal.timeout(15_000)});
  if (r.status !== 200 || r.redirected) {
    await r.body?.cancel().catch(()=>undefined);
    throw Error(r.status === 401 || r.status === 403 ? "ARTIFACT_AUTH_REQUIRED" :
      r.status === 410 ? "ARTIFACT_EXPIRED" : r.status === 404 ? "ARTIFACT_NOT_FOUND" : "ARTIFACT_UNAVAILABLE");
  }
  if (r.headers.get("content-length") !== String(v.byteSize) ||
      r.headers.get("content-type") !== v.mime + "; charset=utf-8" ||
      !/^attachment;/i.test(r.headers.get("content-disposition") ?? "") ||
      r.headers.get("x-artifact-sha256") !== v.sha256) {
    await r.body?.cancel().catch(()=>undefined); throw Error("ARTIFACT_INTEGRITY_FAILURE");
  }
  const bytes = new Uint8Array(v.byteSize); let count = 0;
  const reader = r.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        if (count + value.length > bytes.length) {
          await reader.cancel().catch(()=>undefined); throw Error("ARTIFACT_INTEGRITY_FAILURE");
        }
        bytes.set(value,count); count += value.length;
      }
    } finally {reader.releaseLock();}
  }
  if (count !== bytes.length) throw Error("ARTIFACT_INTEGRITY_FAILURE");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,"0")).join("");
  if (hex !== v.sha256) throw Error("ARTIFACT_INTEGRITY_FAILURE");
  return bytes;
}

export function artifactDownloadError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "ARTIFACT_AUTH_REQUIRED") return "Descarga protegida: requiere un cliente supervisor autorizado.";
  if (code === "ARTIFACT_EXPIRED") return "Archivo vencido. Actualiza el manifiesto.";
  if (code === "ARTIFACT_NOT_FOUND") return "Archivo no disponible para esta tarea.";
  if (code === "ARTIFACT_INTEGRITY_FAILURE") return "La integridad del archivo no coincide. No se guardó.";
  return "No se pudo descargar el archivo de forma segura.";
}

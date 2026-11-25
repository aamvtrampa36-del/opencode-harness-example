/**
 * Export the persisted OpenCode conversation as a same-origin Markdown attachment.
 * Project identity comes from immutable server-side scope, not client input.
 */
const WORKSPACE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SESSION_ID = /^ses[A-Za-z0-9_]{1,64}$/;
const SECRET_FIELD = /(^|[_.\s-])(password|passphrase|token|secret|authorization|cookie|credential|api[_-]?key|private[_-]?key)([_.\s-]|$)/i;

export type PersistedConversation = {
  readonly messages: unknown;
  readonly project?: unknown;
  readonly repository?: unknown;
};

export function validateExportIdentity(object: unknown, session: unknown): void {
  if (typeof object !== "string" || !WORKSPACE_ID.test(object)) {
    throw new Error("Espacio de conversación inválido");
  }
  if (typeof session !== "string" || !SESSION_ID.test(session)) {
    throw new Error("Sesión inválida");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function redactText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[CLAVE PRIVADA REDACTADA]")
    .replace(/\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{12,}\b/g, "[REDACTADO]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTADO]")
    .replace(/\bBearer\s+[A-Za-z0-9_.~+/-]+/gi, "Bearer [REDACTADO]")
    .replace(/((?:api[_-]?key|password|passphrase|token|secret|authorization|cookie)\s*[:=]\s*["']?)([^\s,;"']+)/gi, "$1[REDACTADO]");
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 30) return "[profundidad omitida]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(item => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      safe[key] = SECRET_FIELD.test(key) ? "[REDACTADO]" : safeValue(field, depth + 1);
    }
    return safe;
  }
  return value;
}

function safeString(value: unknown): string {
  const safe = safeValue(value);
  return typeof safe === "string" ? safe : JSON.stringify(safe, null, 2) ?? "";
}

/** Output tools in a code fence longer than any backtick run inside their text. */
function codeFence(text: string, language = ""): string {
  const ticks = text.match(/\x60+/g) ?? [];
  const longest = Math.max(2, ...ticks.map(s => s.length));
  const delimiter = String.fromCharCode(96).repeat(longest + 1);
  return delimiter + language + "\n" + text + "\n" + delimiter;
}

function isoTime(message: Record<string, unknown>): string {
  const time = asObject(message.time);
  const original = time.created ?? time.completed ?? message.timestamp;
  if (typeof original === "string") {
    const millis = Date.parse(original);
    return Number.isNaN(millis) ? "" : new Date(millis).toISOString();
  }
  if (typeof original === "number" && Number.isFinite(original)) {
    const millis = original < 100_000_000_000 ? original * 1000 : original;
    const date = new Date(millis);
    return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
  }
  return "";
}

export function renderConversationMarkdown(session: string, data: PersistedConversation, exportedAt = new Date().toISOString()): string {
  if (!SESSION_ID.test(session)) throw new Error("Sesión inválida");
  if (!Array.isArray(data.messages)) throw new Error("Historial inválido");
  const project = typeof data.project === "string" ? safeString(data.project) : "Sin proyecto vinculado";
  const repository = typeof data.repository === "string" ? safeString(data.repository) : "Sin repositorio vinculado";
  const md: string[] = [
    "# Conversación de OpenCode Cloud", "",
    "- Sesión: " + session,
    "- Proyecto: " + project,
    "- Repositorio: " + repository,
    "- Exportado: " + exportedAt,
    "",
    "> Exportación del historial persistido. No contiene razonamiento interno. Se ocultan claves y tokens reconocibles; revisa el archivo antes de compartirlo.", ""
  ];
  for (const [index, raw] of data.messages.entries()) {
    const message = asObject(raw);
    const type = message.type;
    const label = type === "user" ? "Usuario" : type === "assistant" ? "Agente" : type === "synthetic" ? "Evento" : type === "compaction" ? "Compactación" : "Estado";
    const date = isoTime(message);
    md.push("## " + (index + 1) + ". " + label + (date ? " — " + date : ""), "");
    if (type === "user") {
      md.push(safeString(message.text ?? ""), "");
    } else if (type === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      for (const rawPart of parts) {
        const part = asObject(rawPart);
        if (part.type === "text") {
          md.push(safeString(part.text ?? ""), "");
        } else if (part.type === "tool") {
          const state = asObject(part.state);
          const name = safeString(part.name ?? "herramienta");
          const status = safeString(state.status ?? "desconocido");
          md.push("### Herramienta: " + name + " (" + status + ")", "");
          if (state.input !== undefined) md.push("**Entrada**", "", codeFence(safeString(state.input), "json"), "");
          if (state.content !== undefined) {
            const items = Array.isArray(state.content) ? state.content : [state.content];
            const contents = items.map(item => {
              const entry = asObject(item);
              return entry.type === "text" ? safeString(entry.text) : safeString(item);
            });
            md.push("**Resultado**", "", codeFence(contents.join("\n\n")), "");
          }
          if (state.error !== undefined) {
            const error = asObject(state.error);
            md.push("**Error**", "", codeFence(safeString(error.message ?? state.error)), "");
          }
        }
        // Never export internal chain-of-thought / reasoning parts.
      }
      const error = asObject(message.error);
      if (error.message !== undefined) md.push("**Error del agente:** " + safeString(error.message), "");
    } else if (type === "synthetic") {
      const value = safeString(message.description ?? message.text ?? "");
      if (!value.trim().startsWith("<system-reminder>")) md.push(value, "");
    } else if (type === "compaction") {
      md.push("Estado: " + safeString(message.status ?? "desconocido"), "");
    } else if (type === "idle") {
      md.push("Resultado de ejecución: " + safeString(message.outcome ?? "desconocido"), "");
    } else {
      md.push("[Tipo de mensaje no reconocido]", "");
    }
  }
  return md.join("\n").trimEnd() + "\n";
}

export function sessionExportResponse(session: string, data: PersistedConversation): Response {
  const markdown = renderConversationMarkdown(session, data);
  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="opencode-conversacion-' + session + '.md"',
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}

/** Export a verified bounded artifact page, not a hydrated transcript.
 * Individual artifact downloads remain the authoritative byte receipt. */
export async function taskArtifactExportResponse(
  storage: import("./task-output-artifacts.ts").ArtifactReadStorage,
  scope: import("./task-output-artifacts.ts").ArtifactTaskScope,
  format: "text" | "json", after?: string, limit = 2, now = Date.now()
): Promise<Response> {
  const { readTaskArtifactPage, artifactErrorResponse } = await import("./task-output-artifacts.ts");
  const { scopedArtifactDownload } = await import("./metralla-m06-artifact-http.ts");
  if (format !== "text" && format !== "json") return artifactErrorResponse("ARTIFACT_EXPORT_FORMAT_INVALID", 400);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2) return artifactErrorResponse("ARTIFACT_EXPORT_LIMIT", 400);
  const page = await readTaskArtifactPage(storage, scope, after, limit, now);
  const items: Array<{artifactId: string; name: string; sourceSha256: string; mime: string; sourceByteSize: number; text: string}> = [];
  for (const a of page.artifacts) {
    const response = await scopedArtifactDownload(storage, scope, a.artifactId, a.delivery.expiresAt, null, now);
    if (response.status !== 200) return artifactErrorResponse("ARTIFACT_EXPORT_UNAVAILABLE", 409);
    const text = new TextDecoder("utf-8", {fatal:true}).decode(await response.arrayBuffer());
    items.push({artifactId:a.artifactId,name:a.name,sourceSha256:a.sha256,mime:a.mime,sourceByteSize:a.byteSize,text:redactText(text)});
  }
  const body = format === "json" ? JSON.stringify({schema:"opencode.task-artifact-export.v1",requestId:scope.id,nextAfter:page.nextAfter,items})
    : items.map(a => a.name + "\nSHA-256 (original): " + a.sourceSha256 + "\n" + a.text).join("\n\n");
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > 512 * 1024) return artifactErrorResponse("ARTIFACT_EXPORT_LIMIT", 413);
  return new Response(bytes, {headers:{
    "Content-Type":format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Content-Disposition":'attachment; filename="task-artifacts.' + (format === "json" ? "json" : "txt") + '"',
    "Content-Length":String(bytes.length), "Cache-Control":"no-store, private", "X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"no-referrer", "Content-Security-Policy":"default-src 'none'; sandbox",
    ...(page.nextAfter ? {"X-Artifact-Next-After":page.nextAfter} : {})
  }});
}

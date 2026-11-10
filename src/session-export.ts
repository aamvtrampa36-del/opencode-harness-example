/**
 * Session export: same-origin, authenticated attachment.
 * This uses the persisted server transcript instead of a short-lived
 * browser blob URL that some Android browsers cancel on immediate revoke.
 */
import type { OpenCodeMessage } from "agents/harness/opencode";

const WORKSPACE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,80}$/;

export function validateExportIdentity(object: unknown, session: unknown): void {
  if (typeof object !== "string" || !WORKSPACE_ID.test(object)) {
    throw new Error("Espacio de conversación inválido");
  }
  if (typeof session !== "string" || !SESSION_ID.test(session)) {
    throw new Error("Sesión inválida");
  }
}

/** Explicit input prevents a filename or arbitrary client text controlling response headers. */
export function sessionExportResponse(session: string, messages: readonly OpenCodeMessage[]): Response {
  if (!SESSION_ID.test(session)) throw new Error("Sesión inválida");
  const result = {
    format: "opencode-harness-session-v1",
    exportedAt: new Date().toISOString(),
    session,
    messages
  };
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="opencode-session-' + session + '.json"',
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}

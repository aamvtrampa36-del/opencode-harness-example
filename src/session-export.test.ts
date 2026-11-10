import { describe, expect, test } from "bun:test";
import type { OpenCodeMessage } from "agents/harness/opencode";
import { validateExportIdentity, sessionExportResponse } from "./session-export";

const object = "2eb8e899-dd94-4733-b990-2fc99e0f7d5c";
const session = "ses_e3924f7e6ffedOa29YMzSIcVQ0";

describe("Android chat history export", () => {
  test("validates workspace and session identity before any data lookup", () => {
    expect(() => validateExportIdentity(object, session)).not.toThrow();
    expect(() => validateExportIdentity(object, "ses_root")).not.toThrow();
    expect(() => validateExportIdentity("../../etc", session)).toThrow("Espacio");
    expect(() => validateExportIdentity(object, "../session")).toThrow("Sesión");
    expect(() => validateExportIdentity("", "")).toThrow();
  });

  test("serves persisted transcript as native attachment with no caching", async () => {
    const messages = [
      { type: "user", id: "msg1", text: "Revisa el diff" },
      { type: "assistant", id: "msg2", content: [{type:"text",text:"Herramienta falló"}] }
    ] as unknown as OpenCodeMessage[];
    const response = sessionExportResponse(session, messages);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="opencode-session-' + session + '.json"'
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.json() as {
      format: string;
      session: string;
      messages: typeof messages;
      exportedAt: string;
    };
    expect(body.format).toBe("opencode-harness-session-v1");
    expect(body.session).toBe(session);
    expect(body.messages).toEqual(messages);
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
  });

  test("does not build a downloadable file from an invalid session identifier", () => {
    expect(() => sessionExportResponse('ses_valid"\nInjected: yes', [])).toThrow("Sesión");
  });
});

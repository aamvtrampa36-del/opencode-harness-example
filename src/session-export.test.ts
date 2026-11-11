import { describe, expect, test } from "bun:test";
import { validateExportIdentity, sessionExportResponse, renderConversationMarkdown } from "./session-export";

const object = "2eb8e899-dd94-4733-b990-2fc99e0f7d5c";
const session = "ses_e3924f7e6ffedOa29YMzSIcVQ0";

const cdf = {
  project: "repo-cdf-cloud-engine",
  repository: "aamvtrampa36-del/cdf-cloud-engine",
  messages: [
    { type: "user", id: "m1", text: "Ejecuta pruebas", time: { created: 1794420000000 } },
    { type: "assistant", id: "m2", time: { created: 1794420005000 },
      content: [
        { type: "text", text: "Prueba completa. PR #42" },
        { type: "tool", name: "linux", state: {
          status: "completed", input: { project: "repo-cdf-cloud-engine", command: "pwd && bun test" },
          content: [{ type: "text", text: "130 pass, 0 fail" }] } }
      ]
    }
  ]
};

describe("Markdown transcript download", () => {
  test("validates workspace and session identity", () => {
    expect(() => validateExportIdentity(object, session)).not.toThrow();
    expect(() => validateExportIdentity(object, "ses_root")).not.toThrow();
    expect(() => validateExportIdentity("../../etc", session)).toThrow("Espacio");
    expect(() => validateExportIdentity(object, "../session")).toThrow("Sesión");
    expect(() => validateExportIdentity("", "")).toThrow();
  });

  test("downloads persisted messages, tools, commands, results, timestamps, project and PR as Markdown", async () => {
    const response = sessionExportResponse(session, cdf);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="opencode-conversacion-' + session + '.md"');
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const md = await response.text();
    for (const required of ["repo-cdf-cloud-engine","cdf-cloud-engine","Ejecuta pruebas","Prueba completa","PR #42",
      "linux","pwd && bun test","130 pass, 0 fail","2026-11-11"]) {
      expect(md).toContain(required);
    }
    expect(md).not.toContain("CDF-WorkBench-");
  });

  test("exports WorkBench only when its own trusted session metadata is passed", () => {
    const workbench = renderConversationMarkdown("ses_workbench", {
      project: "repo-cdf-workbench-",
      repository: "aamvtrampa36-del/CDF-WorkBench-",
      messages: [{ type: "user", text: "Prueba independiente WorkBench" }]
    });
    expect(workbench).toContain("Prueba independiente WorkBench");
    expect(workbench).toContain("CDF-WorkBench-");
    expect(workbench).not.toContain("repo-cdf-cloud-engine");
    expect(workbench).not.toContain("Ejecuta pruebas");
  });

  test("redacts structured credentials and recognizable secrets in text, command and output", () => {
    const markdown = renderConversationMarkdown("ses_redaction", {
      messages: [{ type:"assistant", content: [
        { type:"text", text:"Authorization: Bearer super-secret-abcd and sk-proj-abcdefghijklmnop"},
        { type:"tool", name:"linux", state: { status:"error",
          input: { api_key:"sk-proj-abcdefghijklmnop", command:"echo token=mytoken123" },
          content:[{type:"text",text:"github_pat_abcdefghijklmno123456789"}],
          error: { message:"Bearer hidden-123456789" } } }
      ] }]
    });
    for (const secret of ["super-secret-abcd","sk-proj-abcdefghijklmnop","mytoken123","github_pat_abcdefghijklmno123456789","hidden-123456789"]) {
      expect(markdown).not.toContain(secret);
    }
    expect(markdown).toContain("[REDACTADO]");
    expect(markdown).toContain("**Error**");
  });

  test("does not export internal reasoning parts", () => {
    const text = renderConversationMarkdown("ses_reasoning", {
      messages: [{ type: "assistant", content: [{ type:"reasoning", text:"internal-only" }, { type:"text", text:"Respuesta final" }] }]
    });
    expect(text).toContain("Respuesta final");
    expect(text).not.toContain("internal-only");
  });

  test("rejects invalid session and malformed transcripts instead of downloading", () => {
    expect(() => sessionExportResponse('ses_valid"\nInjected: yes', { messages: [] })).toThrow("Sesión");
    expect(() => sessionExportResponse("ses_valid", { messages: null })).toThrow("Historial");
  });

  test("keeps tool logs with Markdown fences that cannot be closed by tool output", () => {
    const ticks = String.fromCharCode(96).repeat(3);
    const md = renderConversationMarkdown("ses_fences", {
      messages:[{type:"assistant",content:[{type:"tool",name:"linux",state:{
        status:"completed", input:{command:"echo yes"},content:[{type:"text",text:ticks + " pretend closing\nstill output"}]}}]}]
    });
    expect(md).toContain(ticks + " pretend closing");
    expect(md).toContain("still output");
    expect(md).toContain(ticks + String.fromCharCode(96) + "\n");
  });

  test("server worker-first routes include the session download endpoint", async () => {
    const { readFileSync } = await import("node:fs");
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(config).toContain('"/api/session/*"');
    const staging = readFileSync(new URL("../wrangler.g1.jsonc", import.meta.url), "utf8");
    expect(staging).toContain('"/api/session/*"');
  });
});

import { describe, expect, test } from "bun:test";
import { OpenCodeSessionSockets } from "./sockets";
import { DEFAULT_SPECIALIZATIONS, mergeSpecializations, validateSpecialization } from "./specializations";
import type { OpenCodeHarness } from "agents/harness/opencode";
import type { Connection } from "agents/lifecycle";

describe("G6 live template use without redeployment", () => {
  test("a subsequent submit reads the edited settings and changes the actual prompt sent to the harness", async () => {
    let overrides = [validateSpecialization({
      ...DEFAULT_SPECIALIZATIONS[4],
      instructions: "Empieza la respuesta con ALFA-G6."
    })];
    const instructionsUsed: string[] = [];
    const agentsUsed: string[] = [];
    const modelsUsed: unknown[] = [];
    const sessionRoles: { decisionModel?: string; imageModel?: string }[] = [];
    const fakeHandle = {
      setModel: async (value: unknown) => { modelsUsed.push(value); },
      setAgent: async (value: string) => { agentsUsed.push(value); },
      submit: async (text: string) => {
        instructionsUsed.push(text);
        return { operationId: "op-g6" };
      },
      wait: async () => undefined,
      history: async () => [],
      busy: async () => false,
      events: async () => ({ start: () => undefined, stop: async () => undefined })
    };
    const harness = {
      session: () => fakeHandle,
      sessions: { list: async () => [{ id: "ses_root", busy: false }] },
      pending: async () => []
    } as unknown as OpenCodeHarness;
    const messages: string[] = [];
    const socket = {
      tags: ["opencode-session:ses_root"],
      readyState: 1,
      send: (data: string) => { messages.push(data); }
    } as unknown as Connection;
    const service = new OpenCodeSessionSockets(
      harness, () => [socket as unknown as WebSocket], async () => false,
      async (id: string) => mergeSpecializations(overrides).find(x => x.id === id && x.enabled),
      async () => undefined,
      async () => undefined,
      async () => undefined,
      async (_session, roles) => { sessionRoles.push(roles); },
      async () => "google/imagen-4"
    );
    const callbacks = service.options().handlers;
    const submit = async (text: string) => {
      await callbacks.onMessage(socket, JSON.stringify({
        type: "submit", id: "request-g6", text,
        specialization: "decisiones", mode: "plan", model: "cloudflare"
      }));
    };

    await submit("Compara las opciones.");
    expect(instructionsUsed).toHaveLength(1);
    expect(instructionsUsed[0]).toContain("ALFA-G6");
    expect(agentsUsed).toContain("plan");
    expect(modelsUsed).toHaveLength(1);
    expect(sessionRoles[0]).toEqual({ decisionModel: "reasoning", imageModel: "google/imagen-4" });

    // Simulates POST /api/settings/specializations saving a changed record:
    // the same live Agent, socket and code must fetch the new instructions.
    overrides = [validateSpecialization({
      ...overrides[0], instructions: "Empieza la respuesta con BETA-G6."
    })];
    await submit("Compara las opciones.");
    expect(instructionsUsed).toHaveLength(2);
    expect(instructionsUsed[1]).toContain("BETA-G6");
    expect(instructionsUsed[1]).not.toContain("ALFA-G6");
    expect(messages.some(x => x.includes('"type":"result"'))).toBe(true);

    overrides = [];
    await submit("Compara las opciones.");
    expect(instructionsUsed[2]).toContain(DEFAULT_SPECIALIZATIONS[4].instructions);
    expect(instructionsUsed[2]).not.toContain("BETA-G6");
  });

  test("an image model saved in the active template is bound to the conversation", async () => {
    const profile = validateSpecialization({
      id: "imagen", name: "Imagen", instructions: "Crea imágenes cuando lo pida.",
      enabled: true, mode: "build", model: "cloudflare", imageModel: "google/imagen-4"
    });
    const sessionRoles: { decisionModel?: string; imageModel?: string }[] = [];
    const fakeHandle = {
      setModel: async () => undefined,
      setAgent: async () => undefined,
      submit: async () => ({ operationId: "op-image" }),
      wait: async () => undefined,
      history: async () => [],
      busy: async () => false,
      events: async () => ({ start: () => undefined, stop: async () => undefined })
    };
    const harness = {
      session: () => fakeHandle,
      sessions: { list: async () => [{ id: "ses_root", busy: false }] },
      pending: async () => []
    } as unknown as OpenCodeHarness;
    const socket = {
      tags: ["opencode-session:ses_root"], readyState: 1, send: () => undefined
    } as unknown as Connection;
    const service = new OpenCodeSessionSockets(
      harness, () => [socket as unknown as WebSocket], async () => false,
      async id => id === profile.id ? profile : undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      async (_session, roles) => { sessionRoles.push(roles); },
      async () => "openai/gpt-image-1"
    );
    await service.options().handlers.onMessage(socket, JSON.stringify({
      type: "submit", id: "request-image", text: "Haz una ilustración", specialization: profile.id,
      mode: "build", model: "cloudflare"
    }));
    expect(sessionRoles).toEqual([{ imageModel: "google/imagen-4" }]);
  });
});

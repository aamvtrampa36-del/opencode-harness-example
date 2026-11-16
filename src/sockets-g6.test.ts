import { describe, expect, test } from "bun:test";
import { OpenCodeSessionSockets } from "./sockets";
import { DEFAULT_SPECIALIZATIONS, mergeSpecializations, validateSpecialization } from "./specializations";
import type { OpenCodeHarness } from "agents/harness/opencode";
import type { Connection } from "agents/lifecycle";

describe("G6 live template use without redeployment", () => {
  test("a subsequent submit reads the edited settings and changes the actual prompt sent to the harness", async () => {
    let overrides = [validateSpecialization({
      id: "decisiones", name: "Decisiones", enabled: true, model: "cloudflare", decisionModel: "reasoning",
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
    expect(instructionsUsed).toHaveLength(2);
    expect(messages.some(x => x.includes("ya no existe o está desactivada"))).toBe(true);
  });

  test("runs configured stages in order and switches to each stage's model", async () => {
    const profile = validateSpecialization({
      id: "stage-test", name: "Etapas", instructions: "Conserva el objetivo.", enabled: true,
      model: "cloudflare", stages: [
        { name: "Decidir", instructions: "Analiza en solo lectura.", model: "cloudflare", mode: "plan" },
        { name: "Actuar", instructions: "Realiza la acción aprobada.", model: "openrouter:openrouter/auto", mode: "build" }
      ]
    });
    const prompts: string[] = [];
    const models: Array<{ providerID: string; id: string }> = [];
    let operation = 0;
    const handle = {
      setModel: async (model: { providerID: string; id: string }) => { models.push(model); },
      setAgent: async () => undefined,
      submit: async (input: string | { text: string }) => {
        prompts.push(typeof input === "string" ? input : input.text);
        return { operationId: `stage-op-${++operation}` };
      },
      wait: async () => undefined,
      history: async () => [], busy: async () => false,
      events: async () => ({ start: () => undefined, stop: async () => undefined })
    };
    const harness = { session: () => handle, sessions: { list: async () => [{ id: "ses_root", busy: false }] }, pending: async () => [] } as unknown as OpenCodeHarness;
    const frames: string[] = [];
    const keepAlive: Promise<unknown>[] = [];
    const socket = { tags: ["opencode-session:ses_root"], readyState: 1, send: (data: string) => frames.push(data) } as unknown as Connection;
    const service = new OpenCodeSessionSockets(harness, () => [socket as unknown as WebSocket], async () => true,
      async id => id === profile.id ? profile : undefined,
      undefined, undefined, undefined, undefined, undefined, promise => { keepAlive.push(promise); });
    await service.options().handlers.onMessage(socket, JSON.stringify({
      type: "submit", id: "workflow", text: "Lee y resume package.json", model: "cloudflare", mode: "build", specialization: profile.id
    }));
    expect(keepAlive).toHaveLength(1);
    await keepAlive[0];
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("FLUJO 1/2 · Decidir");
    expect(prompts[1]).toContain("FLUJO 2/2 · Actuar");
    expect(models.some(model => model.providerID === "openrouter" && model.id === "openrouter/auto")).toBe(true);
    expect(frames.some(frame => frame.includes('"status":"completed"'))).toBe(true);
  });

  test("stopping a staged task does not start its next step", async () => {
    const profile = validateSpecialization({ id: "stop-flow", name: "Detener flujo", instructions: "Evidencia.", enabled: true,
      model: "cloudflare", stages: [
        { name: "Leer", instructions: "Lee los datos.", model: "cloudflare", mode: "plan" },
        { name: "Cambiar", instructions: "Cambia un archivo.", model: "cloudflare", mode: "build" }
      ] });
    let releaseWait!: () => void;
    const prompts: string[] = [];
    const frames: string[] = [];
    const handle = {
      setModel: async () => undefined, setAgent: async () => undefined,
      submit: async (input: string) => { prompts.push(input); return { operationId: "first-stage" }; },
      wait: async () => await new Promise<void>(resolve => { releaseWait = resolve; }),
      abort: async () => undefined, history: async () => [], busy: async () => false,
      events: async () => ({ start: () => undefined, stop: async () => undefined })
    };
    const harness = { session: () => handle, sessions: { list: async () => [{ id: "ses_root", busy: true }] }, pending: async () => [] } as unknown as OpenCodeHarness;
    const socket = { tags: ["opencode-session:ses_root"], readyState: 1, send: (data: string) => frames.push(data) } as unknown as Connection;
    const service = new OpenCodeSessionSockets(harness, () => [socket as unknown as WebSocket], async () => false,
      async id => id === profile.id ? profile : undefined);
    const handlers = service.options().handlers;
    await handlers.onMessage(socket, JSON.stringify({ type: "submit", text: "Revisa sin cambiar.", model: "cloudflare", specialization: profile.id }));
    await new Promise(resolve => setTimeout(resolve, 0));
    await handlers.onMessage(socket, JSON.stringify({ type: "abort" }));
    releaseWait();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(1);
    expect(frames.some(frame => frame.includes('"status":"cancelled"'))).toBe(true);
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

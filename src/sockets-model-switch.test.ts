import { describe, expect, test } from "bun:test";
import { OpenCodeSessionSockets } from "./sockets";
import type { OpenCodeHarness } from "agents/harness/opencode";
import type { Connection } from "agents/lifecycle";
import type { ModelSelectionID } from "./model-presets";
import type { ModelRun } from "./protocol";

function setup(routerReady = false) {
  let selected: ModelSelectionID | undefined;
  let busy = false;
  let counter = 0;
  const models: {providerID: string; id: string}[] = [];
  const modelRuns: ModelRun[] = [];
  const prompts: string[] = [];
  const events: Record<string, unknown>[] = [];
  const fakeHandle = {
    setModel: async (model: { providerID: string; id: string }) => { models.push(model); },
    setAgent: async () => undefined,
    submit: async (input: string) => { prompts.push(input); return { operationId: "run-" + (++counter) }; },
    wait: async () => undefined,
    history: async () => [],
    busy: async () => busy,
    events: async () => ({ start: () => undefined, stop: async () => undefined })
  };
  const harness = {
    session: () => fakeHandle,
    sessions: { list: async () => [{ id: "ses_root", busy }] },
    pending: async () => []
  } as unknown as OpenCodeHarness;
  const sent: string[] = [];
  const socket = {
    tags: ["opencode-session:ses_root"], readyState: 1,
    send: (value: string) => { sent.push(value); events.push(JSON.parse(value)); }
  } as unknown as Connection;
  const service = new OpenCodeSessionSockets(
    harness, () => [socket as unknown as WebSocket], async () => routerReady,
    undefined, undefined, undefined, undefined, undefined, undefined,
    async () => undefined,
    async () => selected, async (_session: string, model: ModelSelectionID) => { selected = model; },
    async () => modelRuns, async (_session: string, run: ModelRun) => { modelRuns.push(run); }
  );
  return {
    get selected() { return selected; }, get models() { return models; },
    get events() { return events; }, get prompts() { return prompts; },
    get modelRuns() { return modelRuns; },
    setBusy: (value: boolean) => { busy = value; },
    send: async (value: Record<string, unknown>) => service.options().handlers.onMessage(
      socket, JSON.stringify({ id: "test-" + Math.random().toString(36).slice(2), ...value })
    )
  };
}

describe("per-conversation multimodel switching through actual socket dispatcher", () => {
  test("DeepSeek → GLM → DeepSeek uses the same session without erasing history", async () => {
    const app = setup();
    for (const [model, id] of [
      ["economy", "@cf/deepseek-ai/deepseek-v4.1-flash-1017"],
      ["cloudflare", "@cf/zai-org/glm-4.7-flash"],
      ["economy", "@cf/deepseek-ai/deepseek-v4.1-flash-1017"]
    ] as const) {
      await app.send({ type: "select_model", model });
      expect(app.selected).toBe(model);
      expect(app.events.some(event => event.type === "model_selection" && event.model === model)).toBe(true);
      await app.send({ type: "submit", text: "Continue existing task", mode: "build" });
      expect(app.models.at(-1)).toEqual({ providerID: "cloudflare", id });
    }
    expect(app.prompts).toHaveLength(3);
    expect(app.modelRuns).toHaveLength(3);
    expect(app.modelRuns.map(run => run.id)).toEqual([
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      "@cf/zai-org/glm-4.7-flash",
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017"
    ]);
    expect(app.modelRuns.every(run => run.providerID === "cloudflare" && run.operationId.startsWith("run-"))).toBe(true);
  });

  test("switching while a task is busy only records next-turn selection", async () => {
    const app = setup();
    await app.send({ type: "select_model", model: "economy" });
    app.setBusy(true);
    await app.send({ type: "select_model", model: "cloudflare" });
    expect(app.selected).toBe("cloudflare");
    expect(app.models).toHaveLength(1);
    expect(app.events.some(e => e.type === "model_selection" && e.model === "cloudflare" && e.pending === true)).toBe(true);
    app.setBusy(false);
    await app.send({ type: "submit", text: "Continue", mode: "build" });
    expect(app.models.at(-1)?.id).toBe("@cf/zai-org/glm-4.7-flash");
  });

  test("unavailable provider and unknown model keep the confirmed state untouched", async () => {
    const app = setup();
    await app.send({ type: "select_model", model: "economy" });
    await app.send({ type: "select_model", model: "reasoning" });
    expect(app.selected).toBe("economy");
    expect(app.events.some(e => e.type === "error" && String(e.message).includes("OpenRouter"))).toBe(true);
    await app.send({ type: "select_model", model: "not-real" });
    expect(app.selected).toBe("economy");
    expect(app.events.some(e => e.type === "error" && String(e.message).includes("no reconocido"))).toBe(true);
  });
});

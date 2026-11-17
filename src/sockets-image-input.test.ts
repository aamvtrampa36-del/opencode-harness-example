import { describe, expect, test } from "bun:test";
import { OpenCodeSessionSockets } from "./sockets";
import type { OpenCodeHarness } from "agents/harness/opencode";
import type { Connection } from "agents/lifecycle";

function rig() {
  const submitted: unknown[] = [];
  const selected: unknown[] = [];
  const frames: string[] = [];
  const handle = {
    setModel: async (model: unknown) => { selected.push(model); },
    setAgent: async () => undefined,
    submit: async (input: unknown) => { submitted.push(input); return { operationId: "image-test" }; },
    wait: async () => undefined,
    history: async () => [], busy: async () => false,
    events: async () => ({ start: () => undefined, stop: async () => undefined })
  };
  const harness = { session: () => handle,
    sessions: { list: async () => [{ id: "ses_root", busy: false }] }, pending: async () => []
  } as unknown as OpenCodeHarness;
  const socket = { tags: ["opencode-session:ses_root"], readyState: 1,
    send: (data: string) => frames.push(data) } as unknown as Connection;
  const service = new OpenCodeSessionSockets(harness, () => [socket as unknown as WebSocket],
    async () => true);
  return { submitted, selected, frames,
    send: (model: string) => service.options().handlers.onMessage(socket, JSON.stringify({
      type: "submit", id: "image-request", text: "Describe this",
      model, files: [{ mime: "image/png", name: "test.png", data: "aGVsbG8=" }]
    }))
  };
}

describe("mobile image input reaches OpenCode", () => {
  test("validates image capability and submits a data URI with the concrete model", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
      id: "openai/gpt-4.1-mini", name: "Vision model", supported_parameters: ["tools"],
      architecture: { input_modalities: ["text", "image"] }
    }] }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      const app = rig();
      await app.send("openrouter:openai/gpt-4.1-mini");
      expect(app.selected).toEqual([{ providerID: "openrouter", id: "openai/gpt-4.1-mini" }]);
      expect(app.submitted).toEqual([{
        text: "Describe this",
        files: [{ uri: "data:image/png;base64,aGVsbG8=", name: "test.png" }]
      }]);
      expect(app.frames.some(frame => frame.includes('"type":"result"'))).toBe(true);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("refuses images with a non-vision Cloudflare model", async () => {
    const app = rig();
    await app.send("cloudflare");
    expect(app.submitted).toHaveLength(0);
    expect(app.frames.some(frame => frame.includes("compatible con imágenes"))).toBe(true);
  });
});

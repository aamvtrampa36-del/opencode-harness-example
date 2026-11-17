import { describe, expect, test } from "bun:test";
import { OpenCodeSessionSockets } from "./sockets";
import type { OpenCodeHarness } from "agents/harness/opencode";
import type { Connection } from "agents/lifecycle";

function rig(routerReady: boolean, failWait = false) {
  const configured: unknown[] = [];
  const requests: string[] = [];
  const fakeHandle = {
    setModel: async (value: unknown) => { configured.push(value); },
    setAgent: async () => undefined,
    submit: async (text: string) => { requests.push(text); return { operationId: "test-model-run" }; },
    wait: async () => { if (failWait) throw new Error("simulated-provider-failure"); },
    history: async () => [],
    busy: async () => false,
    events: async () => ({ start: () => undefined, stop: async () => undefined })
  };
  const harness = {
    session: () => fakeHandle,
    sessions: { list: async () => [{ id: "ses_root", busy: false }] },
    pending: async () => []
  } as unknown as OpenCodeHarness;
  const sent: string[] = [];
  const socket = {
    tags: ["opencode-session:ses_root"],
    readyState: 1,
    send: (message: string) => { sent.push(message); }
  } as unknown as Connection;
  const service = new OpenCodeSessionSockets(
    harness, () => [socket as unknown as WebSocket],
    async () => routerReady
  );
  return {
    configured, requests, sent,
    send: async (model: string) => service.options().handlers.onMessage(
      socket,
      JSON.stringify({ type: "submit", id: "model-test", text: "Lee un archivo",
        mode: "build", model })
    )
  };
}

describe("actual session model dispatch", () => {
  test("the economical simple profile keeps its configured provider model", async () => {
    // Native Workers AI must remain usable when OpenRouter is not configured.
    const app = rig(false);
    await app.send("economy");
    expect(app.configured).toEqual([{providerID:"cloudflare",id:"@cf/deepseek-ai/deepseek-v4.1-flash-1017"}]);
    expect(app.requests).toHaveLength(1);
    const sessions = app.sent.map(message => JSON.parse(message) as { type?: string; sessions?: { id: string; busy: boolean }[] })
      .find(message => message.type === "sessions");
    expect(sessions?.sessions).toEqual([{ id: "ses_root", busy: true }]);
  });
  test("the Auto Code choice reaches the real harness model setter", async () => {
    const app = rig(true);
    await app.send("openrouter:openrouter/auto-code");
    expect(app.configured).toEqual([{ providerID: "openrouter", id: "openrouter/auto-code" }]);
    expect(app.requests).toHaveLength(1);
    expect(app.sent.some(message => message.includes('"type":"result"'))).toBe(true);
  });
  test("the Auto Router choice uses the official OpenRouter model ID", async () => {
    const app = rig(true);
    await app.send("openrouter:openrouter/auto");
    expect(app.configured).toEqual([{ providerID: "openrouter", id: "openrouter/auto" }]);
  });
  test("a concrete tool-capable OpenRouter model reaches the session setter", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({data:[{
      id:"openai/gpt-4.1-mini", name:"GPT-4.1 mini",
      supported_parameters:["tools"], pricing:{prompt:"0.000001",completion:"0.000004"}
    }]}), {status:200,headers:{"content-type":"application/json"}});
    try {
      const app = rig(true);
      await app.send("openrouter:openai/gpt-4.1-mini");
      expect(app.configured).toEqual([{providerID:"openrouter",id:"openai/gpt-4.1-mini"}]);
      expect(app.requests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("a rejected agent operation clears the busy state and exposes its error", async () => {
    const app = rig(false, true);
    await app.send("economy");
    await Bun.sleep(10);
    const events = app.sent.map(value => JSON.parse(value) as { type?: string; message?: string; busy?: boolean });
    expect(events.some(value => value.type === "error" && value.message?.includes("simulated-provider-failure"))).toBe(true);
    const snapshots = events.filter(value => value.type === "snapshot");
    expect(snapshots.at(-1)?.busy).toBe(false);
    expect(app.configured).toEqual([{ providerID: "cloudflare", id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" }]);
  });

  test("no private credential means no OpenRouter invocation", async () => {
    const app = rig(false);
    await app.send("openrouter:openrouter/auto");
    expect(app.configured).toHaveLength(0);
    expect(app.requests).toHaveLength(0);
    expect(app.sent.some(message => message.includes('"type":"error"'))).toBe(true);
  });
});

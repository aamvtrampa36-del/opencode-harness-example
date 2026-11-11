import { describe, expect, test } from "bun:test";
import { OpenCodeSessionSockets } from "./sockets";
import type { OpenCodeHarness } from "agents/harness/opencode";
import type { Connection } from "agents/lifecycle";

function setup() {
  let running = false;
  let staleBusy = false;
  const agents: string[] = [];
  const models: string[] = [];
  const prompts: string[] = [];
  const frames: string[] = [];
  const socket = { tags: ["opencode-session:ses_root"], readyState: 1, send: (value: string) => frames.push(value) } as unknown as Connection;
  const handle = {
    setAgent: async (agent: string) => { agents.push(agent); },
    setModel: async (model: { id: string }) => { models.push(model.id); },
    submit: async (text: string) => { prompts.push(text); running = true; return { operationId: "op" }; },
    wait: async () => await new Promise<void>(() => {}),
    history: async () => [], busy: async () => staleBusy ? false : running,
    events: async () => ({ start: () => {}, stop: async () => {} })
  };
  const harness = { session: () => handle, sessions: { list: async () => [{ id: "ses_root", busy: running }] }, pending: async () => [] } as unknown as OpenCodeHarness;
  const makeSockets = () => new OpenCodeSessionSockets(harness, () => [socket as unknown as WebSocket], async () => true);
  const send = async (s: OpenCodeSessionSockets, mode: string, model = "cloudflare") => {
    await s.options().handlers.onMessage(socket, JSON.stringify({type: "submit", id: "test", text: "review", mode, model, whenBusy: "followUp"}));
  };
  return { makeSockets, send, agents, models, prompts, frames, makeBusyStale: () => { staleBusy = true; } };
}

describe("in-flight session configuration", () => {
  test("does not switch an active review to development", async () => {
    const x = setup(), s = x.makeSockets();
    await x.send(s, "review");
    await x.send(s, "build");
    expect(x.agents).toEqual(["plan"]);
    expect(x.prompts).toHaveLength(1);
    expect(x.frames.some(frame => frame.includes("Espera a que termine"))).toBe(true);
  });

  test("can queue an instruction with the existing mode and model", async () => {
    const x = setup(), s = x.makeSockets();
    await x.send(s, "review");
    await x.send(s, "review");
    expect(x.agents).toEqual(["plan"]);
    expect(x.models).toHaveLength(1);
    expect(x.prompts).toHaveLength(2);
  });

  test("concurrent submissions cannot upgrade a running review", async () => {
    const x = setup(), s = x.makeSockets();
    await Promise.all([x.send(s, "review"), x.send(s, "build")]);
    expect(x.agents).toEqual(["plan"]);
    expect(x.prompts).toHaveLength(1);
  });

  test("cannot change model during an active run", async () => {
    const x = setup(), s = x.makeSockets();
    await x.send(s, "review", "cloudflare");
    await x.send(s, "review", "economy");
    expect(x.models).toHaveLength(1);
    expect(x.prompts).toHaveLength(1);
  });

  test("a stale idle flag cannot upgrade an unfinished review", async () => {
    const x = setup(), s = x.makeSockets();
    await x.send(s, "review");
    x.makeBusyStale();
    await x.send(s, "build");
    expect(x.agents).toEqual(["plan"]);
    expect(x.prompts).toHaveLength(1);
  });

  test("reports unfinished work as busy even if the underlying busy flag is stale", async () => {
    const x = setup(), s = x.makeSockets();
    await x.send(s, "review");
    x.makeBusyStale();
    x.frames.length = 0;
    const socket = { tags: ["opencode-session:ses_root"], readyState: 1, send: (value: string) => x.frames.push(value) } as unknown as Connection;
    await s.options().handlers.onMessage(socket, JSON.stringify({ type: "resync" }));
    const snapshot = x.frames.map(frame => JSON.parse(frame)).find(frame => frame.type === "snapshot");
    expect(snapshot.busy).toBe(true);
  });

  test("rejects changes when the running configuration is unknown", async () => {
    const x = setup(), first = x.makeSockets();
    await x.send(first, "review");
    const restarted = x.makeSockets();
    await x.send(restarted, "build");
    expect(x.agents).toEqual(["plan"]);
    expect(x.prompts).toHaveLength(1);
    expect(x.frames.some(frame => frame.includes("Espera a que termine"))).toBe(true);
  });
});

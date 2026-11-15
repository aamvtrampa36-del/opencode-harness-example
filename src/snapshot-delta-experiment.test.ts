import { describe, expect, test } from "bun:test";
import type { OpenCodeMessage, OpenCodeSessionEvent } from "agents/harness/opencode";
import { OpenCodeSessionSockets } from "./sockets";
import { applySnapshotDelta, makeSnapshotPacket } from "./snapshot-delta";
import type { ServerMessage, SessionSnapshot } from "./protocol";
import type { Connection } from "agents/lifecycle";

function textMessage(id: string, text: string): OpenCodeMessage {
  return { type: "user", id, text, time: { created: 1 } } as unknown as OpenCodeMessage;
}
function snapshot(messages: readonly OpenCodeMessage[]): SessionSnapshot {
  return { session: "ses_root", messages, busy: true, pending: [] };
}

describe("experimental wire snapshot correctness", () => {
  test("appends and updates while preserving every message", () => {
    const old = Array.from({ length: 12 }, (_, i) =>
      textMessage("m" + i, "unchanged ".repeat(20)));
    const newer = [...old.slice(0, -1), textMessage("m11", "after"), textMessage("m12", "third")];
    const baseline = makeSnapshotPacket(snapshot(old));
    expect(baseline.packet.type).toBe("snapshot");
    const update = makeSnapshotPacket(snapshot(newer), baseline.cache);
    expect(update.packet.type).toBe("snapshot_delta");
    if (update.packet.type !== "snapshot_delta") throw new Error("No delta");
    expect(update.packet.from).toBe(11);
    expect(applySnapshotDelta(old, update.packet)).toEqual(newer);
    expect(applySnapshotDelta([], update.packet)).toBeUndefined();
  });

  test("tiny updates can fall back to a complete packet when cheaper", () => {
    const tiny = [textMessage("first", "a"), textMessage("second", "b")];
    const old = makeSnapshotPacket(snapshot(tiny));
    const later = makeSnapshotPacket(snapshot([tiny[0], textMessage("second", "new")]), old.cache);
    expect(later.packet.type).toBe("snapshot");
  });

  test("handles compaction and a different base through a full snapshot", () => {
    const old = Array.from({ length: 12 }, (_, i) => textMessage("msg" + i, "x".repeat(120)));
    const initial = makeSnapshotPacket(snapshot(old));
    const compacted = [textMessage("compact", "summary")];
    const update = makeSnapshotPacket(snapshot(compacted), initial.cache);
    expect(update.packet.type).toBe("snapshot");
    expect(update.packet.type === "snapshot" ? update.packet.messages : []).toEqual(compacted);
  });
});

type Scenario = "short" | "long" | "rewrite";
type Delivery = "full" | "delta";
type Bench = {
  readonly delivery: Delivery;
  readonly scenario: Scenario;
  readonly bytes: number;
  readonly totalPackets: number;
  readonly fullSnapshots: number;
  readonly deltaSnapshots: number;
  readonly historyReads: number;
  readonly milliseconds: number;
  readonly valid: boolean;
};

/**
 * Calls the ACTUAL app's WebSocket handler and snapshot path. Only the Harness,
 * WebSocket wire and persisted transcript are replaced with deterministic
 * fakes. No model, internet, live DO or token billing is involved.
 */
async function exercise(delivery: Delivery, scenario: Scenario): Promise<Bench> {
  const count = scenario === "long" ? 160 : scenario === "rewrite" ? 24 : 6;
  const events = scenario === "long" ? 25 : scenario === "rewrite" ? 8 : 4;
  const padding = scenario === "long" ? 1400 : 400;
  let history = Array.from({ length: count }, (_, i) =>
    textMessage("m" + i, "file " + i + "\n" + ("content/" + i).padEnd(padding, "#")));
  let readCount = 0;
  let observer: ((events: readonly OpenCodeSessionEvent[]) => void) | undefined;
  const packets: ServerMessage[] = [];
  const sockets: Connection[] = [];
  const socket = {
    readyState: 1,
    tags: ["opencode-session:ses_root"],
    send: (value: string) => { packets.push(JSON.parse(value) as ServerMessage); }
  } as unknown as Connection;
  sockets.push(socket);
  const handle = {
    history: async () => { readCount++; return structuredClone(history); },
    busy: async () => true,
    events: async () => ({
      start: (fn: (events: readonly OpenCodeSessionEvent[]) => void) => { observer = fn; },
      stop: async () => undefined
    })
  };
  const harness = {
    session: () => handle,
    sessions: { list: async () => [{ id: "ses_root", busy: true }] },
    pending: async () => []
  };
  const service = new OpenCodeSessionSockets(
    harness as never,
    (_tag?: string) => sockets as unknown as WebSocket[],
    async () => false,
    async () => undefined,
    async () => undefined,
    async () => undefined,
    async () => undefined,
    delivery
  );
  const start = performance.now();
  await service.options().handlers.onConnect(socket, {
    request: new Request("https://example.com/?session=ses_root")
  } as never);

  for (let t = 0; t < 15 && !observer; t++) await Bun.sleep(1);
  if (!observer) throw new Error("OpenCode event stream not attached");

  for (let i = 0; i < events; i++) {
    if (scenario === "rewrite" && i === 4) {
      history = [textMessage("compact", "summary of previous turns"), ...history.slice(-3)];
    } else {
      const last = history.length - 1;
      const value = history[last] as unknown as { id: string; text: string };
      history[last] = textMessage(value.id, value.text + " tool result " + i + "!");
    }
    const n = packets.filter(x => x.type === "snapshot" || x.type === "snapshot_delta").length;
    observer([{ type: "tool_end" } as OpenCodeSessionEvent]);
    for (let t = 0; t < 40; t++) {
      if (packets.filter(x => x.type === "snapshot" || x.type === "snapshot_delta").length > n) break;
      await Bun.sleep(1);
    }
    if (packets.filter(x => x.type === "snapshot" || x.type === "snapshot_delta").length <= n)
      throw new Error("No snapshot after event " + i);
  }

  let reconstructed: readonly OpenCodeMessage[] = [];
  for (const p of packets) {
    if (p.type === "snapshot") reconstructed = p.messages;
    else if (p.type === "snapshot_delta") {
      const next = applySnapshotDelta(reconstructed, p);
      if (!next) throw new Error("Delta base mismatch");
      reconstructed = next;
    }
  }
  const valid = JSON.stringify(reconstructed) === JSON.stringify(history);
  const end = performance.now();
  return {
    scenario, delivery,
    bytes: packets.reduce((sum, p) => sum + Buffer.byteLength(JSON.stringify(p)), 0),
    totalPackets: packets.length,
    fullSnapshots: packets.filter(p => p.type === "snapshot").length,
    deltaSnapshots: packets.filter(p => p.type === "snapshot_delta").length,
    historyReads: readCount,
    milliseconds: Number((end - start).toFixed(3)),
    valid
  };
}

describe("snapshot subscription lifecycle", () => {
  test("a late socket gets full state, later gets deltas, and resync resets its base", async () => {
    let history = Array.from({ length: 20 }, (_, i) => textMessage("m" + i, "body ".repeat(110)));
    const a: ServerMessage[] = [];
    const b: ServerMessage[] = [];
    let observer: ((events: readonly OpenCodeSessionEvent[]) => void) | undefined;
    const createSocket = (received: ServerMessage[]) => ({
      readyState: 1,
      tags: ["opencode-session:ses_root"],
      send: (value: string) => received.push(JSON.parse(value) as ServerMessage)
    } as unknown as Connection);
    const one = createSocket(a);
    const two = createSocket(b);
    const active = [one];
    const harness = {
      session: () => ({
        history: async () => structuredClone(history),
        busy: async () => true,
        events: async () => ({ start: (fn: (events: readonly OpenCodeSessionEvent[]) => void) => {
          observer = fn;
        }, stop: async () => undefined })
      }),
      sessions: { list: async () => [{ id: "ses_root", busy: true }] },
      pending: async () => []
    };
    const service = new OpenCodeSessionSockets(
      harness as never, () => active as unknown as WebSocket[],
      async () => false, async () => undefined,
      async () => undefined, async () => undefined, async () => undefined, "delta"
    );
    const ctx = { request: new Request("https://example.com/?session=ses_root") } as never;
    await service.options().handlers.onConnect(one, ctx);
    for (let t=0;t<15 && !observer;t++) await Bun.sleep(1);
    if (!observer) throw new Error("No watcher");

    const change = async (text: string) => {
      history = [...history.slice(0,-1), textMessage("m19", text)];
      const prev = a.length;
      observer!([{ type: "tool_end" } as OpenCodeSessionEvent]);
      for (let t=0;t<30 && a.length<prev+2;t++) await Bun.sleep(1);
    };
    await change("new " + "body ".repeat(100));
    expect(a.filter(p => p.type === "snapshot_delta").length).toBe(1);

    active.push(two);
    await service.options().handlers.onConnect(two, ctx);
    expect(b.find(p => p.type === "snapshot")?.type).toBe("snapshot");

    await change("updated " + "body ".repeat(100));
    expect(b.some(p => p.type === "snapshot_delta")).toBe(true);
    await service.options().handlers.onMessage(one,
      JSON.stringify({ type: "resync", id: "request-resync" }));
    expect(a.filter(p => p.type === "snapshot").length).toBe(2);

    const reconstruction = (packets: ServerMessage[]) => {
      let messages: readonly OpenCodeMessage[] = [];
      for (const packet of packets) {
        if (packet.type === "snapshot") messages = packet.messages;
        if (packet.type === "snapshot_delta") {
          const next = applySnapshotDelta(messages, packet);
          if (!next) throw Error("mismatch");
          messages = next;
        }
      }
      return messages;
    };
    expect(reconstruction(a)).toEqual(history);
    expect(reconstruction(b)).toEqual(history);
  });
});

describe("real app WebSocket orchestration, fake deterministic Harness", () => {
  test("compares three paired runs per scenario and retains samples", async () => {
    for (const scenario of ["short", "long", "rewrite"] as const) {
      const baseline: Bench[] = [];
      const optimized: Bench[] = [];
      for (let pair = 0; pair < 3; pair++) {
        const order: Delivery[] = pair % 2 === 0 ? ["full", "delta"] : ["delta", "full"];
        for (const variant of order) {
          const runId = scenario + ":" + pair + ":" + variant;
          console.log("SNAPSHOT_RUN_BEGIN " + JSON.stringify({ id: runId, scenario, pair, variant }));
          let outcome: Bench;
          try { outcome = await exercise(variant, scenario); }
          catch (error) {
            console.log("SNAPSHOT_RUN_END " + JSON.stringify({ id: runId, status: "FAIL",
              error: error instanceof Error ? error.message : String(error) }));
            throw error;
          }
          console.log("SNAPSHOT_RUN_END " + JSON.stringify({ id: runId, status: outcome.valid ? "PASS" : "FAIL", ...outcome }));
          console.log("SNAPSHOT_BENCH_ROW " + JSON.stringify({ pair, ...outcome }));
          expect(outcome.valid).toBe(true);
          (variant === "full" ? baseline : optimized).push(outcome);
        }
      }
      for (let pair = 0; pair < 3; pair++) {
        expect(optimized[pair].historyReads).toBe(baseline[pair].historyReads);
        expect(optimized[pair].totalPackets).toBe(baseline[pair].totalPackets);
        expect(optimized[pair].bytes).toBeLessThanOrEqual(baseline[pair].bytes);
      }
      const avg = (values: Bench[]) => values.reduce((sum, x) => sum + x.bytes, 0) / values.length;
      const savings = 100 * (1 - avg(optimized) / avg(baseline));
      console.log("SNAPSHOT_BENCH_RESULT " + JSON.stringify({ scenario, baselineBytes: avg(baseline), deltaBytes: avg(optimized), savingsPct: Number(savings.toFixed(3)) }));
      if (scenario === "long") expect(savings).toBeGreaterThanOrEqual(70);
    }
  });
});

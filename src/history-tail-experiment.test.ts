import { describe, expect, test } from "bun:test";
import type { OpenCodeMessage, OpenCodeSessionEvent } from "agents/harness/opencode";
import { OpenCodeSessionSockets } from "./sockets";
import type { Connection } from "agents/lifecycle";
import type { ServerMessage } from "./protocol";

type Kind = "short" | "long" | "compaction";
type Mode = "full" | "tail";

function msg(id: string, data: string): OpenCodeMessage {
  return { type: "user", id, text: data, time: { created: 1 } } as unknown as OpenCodeMessage;
}

export type Result = {
  kind: Kind; mode: Mode; calls: number; readBytes: number;
  snapshots: number; elapsedMs: number; correct: boolean; finalCount: number;
};

async function exercise(mode: Mode, kind: Kind): Promise<Result> {
  const initialCount = kind === "short" ? 8 : kind === "long" ? 1005 : 230;
  const iterations = kind === "short" ? 6 : kind === "long" ? 10 : 8;
  let history = Array.from({ length: initialCount }, (_, i) =>
    msg("m" + i, ("message-" + i + "-").padEnd(240, "X")));
  let calls = 0;
  let readBytes = 0;
  const messagesRead = async (query: {sessionID: string; order?: string; limit?: number; cursor?: string}) => {
    calls++;
    let order: string, from: number;
    if (query.cursor) {
      [order, from] = query.cursor.split(":");
      from = Number(from);
    } else {
      order = query.order ?? "asc";
      from = 0;
    }
    const ordered = order === "desc" ? [...history].reverse() : history;
    const limit = query.limit ?? 100;
    const data = structuredClone(ordered.slice(from, from + limit));
    readBytes += Buffer.byteLength(JSON.stringify(data));
    const next = from + limit < ordered.length ? order + ":" + (from + limit) : undefined;
    return { data, cursor: { next } };
  };
  const opencode = { message: { list: messagesRead } };
  const runFullHistory = async () => {
    const gathered: OpenCodeMessage[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await messagesRead(cursor === undefined
        ? { sessionID: "ses_root", order: "asc", limit: 100 }
        : { sessionID: "ses_root", cursor });
      gathered.push(...page.data);
      if (!page.cursor.next) return gathered;
      cursor = page.cursor.next;
    }
  };
  let callback: ((events: readonly OpenCodeSessionEvent[]) => void) | undefined;
  const sentA: ServerMessage[] = [], sentB: ServerMessage[] = [];
  const sock = (target: ServerMessage[]) => ({
    readyState: 1,
    tags: ["opencode-session:ses_root"],
    send: (data: string) => target.push(JSON.parse(data) as ServerMessage)
  } as unknown as Connection);
  const a = sock(sentA), b = sock(sentB);
  const sockets = [a];
  const handle = {
    history: runFullHistory, busy: async () => true,
    events: async () => ({
      start: (fn: (events: readonly OpenCodeSessionEvent[]) => void) => { callback = fn; },
      stop: async () => undefined
    })
  };
  const harness = {
    session: () => handle,
    use: async <T>(fn: (opencode: typeof opencode) => Promise<T>) => fn(opencode),
    sessions: { list: async () => [{ id: "ses_root", busy: true }] },
    pending: async () => []
  };
  const runner = new OpenCodeSessionSockets(
    harness as never,
    () => sockets as unknown as WebSocket[],
    async () => false,
    async () => undefined,
    async () => undefined,
    async () => undefined,
    async () => undefined
  );
  // Baseline mode is actual current sockets.ts. Tail mode is enabled ONLY
  // by a test-time constructor option in the experimental candidate.
  void mode;
  const t0 = performance.now();
  const ctx = { request: new Request("https://example.test/?session=ses_root") } as never;
  await runner.options().handlers.onConnect(a, ctx);
  let correct = sentA.some(x => x.type === "snapshot" &&
    JSON.stringify(x.messages) === JSON.stringify(history));
  for (let k = 0; k < 40 && !callback; k++) await Bun.sleep(1);
  if (!callback) throw new Error("Session events stream did not start");
  let snapshots = 1;

  for (let i = 0; i < iterations; i++) {
    let event: OpenCodeSessionEvent = { type: "tool_end" } as OpenCodeSessionEvent;
    if (kind === "compaction" && i === 3) {
      history = [msg("compact", "summary"), ...history.slice(-5)];
      event = { type: "transcript_reset", reason: "compaction" } as OpenCodeSessionEvent;
    } else if (kind === "compaction" && i === 6) {
      history = [...history, msg("new-after-compaction", "new user message")];
      event = { type: "run_end", outcome: "succeeded" } as OpenCodeSessionEvent;
    } else {
      const last = history.length - 1;
      const previous = history[last] as unknown as {id:string;text:string};
      history[last] = msg(previous.id, previous.text + " tool-" + i);
    }
    const before = sentA.length;
    callback([event]);
    for (let attempt = 0; attempt < 80; attempt++) {
      if (sentA.slice(before).some(x => x.type === "snapshot")) break;
      await Bun.sleep(1);
    }
    const newPackets = sentA.slice(before);
    const snapshot = newPackets.findLast(x => x.type === "snapshot");
    if (!snapshot || snapshot.type !== "snapshot") throw new Error("No full snapshot on event " + i);
    correct &&= JSON.stringify(snapshot.messages) === JSON.stringify(history);
    snapshots++;

    if (kind === "compaction" && i === 4) {
      sockets.push(b);
      await runner.options().handlers.onConnect(b, ctx);
      const newConn = sentB.findLast(x => x.type === "snapshot");
      correct &&= Boolean(newConn && newConn.type === "snapshot" &&
        JSON.stringify(newConn.messages) === JSON.stringify(history));
      snapshots++;
    }
  }
  if (kind === "compaction") {
    const prev = sentA.length;
    await runner.options().handlers.onMessage(a, JSON.stringify({ type: "resync", id: "check" }));
    const again = sentA.slice(prev).find(x => x.type === "snapshot");
    correct &&= Boolean(again && again.type === "snapshot" &&
      JSON.stringify(again.messages) === JSON.stringify(history));
    snapshots++;
  }
  return {
    kind, mode, calls, readBytes, snapshots,
    elapsedMs: Number((performance.now()-t0).toFixed(3)),
    correct, finalCount: history.length
  };
}

describe("experiment 3: full history baseline using actual WebSocket handler", () => {
  test("baseline measurements before changing the history reader", async () => {
    for (const kind of ["short", "long", "compaction"] as const) {
      for (let replicate = 1; replicate <= 3; replicate++) {
        const id = "baseline:" + kind + ":" + replicate;
        console.log("HISTORY_BEGIN " + JSON.stringify({ id, kind, replicate, mode: "full" }));
        try {
          const result = await exercise("full", kind);
          console.log("HISTORY_END " + JSON.stringify({ id, status: result.correct ? "PASS" : "FAIL", ...result }));
          expect(result.correct).toBe(true);
        } catch (err) {
          console.log("HISTORY_END " + JSON.stringify({ id, status: "FAIL", error: String(err) }));
          throw err;
        }
      }
    }
  });
});

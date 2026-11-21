import { describe, expect, test } from "bun:test";
import { readSupervisorProgressPage } from "./supervisor-progress";

type LogEvent = { durable: { seq: number }; type: string };

function streamOf(events: LogEvent[], after: number): AsyncIterable<unknown> {
  return (async function* () {
    for (const event of events) if (event.durable.seq > after) yield event;
  })();
}

// 101 visible events at odd seqs, with a reasoning event at every even seq.
// The 101st visible event is the first one that does not fit on page one.
const events: LogEvent[] = Array.from({ length: 201 }, (_, index) => {
  const seq = index + 1;
  return { durable: { seq }, type: seq % 2 === 1 ? "session.text.delta" : "session.reasoning.delta" };
});
const visibleSeqs = events.filter(event => event.type === "session.text.delta")
  .map(event => event.durable.seq);

describe("remoteSupervisorProgress pagination cursor", () => {
  test("the event after a full first page remains available from nextAfter", async () => {
    const first = await readSupervisorProgressPage(streamOf(events, 0), 0);

    expect(first.events).toHaveLength(100);
    expect(first.events.some(event => /reasoning/i.test(event.type))).toBe(false);
    expect(first.truncated).toBe(true);
    expect(first.nextAfter).toBe(visibleSeqs[99]);

    const second = await readSupervisorProgressPage(streamOf(events, first.nextAfter), first.nextAfter);
    expect(second.events.map(event => event.seq)).toEqual([visibleSeqs[100]]);
    expect(second.truncated).toBe(false);
    expect(second.nextAfter).toBe(visibleSeqs[100]);
  });

  test("the initial cursor is honored", async () => {
    const page = await readSupervisorProgressPage(streamOf(events, visibleSeqs[49]), visibleSeqs[49]);
    expect(page.events.map(event => event.seq)).toEqual(visibleSeqs.slice(50));
    expect(page.truncated).toBe(false);
    expect(page.nextAfter).toBe(visibleSeqs[100]);
  });
});

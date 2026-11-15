import { describe, expect, test } from "bun:test";
import type { OpenCodeMessage } from "agents/harness/opencode";
import { ExperimentalHistoryTailReader } from "./experimental-history-tail";

const message = (id: string, text = id) =>
  ({ type: "user", id, text, time: {created: 1} } as unknown as OpenCodeMessage);

function fake(initial: OpenCodeMessage[]) {
  let messages = initial;
  let fullReads = 0;
  let listReads = 0;
  let delayedTail: (() => void) | undefined;
  let blockTail = false;
  const harness = {
    session: () => ({ history: async () => {
      fullReads++;
      return structuredClone(messages);
    } }),
    use: async (fn: (oc: unknown) => Promise<unknown>) => fn({
      message: { list: async ({ order, limit }: { order: string; limit: number }) => {
        listReads++;
        const data = structuredClone([...messages].reverse().slice(0, limit));
        if (blockTail) {
          blockTail = false;
          await new Promise<void>(resolve => { delayedTail = resolve; });
        }
        return { data, cursor: { next: undefined } };
      } }
    })
  };
  return {
    harness, set: (m: OpenCodeMessage[]) => { messages = m; },
    stats: () => ({fullReads, listReads}),
    pause: () => { blockTail = true; },
    resume: () => { delayedTail?.(); },
    ready: () => Boolean(delayedTail)
  };
}

describe("experimental tail history reader edge cases", () => {
  test("splices changed tail, falls back when no stable message ID remains", async () => {
    const initial = [message("m0"), message("m1"), message("m2")];
    const store = fake(initial);
    const reader = new ExperimentalHistoryTailReader(store.harness as never);
    expect(await reader.read("ses_root")).toEqual(initial);
    const changed = [message("m0"), message("m1"), message("m2", "updated"), message("m3")];
    store.set(changed);
    expect(await reader.read("ses_root")).toEqual(changed);
    expect(store.stats()).toEqual({fullReads:1, listReads:1});
    const entirelyDifferent = [message("other", "after external reset")];
    store.set(entirelyDifferent);
    expect(await reader.read("ses_root")).toEqual(entirelyDifferent);
    expect(store.stats()).toEqual({fullReads:2, listReads:2});
  });

  test("invalidation during in-flight tail read prevents stale cache reuse", async () => {
    const initial = [message("m0"), message("m1")];
    const store = fake(initial);
    const reader = new ExperimentalHistoryTailReader(store.harness as never);
    await reader.read("ses_root");
    store.set([message("m0"), message("m1", "changed")]);
    store.pause();
    const pending = reader.read("ses_root");
    for (let i=0; i<30 && !store.ready(); i++) await Bun.sleep(1);
    expect(store.ready()).toBe(true);
    reader.invalidate("ses_root");
    store.resume();
    expect(await pending).toEqual([message("m0"), message("m1", "changed")]);
    const before = store.stats().fullReads;
    await reader.read("ses_root");
    expect(store.stats().fullReads).toBe(before + 1);
  });
});

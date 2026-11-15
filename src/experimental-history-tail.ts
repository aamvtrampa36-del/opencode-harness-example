import type { OpenCodeHarness, OpenCodeMessage, OpenCodeSessionId } from "agents/harness/opencode";

/**
 * EXPERIMENT 3 ONLY. Runtime cache inside one Durable Object instance,
 * never a second durable source of truth. A full history() always wins.
 *
 * OpenCode's message.list API supports descending order with a bounded page.
 * We splice the last page into the previously verified full history at its
 * oldest overlapping message. That handles append, tail edit and tail delete.
 * Caller MUST invalidate on compaction / run_end and call with 'fresh' on
 * a newly connected client or explicit resync.
 */
type Cache = {
  readonly messages: readonly OpenCodeMessage[];
  readonly indices: ReadonlyMap<string, number>;
};
const TAIL_PAGE_SIZE = 100;
const MAX_CACHE_MESSAGES = 2_000;

export class ExperimentalHistoryTailReader {
  readonly #cache = new Map<string, Cache>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(private readonly harness: Pick<OpenCodeHarness, "use" | "session">) {}

  invalidate(session: OpenCodeSessionId): void {
    this.#cache.delete(session);
  }

  async read(session: OpenCodeSessionId, fresh = false): Promise<OpenCodeMessage[]> {
    // Prevent a previous snapshot completion from overwriting a newer cache.
    const previous = this.#locks.get(session) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.#locks.set(session, next);
    await previous;
    try {
      const old = fresh ? undefined : this.#cache.get(session);
      if (!old) return this.#full(session);
      const page = await this.harness.use((opencode) =>
        opencode.message.list({
          sessionID: session,
          order: "desc",
          limit: TAIL_PAGE_SIZE
        })
      );
      // Every item in this page is newest-first. We take its OLDEST
      // overlapping message, so no changes within the tail are missed.
      let overlap = -1;
      for (let i = page.data.length - 1; i >= 0; i--) {
        if (old.indices.has(page.data[i].id)) {
          overlap = i;
          break;
        }
      }
      if (overlap < 0) return this.#full(session);
      const at = old.indices.get(page.data[overlap].id)!;
      const updated = [
        ...old.messages.slice(0, at),
        ...page.data.slice(0, overlap + 1).reverse()
      ];
      // Do not retain unbounded transcripts in the DO's memory.
      this.#remember(session, updated);
      return updated;
    } finally {
      release();
      if (this.#locks.get(session) === next) this.#locks.delete(session);
    }
  }

  async #full(session: OpenCodeSessionId): Promise<OpenCodeMessage[]> {
    const messages = await this.harness.session(session).history();
    this.#remember(session, messages);
    return messages;
  }

  #remember(session: OpenCodeSessionId, messages: readonly OpenCodeMessage[]) {
    if (messages.length > MAX_CACHE_MESSAGES) {
      this.#cache.delete(session);
      return;
    }
    this.#cache.set(session, {
      messages: [...messages],
      indices: new Map(messages.map((m, i) => [m.id, i]))
    });
  }
}

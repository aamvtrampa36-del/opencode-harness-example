import type { OpenCodeMessage } from "agents/harness/opencode";
import type { ServerMessage, SessionSnapshot, SnapshotDelta } from "./protocol";

/**
 * Experimental wire optimization: full snapshots remain authoritative.
 * Individual WebSockets track a serialized prefix rather than object references:
 * OpenCode may mutate or replace message objects between events.
 */
export type SnapshotCache = {
  readonly serialized: readonly string[];
  readonly lastId: string | null;
};
const MAX_CACHE_CHARS = 2_000_000;

export function makeSnapshotPacket(
  snapshot: SessionSnapshot,
  previous?: SnapshotCache
): { packet: ServerMessage; cache?: SnapshotCache } {
  const full: ServerMessage = { type: "snapshot", ...snapshot };
  const serialized = snapshot.messages.map(message => JSON.stringify(message));
  const bytes = serialized.reduce((sum, item) => sum + item.length, 0);
  const cache = bytes <= MAX_CACHE_CHARS ? {
    serialized,
    lastId: snapshot.messages.at(-1)?.id ?? null
  } : undefined;
  if (!previous || !cache) return { packet: full, cache };

  let from = 0;
  const upper = Math.min(previous.serialized.length, serialized.length);
  while (from < upper && previous.serialized[from] === serialized[from]) from++;

  const delta: SnapshotDelta = {
    type: "snapshot_delta",
    session: snapshot.session,
    baseLength: previous.serialized.length,
    baseLastId: previous.lastId,
    from,
    messages: snapshot.messages.slice(from),
    busy: snapshot.busy,
    pending: snapshot.pending
  };
  // A prefix rewrite or a short conversation rarely saves space. Comparing
  // actual encoded packets avoids expanding traffic in those cases.
  if (JSON.stringify(delta).length >= JSON.stringify(full).length * 0.85)
    return { packet: full, cache };
  return { packet: delta, cache };
}

/**
 * On a broken base the client must not combine incompatible transcripts.
 * WebSocket ordering means this should only occur on a protocol regression.
 */
export function applySnapshotDelta(
  messages: readonly OpenCodeMessage[],
  delta: SnapshotDelta
): readonly OpenCodeMessage[] | undefined {
  if (messages.length !== delta.baseLength ||
      (messages.at(-1)?.id ?? null) !== delta.baseLastId ||
      !Number.isSafeInteger(delta.from) || delta.from < 0 ||
      delta.from > delta.baseLength) return undefined;
  return [...messages.slice(0, delta.from), ...delta.messages];
}

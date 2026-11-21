/**
 * Bounded pagination of the durable OpenCode supervisor event log.
 * The returned cursor must never advance past the last event actually
 * included in `events`, or the next page loses that event.
 */
export type SupervisorProgressEvent = { seq?: number; type: string };
export type SupervisorProgressPage = {
  events: SupervisorProgressEvent[];
  nextAfter: number;
  truncated: boolean;
};

export async function readSupervisorProgressPage(
  stream: AsyncIterable<unknown>, after: number, limit = 100
): Promise<SupervisorProgressPage> {
  const events: SupervisorProgressEvent[] = [];
  let nextAfter = after;
  let truncated = false;
  for await (const value of stream) {
    const event = value as unknown as Record<string, unknown>;
    const durable = event.durable && typeof event.durable === "object"
      ? event.durable as Record<string, unknown> : {};
    const data = event.data && typeof event.data === "object"
      ? event.data as Record<string, unknown> : {};
    const eventType = String(event.type ?? data.type ?? "event").slice(0, 100);
    if (/reasoning/i.test(eventType)) continue;
    const rawSeq = durable.seq ?? event.seq;
    const seq = typeof rawSeq === "number" && Number.isSafeInteger(rawSeq) ? rawSeq : undefined;
    if (events.length >= limit) { truncated = true; break; }
    if (seq !== undefined) nextAfter = Math.max(nextAfter, seq);
    events.push({ ...(seq !== undefined ? { seq } : {}), type: eventType });
  }
  return { events, nextAfter, truncated };
}

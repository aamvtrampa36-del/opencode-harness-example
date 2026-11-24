/**
 * Memory-bounded accounting of durable OpenCode tool events.
 * Unlike session.history(), log() is an AsyncIterable and can be read without
 * materializing an arbitrarily large transcript in the Durable Object isolate.
 */
export type SupervisorToolCounts = {
  cursor: number;
  toolCalls: number;
  completedTools: number;
  failedTools: number;
};

export const EMPTY_SUPERVISOR_TOOL_COUNTS: SupervisorToolCounts = {
  cursor: 0, toolCalls: 0, completedTools: 0, failedTools: 0
};

export function validSupervisorToolCounts(value: unknown): value is SupervisorToolCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return ["cursor", "toolCalls", "completedTools", "failedTools"].every(key =>
    typeof state[key] === "number" && Number.isSafeInteger(state[key]) && (state[key] as number) >= 0
  ) && state.completedTools as number <= (state.toolCalls as number) &&
    (state.failedTools as number) <= (state.toolCalls as number);
}

export async function foldSupervisorToolLog(
  stream: AsyncIterable<unknown>,
  previous: SupervisorToolCounts = EMPTY_SUPERVISOR_TOOL_COUNTS,
  maxEvents = 256
): Promise<{metrics: SupervisorToolCounts; complete: boolean; eventsRead: number}> {
  if (!validSupervisorToolCounts(previous)) throw new Error("SUPERVISOR_METRICS_INVALID");
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1024)
    throw new Error("SUPERVISOR_EVENT_BUDGET_INVALID");
  const metrics = { ...previous };
  let eventsRead = 0;
  let complete = true;
  for await (const raw of stream) {
    // Do not hold the event's tool output after this iteration. Stop at a
    // bounded number of rows even if the log contains millions of events.
    if (eventsRead >= maxEvents) { complete = false; break; }
    eventsRead++;
    if (!raw || typeof raw !== "object") throw new Error("SUPERVISOR_EVENT_SEQUENCE_INVALID");
    const event = raw as Record<string, unknown>;
    const durable = event.durable && typeof event.durable === "object"
      ? event.durable as Record<string, unknown> : {};
    const seq = durable.seq ?? event.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1)
      throw new Error("SUPERVISOR_EVENT_SEQUENCE_INVALID");
    if (seq <= metrics.cursor) continue;
    // The durable event index is the sole idempotency key.
    const kind = typeof event.type === "string" ? event.type : "";
    if (kind === "session.tool.called") metrics.toolCalls++;
    if (kind === "session.tool.success") metrics.completedTools++;
    if (kind === "session.tool.failed") metrics.failedTools++;
    metrics.cursor = seq;
  }
  if (!validSupervisorToolCounts(metrics)) throw new Error("SUPERVISOR_METRICS_INVALID");
  return {metrics, complete, eventsRead};
}

// Logical evidence counts must never be interpreted as physical native activity.
export { logicalPhaseCounts } from './metralla-m02-phase-evidence';

export { logicalEvidenceSnapshot } from './metralla-m02-phase-journal';

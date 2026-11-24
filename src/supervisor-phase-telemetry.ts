/**
 * F0-C10/R3-T01 — Opt-in, strictly low-cardinality phase spans.
 * Wall-clock category only; never claim this measures isolate/Container heap.
 * No identifiers, payloads, stack traces, error messages, model names or URLs.
 * Closed labels and an absolute budget per RPC keep logging bounded.
 */
export const PHASE_MARKER = "f0_c10_phase_v1";
export const MAX_PHASE_EVENTS = 32;
const VALID = {
  admission: ["validate", "reserve", "reconcile"],
  github_branch: ["ensure"],
  session_create: ["exactIdLookup", "create", "commit", "bind"],
  configure: ["setAgent", "setModel"],
  submit: ["initial", "continue"],
  status: ["wait", "busy", "logFold", "progress"],
  cleanup: ["cancel", "artifactRead", "artifactPrepare", "artifactStoredRead", "artifactVerify"],
  mcp: ["rpc", "serialize"]
} as const;
export type MemoryPhase = keyof typeof VALID;
export type MemoryOperation<P extends MemoryPhase> = (typeof VALID)[P][number];
export type PhaseEvent = {
  marker: typeof PHASE_MARKER;
  phase: MemoryPhase;
  operation: string;
  edge: "begin" | "end";
  outcome?: "ok" | "error";
  elapsed?: "under_5ms" | "under_25ms" | "under_100ms" | "under_500ms" |
    "under_2s" | "under_10s" | "over_10s";
};
export type PhaseProbe = {
  readonly enabled: boolean;
  run<P extends MemoryPhase, T>(
    phase: P, operation: MemoryOperation<P>, action: () => Promise<T> | T
  ): Promise<T>;
};
export function durationBucket(ms: number): NonNullable<PhaseEvent["elapsed"]> {
  if (ms < 5) return "under_5ms";
  if (ms < 25) return "under_25ms";
  if (ms < 100) return "under_100ms";
  if (ms < 500) return "under_500ms";
  if (ms < 2000) return "under_2s";
  if (ms < 10000) return "under_10s";
  return "over_10s";
}
const NOOP: PhaseProbe = {
  enabled: false,
  async run(_phase, _operation, action) { return await action(); }
};
/** Creating a probe with false returns the same no-op singleton, with zero logs. */
export function createSupervisorMemoryProbe(
  enabled: boolean,
  emit: (event: PhaseEvent) => void = event => { console.info(PHASE_MARKER, event); },
  clock: () => number = () => performance.now()
): PhaseProbe {
  if (enabled !== true) return NOOP;
  let emitted = 0;
  const safeEmit = (event: PhaseEvent): void => {
    try { emit(event); } catch { /* Telemetry never changes user operation. */ }
  };
  return {
    enabled: true,
    async run(phase, operation, action) {
      if (!Object.prototype.hasOwnProperty.call(VALID, phase) ||
          !(VALID[phase] as readonly string[]).includes(operation)) {
        throw new Error("PHASE_LABEL_INVALID");
      }
      // Reserve begin+end together; no dangling begin from budget exhaustion.
      if (emitted + 2 > MAX_PHASE_EVENTS) return await action();
      emitted += 2;
      let t0 = 0;
      try { t0 = clock(); } catch { /* clock failure must not prevent operation */ }
      safeEmit({marker: PHASE_MARKER, phase, operation, edge: "begin"});
      const finish = (outcome: "ok" | "error") => {
        let elapsed = 0;
        try { elapsed = clock() - t0; } catch { /* only fixed bucket emitted */ }
        safeEmit({marker: PHASE_MARKER, phase, operation, edge: "end",
          outcome, elapsed: durationBucket(Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0)});
      };
      try {
        const value = await action();
        finish("ok");
        return value;
      } catch (error) {
        finish("error");
        throw error;
      }
    }
  };
}

// M02 scoped evidence is distinct from the anonymous logging probe.
export { readPhaseEvidence, restorePhaseCheckpoint, PHASE_EVIDENCE_LIMITS } from './metralla-m02-phase-evidence';
export type { PhaseRow, PhaseCheckpoint, PhaseRead } from './metralla-m02-phase-evidence';

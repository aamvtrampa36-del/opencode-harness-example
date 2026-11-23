/**
 * F0-C10/R3: bounded, privacy-preserving RPC phase markers.
 *
 * These logs measure phase wall time and trace ordering, NOT isolate memory.
 * No request/session/prompt/credential/exception may be included. Deliberately
 * no durable storage and no process.memoryUsage() (not a Workers API).
 * A "begin" without "end" is an investigative lead, not proof of an allocator.
 */
export const SUPERVISOR_PHASE_MARKER = "supervisor.phase.v1" as const;

const OPERATIONS = {
  admit: ["validate", "fingerprint", "reserve", "branch"],
  "create/fork": ["sourceLookup", "create", "fork", "scope"],
  setModel: ["configure"],
  submit: ["dispatch"],
  status: ["wait", "busy", "foldLog", "progress"],
  alarm: ["observedExternally"],
  recover: ["legacyBusy", "resumeReceipt"]
} as const;

export type SupervisorPhase = keyof typeof OPERATIONS;
export type SupervisorPhaseOperation<P extends SupervisorPhase> = (typeof OPERATIONS)[P][number];
export type SupervisorPhaseEvent = {
  marker: typeof SUPERVISOR_PHASE_MARKER;
  probe: string;
  phase: SupervisorPhase;
  operation: string;
  edge: "begin" | "end";
  outcome?: "ok" | "error";
  durationMs?: number;
};

export type SupervisorPhaseProbe = {
  readonly probe: string;
  run<P extends SupervisorPhase, T>(
    phase: P,
    operation: SupervisorPhaseOperation<P>,
    action: () => T | Promise<T>
  ): Promise<T>;
};

type ProbeOptions = {
  emit?: (event: SupervisorPhaseEvent) => void;
  now?: () => number;
  probe?: string;
};

function validOperation(phase: SupervisorPhase, operation: string): boolean {
  return Array.isArray(OPERATIONS[phase]) &&
    (OPERATIONS[phase] as readonly string[]).includes(operation);
}

export function createSupervisorPhaseProbe(options: ProbeOptions = {}): SupervisorPhaseProbe {
  const probe = options.probe ?? crypto.randomUUID();
  // The id is ephemeral per RPC. It is NOT a task/session identifier.
  if (!/^[a-f0-9-]{8,64}$/i.test(probe)) throw new Error("SUPERVISOR_PHASE_PROBE_INVALID");
  const now = options.now ?? (() => performance.now());
  const emit = options.emit ?? ((event: SupervisorPhaseEvent) => {
    console.info(SUPERVISOR_PHASE_MARKER, event);
  });
  const safeEmit = (event: SupervisorPhaseEvent): void => {
    try { emit(event); } catch { /* Observability must not affect application outcome. */ }
  };
  const safeNow = (): number => {
    try {
      const n = now();
      return Number.isFinite(n) ? n : 0;
    } catch { return 0; }
  };
  return {
    probe,
    async run<P extends SupervisorPhase, T>(
      phase: P, operation: SupervisorPhaseOperation<P>, action: () => T | Promise<T>
    ): Promise<T> {
      if (!validOperation(phase, operation)) throw new Error("SUPERVISOR_PHASE_OPERATION_INVALID");
      const start = safeNow();
      safeEmit({ marker: SUPERVISOR_PHASE_MARKER, probe, phase, operation, edge: "begin" });
      const end = (outcome: "ok" | "error") => {
        const elapsed = safeNow() - start;
        // Bound log size and report only a timing, not heap, CPU, secrets or stack.
        const durationMs = Number.isFinite(elapsed) ? Math.min(600_000, Math.max(0, Math.round(elapsed))) : 0;
        safeEmit({ marker: SUPERVISOR_PHASE_MARKER, probe, phase, operation,
          edge: "end", outcome, durationMs });
      };
      try {
        const result = await action();
        end("ok");
        return result;
      } catch (error) {
        end("error");
        throw error;
      }
    }
  };
}

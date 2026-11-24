import type { AdmissionDecision, AdmissionSlot, StartGrant } from "./supervisor-admission";
import type { SupervisorTask } from "./supervisor-control";

export type DeferredStartOutcome = "advance_returned" | "not_current" | "interrupted" | "not_registered";
export type DeferredStartReceipt = {
  id: string; accepted: true; confirmed: false; reused: boolean;
  status: SupervisorTask["status"]; backgroundRegistered: boolean; retryAfterMs: number;
};
export type AsyncStartSnapshot = { task?: SupervisorTask; slot?: AdmissionSlot };
export type AsyncStartPorts = {
  waitUntil(work: Promise<DeferredStartOutcome>): void;
  // Read task AND admission slot in one existing storage transaction.
  readCurrent(id: string): Promise<AsyncStartSnapshot>;
  // Reuse server's existing start lock; never create another lock or ledger.
  withStartLock(id: string, run: () => Promise<DeferredStartOutcome>, task: SupervisorTask): Promise<unknown>;
  // Must journal every effect and fence every durable receipt/late write.
  advance(task: SupervisorTask, grant: StartGrant, reused: boolean): Promise<unknown>;
  now?: () => number;
};

/** Advisory entry check only: begin/confirm and task writes still require the
 * authoritative admission transaction. No check-then-effect permission. */
export function canResumeDeferredStart(snapshot: AsyncStartSnapshot, grant: StartGrant,
  fingerprint: string, now: number): snapshot is { task: SupervisorTask; slot: AdmissionSlot } {
  const { task, slot } = snapshot;
  return Number.isSafeInteger(now) && now >= 0 && !!task && !!slot &&
    task.id === grant.id && task.fingerprint === fingerprint &&
    slot.token === grant.token && slot.generation === grant.generation &&
    slot.phase === "reserved" && slot.effect === undefined && slot.expiresAt > now &&
    !task.pendingTurn && !task.cancelAmbiguous &&
    (!task.operationId || task.operationId === "rc-start-" + task.id) &&
    (task.status === "preparing" || (task.status === "running" &&
      !!task.session && !!task.baseCommit && task.operationId === "rc-start-" + task.id));
}

/** Only a fresh durable grant schedules work. Reused/capacity decisions are
 * handled by the caller's existing receipts/reconciliation. No tokens leave
 * this function. waitUntil is a best-effort lifetime hint, not a durable queue. */
export function deferSupervisorStart(decision: AdmissionDecision, ports: AsyncStartPorts): DeferredStartReceipt | undefined {
  if (decision.kind !== "granted") return undefined;
  const { task, reused } = decision;
  const grant = { ...decision.grant };
  if (grant.id !== task.id) throw Error("ASYNC_START_GRANT_MISMATCH");
  const fingerprint = task.fingerprint;
  let registered = false;
  const work = Promise.resolve().then(async (): Promise<DeferredStartOutcome> => {
    if (!registered) return "not_registered";
    try {
      let outcome: DeferredStartOutcome = "not_current";
      await ports.withStartLock(grant.id, async () => {
        const current = await ports.readCurrent(grant.id);
        if (!canResumeDeferredStart(current, grant, fingerprint, (ports.now ?? Date.now)()))
          return outcome;
        await ports.advance(current.task, grant, reused);
        outcome = "advance_returned";
        return outcome;
      }, task);
      return outcome;
    } catch {
      // Never write failed/unknown here: the effect journal and current owner
      // alone decide. Before intent, retry after expiry; after intent, reconcile.
      return "interrupted";
    }
  });
  try {
    ports.waitUntil(work);
    registered = true;
  } catch {
    // The microtask sees false even if waitUntil threw after taking the promise.
    // The durable reservation remains recoverable via the same requestId.
  }
  return { id: task.id, accepted: true, confirmed: false, reused,
    status: task.status, backgroundRegistered: registered, retryAfterMs: 1000 };
}

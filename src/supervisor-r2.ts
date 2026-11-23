/** F0-C10/R2-T04: local per-task recovery decisions, not a scheduler.
 * The supervisor and T03 admission both use the existing supervisor:task row.
 * No data migration or new DO class is required.
 */
export type R2Status = "preparing" | "running" | "finished" | "unanswered" | "failed" |
  "cancel_requested" | "cancelled" | "unknown";
export type R2PendingTurn = { turnId: string; operationId: string };
export type R2TurnJournal = {
  hash: string;
  operationId: string;
  session: string;
  phase: "intent" | "accepted" | "unknown" | "settled";
  receiptStatus?: "done" | "unanswered";
  receiptReason?: string;
  settledAt?: number;
  revision: number;
};
export type R2TaskView = {
  status: R2Status;
  operationId?: string;
  pendingTurn?: R2PendingTurn;
  cancelAmbiguous?: boolean;
};

const REQUEST_ID = /^[a-f0-9]{16}$/;

/** Pin session identity before calling the SDK; no random ID can be orphaned. */
export function r2SessionId(requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error("INVALID_R2_REQUEST_ID");
  return "ses_r2_" + requestId;
}
export function r2TurnJournalKey(taskId: string, turnId: string): string {
  if (!REQUEST_ID.test(taskId) || !REQUEST_ID.test(turnId)) throw new Error("INVALID_R2_TURN_ID");
  return "supervisor:turn:" + taskId + ":" + turnId;
}

/** At most one unresolved continuation intent per supervised task.
 * This is NOT global backpressure/fencing; T03 owns the scheduler. */
export function r2TurnAdmission(task: R2TaskView, operationId: string):
  "reserve" | "retry" | "busy" | "denied" {
  if (task.cancelAmbiguous ||
      ["cancel_requested", "cancelled", "failed", "unanswered"].includes(task.status))
    return "denied";
  if (task.pendingTurn) {
    return task.pendingTurn.operationId === operationId ? "retry" : "busy";
  }
  return "reserve";
}

/** Exact native receipt required, and ALL journaled continuations resolved. */
export function r2CancelledByReceipt(
  task: R2TaskView,
  operationId: string,
  receipt: { status: "done" | "unanswered"; reason?: string } | undefined
): boolean {
  return task.status === "cancel_requested" &&
    task.operationId === operationId &&
    !task.pendingTurn && !task.cancelAmbiguous &&
    receipt?.status === "unanswered" && receipt.reason === "interrupted";
}

/** A status probe may not overwrite an intent committed after the probe began. */
export function r2StatusWriteAllowed(
  task: R2TaskView,
  probedOperationId: string | undefined
): boolean {
  return Boolean(probedOperationId && task.operationId === probedOperationId && !task.pendingTurn) &&
    task.status !== "cancelled";
}

/** A missing/native-not-found result is NOT a terminal receipt. */
export function r2TerminalNativeReceipt(
  receipt: { status: "done" | "unanswered"; reason?: string } | undefined
): boolean {
  return receipt?.status === "done" || (receipt?.status === "unanswered" &&
    ["failed", "interrupted", "aborted"].includes(receipt.reason ?? ""));
}

/** A pending turn can leave the journal only upon a matching native
 * terminal receipt, never after a timeout, not_found, or another operation.
 * A concurrent cancelled turn is intentionally not auto-finalized. */
export function r2PendingTurnReconcileAllowed(
  task: R2TaskView,
  operationId: string | undefined,
  receipt: { status: "done" | "unanswered"; reason?: string } | undefined
): boolean {
  return Boolean(operationId &&
    task.pendingTurn?.operationId === operationId &&
    task.operationId === operationId &&
    !task.cancelAmbiguous && r2TerminalNativeReceipt(receipt) &&
    task.status !== "cancelled" && task.status !== "cancel_requested");
}

/** The pinned workerd SDK may surface the core Effect error tag or the
 * client/harness-normalized tag. Never mistake transport errors for absence. */
export function r3IsNativeSessionNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("_tag" in error)) return false;
  return error._tag === "SessionNotFoundError" ||
    error._tag === "Session.NotFoundError";
}

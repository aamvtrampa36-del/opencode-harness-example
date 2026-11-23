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
  phase: "intent" | "accepted" | "unknown";
  revision: number;
};
export type R2TaskView = {
  status: R2Status;
  operationId?: string;
  pendingTurn?: R2PendingTurn;
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
  if (["cancel_requested", "cancelled", "failed", "unanswered"].includes(task.status))
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
    !task.pendingTurn &&
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

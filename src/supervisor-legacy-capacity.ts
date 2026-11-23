import type { SupervisorTask } from "./supervisor-control";

/**
 * R3-T03: bounded census under the same Durable Object storage transaction as
 * admission. It is not an inventory of all SDK sessions or other DOs.
 * No transcript/prompt/session history or user data leaves the DO.
 *
 * Historical task.status alone is NOT proof that an unmetered native
 * execution stopped: #90 showed old cancelled/unknown sessions with
 * unconfirmed side effects. A positive T04 terminal proof/migration is
 * required before lifting the conservative STOP.
 */
export type LegacyCapacityStop =
  | "LEGACY_UNGOVERNED" | "UNTRACKED_MANAGED_TASK"
  | "LEGACY_INVENTORY_INCOMPLETE" | "AUXILIARY_UNGOVERNED";
export type AdmissionCapacityEvidence = {
  capacity: 10;
  activeSlots: number;
  possibleLegacyExecutions: number;
  untrackedManagedTasks: number;
  indexedTaskRows: number;
  inventoryComplete: boolean;
  auxiliaryStateKeys: number;
  stopReason: LegacyCapacityStop | null;
  /** Only native per-operation telemetry can fill this field. */
  activeNativeOperations: null;
  nativeOperationsMeasured: false;
  scope: "supervisor_do_index_only";
};

const LIMIT = 101; // If the result reaches the bound it is not complete.
const AUX_STATE_KEYS = [
  "agent-check-v1", "agent-check-openrouter-bun-v1",
  "g8-live-agent-v1", "g9-native-e2e-v2"
] as const;

/** One old task can only be exempted without an extra native read if its
 * cancellation was committed BEFORE any session creation attempt. Historical
 * terminal strings are not a replacement for a T04 terminal certificate.
 */
function legacyPotentiallyActive(task: SupervisorTask): boolean {
  return !(task.status === "cancelled" &&
    task.sessionCreationAttempted === false &&
    !task.session && !task.pendingTurn && !task.cancelAmbiguous);
}
const terminal = (status: SupervisorTask["status"]) =>
  ["finished","failed","cancelled","unanswered"].includes(status);

export async function auditLegacyCapacity(
  tx: Pick<DurableObjectStorage,"get"|"list">,
  slots: Record<string, unknown>
): Promise<AdmissionCapacityEvidence> {
  const indexed = await tx.list<SupervisorTask>({prefix:"supervisor:task:",limit:LIMIT});
  const inventoryComplete = indexed.size < LIMIT;
  // Status reads, not only mutations, must reject an orphaned slot rather
  // than advertise it as a safely accounted native execution.
  for (const id of Object.keys(slots)) {
    const owner = await tx.get<SupervisorTask>("supervisor:task:" + id);
    if (!owner || owner.id !== id) throw Error("ADMISSION_ORPHAN_SLOT");
  }
  let possibleLegacyExecutions=0, untrackedManagedTasks=0;
  for (const [key, task] of indexed) {
    const id = key.slice("supervisor:task:".length);
    if (!/^[a-f0-9]{16}$/.test(id) || !task || task.id !== id)
      throw Error("ADMISSION_TASK_INVENTORY_INVALID");
    if (Object.hasOwn(slots,id)) continue; // already counted as a slot
    if (task.sessionIdPolicy !== "deterministic-v1") {
      if (legacyPotentiallyActive(task)) possibleLegacyExecutions++;
    } else if (!terminal(task.status) || task.pendingTurn || task.cancelAmbiguous) {
      untrackedManagedTasks++;
    }
  }
  let auxiliaryStateKeys=0;
  for (const key of AUX_STATE_KEYS) {
    if (await tx.get(key) !== undefined) auxiliaryStateKeys++;
  }
  const stopReason:LegacyCapacityStop|null =
    !inventoryComplete ? "LEGACY_INVENTORY_INCOMPLETE" :
    possibleLegacyExecutions ? "LEGACY_UNGOVERNED" :
    untrackedManagedTasks ? "UNTRACKED_MANAGED_TASK" :
    auxiliaryStateKeys ? "AUXILIARY_UNGOVERNED" : null;
  return {
    capacity:10, activeSlots:Object.keys(slots).length,
    possibleLegacyExecutions,untrackedManagedTasks,
    indexedTaskRows:indexed.size,inventoryComplete,auxiliaryStateKeys,stopReason,
    activeNativeOperations:null,nativeOperationsMeasured:false,
    scope:"supervisor_do_index_only"
  };
}

/** Staging-only unmetered diagnostic agents must not bypass the T03 ledger.
 * Keep these side effects disabled until T11 routes them through T03 + T07. */
export function requireMeteredDiagnosticAdmission(enabled: boolean): void {
  if (enabled) throw Error("SUPERVISOR_UNMETERED_DIAGNOSTIC_DISABLED");
}

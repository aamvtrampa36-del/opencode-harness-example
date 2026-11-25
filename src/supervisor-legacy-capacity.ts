import type { SupervisorTask } from "./supervisor-control";
import { historicalCertificate, historicalPages, reconciliationDigest, HISTORICAL_AUX_KEYS, CONSUMED_PILOT_ID, type ConsumedArchive } from "./supervisor-reconciliation";

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
const AUX_STATE_KEYS = HISTORICAL_AUX_KEYS;

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

/** P02 archive is private, immutable accounting evidence. Never infer an
 * exemption from terminal text, age, or a missing slot alone. */
async function consumedArchiveExempts(tx:Pick<DurableObjectStorage,"get">,slots:Record<string,unknown>):Promise<boolean>{
  const id=CONSUMED_PILOT_ID;
  const archive=await tx.get<ConsumedArchive>("supervisor:consumed-pilot:archive:v1:"+id);
  if(archive===undefined)return false;
  if(!archive||typeof archive!=="object")throw Error("P03_CONSUMED_ARCHIVE_INVALID");
  const {digest,...body}=archive;
  const task=await tx.get<SupervisorTask>("supervisor:task:"+id);
  const claim=await tx.get("supervisor:pilot:single-use-v1");
  if(!task||!claim||Object.hasOwn(slots,id)||body.schema!=="metralla-consumed-pilot-v1"||body.replayAllowed!==false||
    body.identity?.requestId!==id||body.snapshot?.task?.id!==id||body.snapshot?.claim?.approval?.requestId!==id||
    body.snapshot?.slot?.phase!=="effect_unknown"||body.closure?.noOutstandingEffects!==true||body.closure?.writerFenced!==true||
    !["materialized","not_materialized"].includes(body.outcome)||typeof digest!=="string"||!/^[a-f0-9]{64}$/.test(digest)||
    await reconciliationDigest(body)!==digest||await reconciliationDigest(task)!==await reconciliationDigest(body.snapshot.task)||
    await reconciliationDigest(claim)!==await reconciliationDigest(body.snapshot.claim))throw Error("P03_CONSUMED_ARCHIVE_INVALID");
  return true;
}

export async function auditLegacyCapacity(
  tx: Pick<DurableObjectStorage,"get"|"list">,
  slots: Record<string, unknown>
): Promise<AdmissionCapacityEvidence> {
  const cert=await historicalCertificate(tx);
  const consumedExempt=await consumedArchiveExempts(tx,slots);
  // Preserve the original bounded STOP for uncertified histories. After
  // quiescence use paginated exact-row validation, not a 101-row ceiling.
  const indexed = cert ? undefined : await tx.list<SupervisorTask>({prefix:"supervisor:task:",limit:LIMIT});
  const inventoryComplete = !indexed || indexed.size < LIMIT;
  // Status reads, not only mutations, must reject an orphaned slot rather
  // than advertise it as a safely accounted native execution.
  for (const id of Object.keys(slots)) {
    const owner = await tx.get<SupervisorTask>("supervisor:task:" + id);
    if (!owner || owner.id !== id) throw Error("ADMISSION_ORPHAN_SLOT");
  }
  let possibleLegacyExecutions=0, untrackedManagedTasks=0;
  let indexedTaskRows=0;
  for await (const [key, task] of indexed ?? historicalPages<SupervisorTask>(tx,"supervisor:task:",1024)) {
    indexedTaskRows++;
    const id = key.slice("supervisor:task:".length);
    if (!/^[a-f0-9]{16}$/.test(id) || !task || task.id !== id)
      throw Error("ADMISSION_TASK_INVENTORY_INVALID");
    if (Object.hasOwn(slots,id)) continue; // already counted as a slot
    if (id===CONSUMED_PILOT_ID&&consumedExempt) continue; // exact P02 archive only
    if(cert&&Object.hasOwn(cert.taskDigests,id)){
      if(await reconciliationDigest(task)===cert.taskDigests[id])continue;
      untrackedManagedTasks++;continue; // modified historical evidence is not exempt
    }
    if (task.sessionIdPolicy !== "deterministic-v1") {
      if (legacyPotentiallyActive(task)) possibleLegacyExecutions++;
    } else if (!terminal(task.status) || task.pendingTurn || task.cancelAmbiguous) {
      untrackedManagedTasks++;
    }
  }
  let auxiliaryStateKeys=0;
  for (const key of AUX_STATE_KEYS) {
    const value=await tx.get(key);
    if(value!==undefined&&(!cert||cert.auxDigests[key]!==await reconciliationDigest(value)))auxiliaryStateKeys++;
  }
  const stopReason:LegacyCapacityStop|null =
    !inventoryComplete ? "LEGACY_INVENTORY_INCOMPLETE" :
    possibleLegacyExecutions ? "LEGACY_UNGOVERNED" :
    untrackedManagedTasks ? "UNTRACKED_MANAGED_TASK" :
    auxiliaryStateKeys ? "AUXILIARY_UNGOVERNED" : null;
  return {
    capacity:10, activeSlots:Object.keys(slots).length,
    possibleLegacyExecutions,untrackedManagedTasks,
    indexedTaskRows,inventoryComplete,auxiliaryStateKeys,stopReason,
    activeNativeOperations:null,nativeOperationsMeasured:false,
    scope:"supervisor_do_index_only"
  };
}

/** Staging-only unmetered diagnostic agents must not bypass the T03 ledger.
 * Keep these side effects disabled until T11 routes them through T03 + T07. */
export function requireMeteredDiagnosticAdmission(enabled: boolean): void {
  if (enabled) throw Error("SUPERVISOR_UNMETERED_DIAGNOSTIC_DISABLED");
}

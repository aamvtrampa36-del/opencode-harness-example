import { supervisorStartOperationId, supervisorTaskKey, type SupervisorTask } from "./supervisor-control";
import { PILOT_CLAIM, validatePilotClaim, type PilotClaim } from "./pilot-authorization";
import { auditLegacyCapacity, type AdmissionCapacityEvidence,
  type LegacyCapacityStop } from "./supervisor-legacy-capacity";
import { r2TurnAdmission, r2SessionId, r2TurnJournalKey, r2TerminalNativeReceipt, type R2TurnJournal } from "./supervisor-r2";
import { scopeStorageKey, type ProjectScope } from "./project-scope";
import { captureHistoricalSnapshot, historicalCertificate, retiredHistoricalTask, writeHistoricalCertificate, publicHistoricalCertificate, validNativeQuiescence, parseReconciliationManifest, type ReconciliationManifest, type NativeQuiescence } from "./supervisor-reconciliation";

/**
 * One durable admission authority in the existing supervisor DO. This is NOT
 * an inference scheduler: T07 budgets the provider and T04 reconciles effects.
 *
 * No external calls may occur inside storage.transaction. Bounded to 10 slots,
 * with permanent per-request identity kept in supervisor:task:<requestId>.
 */
const LEDGER_KEY = "supervisor:admission:v1";
const DEFAULT_CAPACITY = 10;
const LEASE_MS = 60_000;
type StartEffect = "github_branch" | "session_create" | "pilot_prepare" | "configure" | "submit" | "turn_submit" | ReadOnlyStartEffect;
type SlotPhase = "reserved" | "effect_unknown" | "running";
export type AdmissionSlot = {
  token: string; generation: number; expiresAt: number;
  phase: SlotPhase; effect?: StartEffect;
};
type Ledger = { version: 1; slots: Record<string, AdmissionSlot> };
export type StartGrant = { id: string; token: string; generation: number };
export type AdmissionDecision =
  | { kind: "granted"; task: SupervisorTask; grant: StartGrant; reused: boolean }
  | { kind: "reused"; task: SupervisorTask; reason: string; slot?: AdmissionSlot }
  | { kind: "capacity"; reason: "CAPACITY_EXHAUSTED" | LegacyCapacityStop; retryAfterMs: number };

const terminal = (status: SupervisorTask["status"]) =>
  ["finished", "failed", "cancelled", "unanswered"].includes(status);

function decodeLedger(value: unknown): Ledger {
  if (value === undefined) return { version: 1, slots: Object.create(null) as Record<string, AdmissionSlot> };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ADMISSION_LEDGER_INVALID");
  const row = value as Partial<Ledger>;
  if (row.version !== 1 || !row.slots || typeof row.slots !== "object" || Array.isArray(row.slots) ||
      Object.keys(row.slots).length > DEFAULT_CAPACITY)
    throw new Error("ADMISSION_LEDGER_INVALID");
  for (const [id, slot] of Object.entries(row.slots)) {
    if (!/^[a-f0-9]{16}$/.test(id) || !slot || typeof slot.token !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(slot.token) ||
        !Number.isSafeInteger(slot.generation) || slot.generation < 1 ||
        !Number.isSafeInteger(slot.expiresAt) ||
        !["reserved", "effect_unknown", "running"].includes(slot.phase))
      throw new Error("ADMISSION_LEDGER_INVALID");
  }
  return row as Ledger;
}

function newGrant(id: string, generation: number, now: number): AdmissionSlot {
  return { token: crypto.randomUUID(), generation, expiresAt: now + LEASE_MS, phase: "reserved" };
}

/** Never auto-reclaim ambiguous external effects merely because a TTL elapsed. */
export async function reserveSupervisorAdmission(
  storage: DurableObjectStorage, candidate: SupervisorTask, now = Date.now(),
  readOnlyPins?: ReadOnlySourcePins, pilot?: PilotClaim, nativeQuiescence?:NativeQuiescence
): Promise<AdmissionDecision> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("ADMISSION_CLOCK_INVALID");
  const key = supervisorTaskKey(candidate.id);
  const readOnly = isReadOnlyTask(candidate);
  if (readOnly !== (readOnlyPins !== undefined)) throw Error("READ_ONLY_ADMISSION_PINS_REQUIRED");
  if (readOnlyPins) { validClock(now); validateReadOnlyCandidate(candidate, readOnlyPins); }
  return storage.transaction(async tx => {
    if(await retiredHistoricalTask(tx,candidate.id))throw Error("HISTORICAL_TASK_QUARANTINED");
    const old = await tx.get<SupervisorTask>(key);
    const previousPilot=await tx.get<PilotClaim>(PILOT_CLAIM);
    if(Boolean(candidate.pilotInstance)!==Boolean(pilot))throw Error("PILOT_AUTHORIZATION_REQUIRED");
    if(pilot){
      validatePilotClaim(pilot,candidate,now);
      if(previousPilot||old)throw Error("PILOT_NO_REPLAY");
    }else if(previousPilot&&now<previousPilot.startedAt+20*60_000)throw Error("PILOT_EXCLUSIVE_LANE");
    const journal = await readOnlyJournal(tx, candidate.id);
    if (old && isReadOnlyTask(old) !== readOnly || journal && !old ||
        old && readOnly && (!journal || !samePins(journal.pins, readOnlyPins!)) ||
        journal && !readOnly) throw Error("READ_ONLY_ADMISSION_IDENTITY_CONFLICT");
    if (old && old.fingerprint !== candidate.fingerprint)
      throw new Error("requestId usado con otra tarea");
    if (old && readOnly) await requireReadOnlyJournal(tx,old);
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    if(pilot&&Object.keys(ledger.slots).length!==0)throw Error("PILOT_EXCLUSIVE_SLOT_REQUIRED");
    let changed = false;
    // At most 10 lookups, regardless of total historical task count.
    for (const [id, slot] of Object.entries(ledger.slots)) {
      const task = await tx.get<SupervisorTask>(supervisorTaskKey(id));
      if (!task) throw new Error("ADMISSION_ORPHAN_SLOT");
      if (slot.phase !== "effect_unknown" && terminal(task.status) &&
          !task.pendingTurn && !task.cancelAmbiguous) {
        delete ledger.slots[id]; changed = true;
      }
    }
    if (old) {
      const slot = ledger.slots[candidate.id];
      if (!slot) {
        if (changed) await tx.put(LEDGER_KEY, ledger);
        // Legacy records (including unknown) must be reconciled, not restarted.
        return { kind: "reused", task: old,
          reason: terminal(old.status) ? "TERMINAL" : "LEGACY_RECONCILE_REQUIRED" };
      }
      if (slot.phase !== "reserved" || slot.expiresAt > now) {
        if (changed) await tx.put(LEDGER_KEY, ledger);
        return { kind: "reused", task: old,
          reason: slot.phase === "effect_unknown" ? "EFFECT_UNCONFIRMED" :
            slot.phase === "running" ? "ALREADY_RUNNING" : "LEASE_HELD", slot };
      }
      if (readOnly && (old.status !== "preparing" || !activeReadOnlyStart(old))) {
        if (changed) await tx.put(LEDGER_KEY,ledger);
        return {kind:"reused" as const,task:old,reason:"READ_ONLY_START_NOT_ACTIVE",slot};
      }
      // A pre-effect lease can be reclaimed only when old unmetered work
      // cannot silently consume more capacity. Check in the SAME transaction.
      const census = await auditLegacyCapacity(tx, ledger.slots);
      if (census.stopReason) {
        if (changed) await tx.put(LEDGER_KEY, ledger);
        return { kind: "reused" as const, task: old, reason: census.stopReason, slot };
      }
      // The old owner is fenced by token+generation on every external transition.
      const next = newGrant(candidate.id, slot.generation + 1, now);
      ledger.slots[candidate.id] = next;
      await tx.put(LEDGER_KEY, ledger);
      return { kind: "granted", task: old,
        grant: { id: candidate.id, token: next.token, generation: next.generation }, reused: true };
    }
    if(pilot){
      // Server-side fresh native scan AND exact archived inventory in this
      // transaction. No user input can substitute a historical certificate.
      const cert=await historicalCertificate(tx);
      if(cert||nativeQuiescence){
        if(!cert||!nativeQuiescence||cert.digest!==pilot.approval.reconciliationDigest||
           cert.supervisorObject!==pilot.objectId||cert.manifest.releaseSha!==pilot.approval.releaseSha||
           cert.manifest.requestId!==candidate.id||cert.nativeDigest!==nativeQuiescence.digest||
           !await validNativeQuiescence(nativeQuiescence,now,cert.observedAt)||
           now-cert.observedAt>60*60_000||await tx.get("supervisor:inference:budget:v1")!==undefined||
           (await captureHistoricalSnapshot(tx)).digest!==cert.snapshotDigest)
          throw Error("HISTORICAL_PILOT_CERTIFICATE_STALE");
      }else throw Error("HISTORICAL_PILOT_CERTIFICATE_REQUIRED");
    }
    const census = await auditLegacyCapacity(tx, ledger.slots);
    if (census.stopReason) {
      if (changed) await tx.put(LEDGER_KEY, ledger);
      return {kind:"capacity" as const, reason:census.stopReason, retryAfterMs:0};
    }
    if (Object.keys(ledger.slots).length >= DEFAULT_CAPACITY) {
      if (changed) await tx.put(LEDGER_KEY, ledger);
      // Not accepted and no task record: explicit backpressure, no lost work.
      return { kind: "capacity", reason: "CAPACITY_EXHAUSTED", retryAfterMs: 1_000 };
    }
    if(pilot && Object.keys(ledger.slots).length!==0)throw Error("PILOT_EXCLUSIVE_SLOT_REQUIRED");
    const slot = newGrant(candidate.id, 1, now);
    ledger.slots[candidate.id] = slot;
    if(pilot)await tx.put(PILOT_CLAIM,pilot);
    await tx.put(key, candidate);
    if (readOnlyPins) await tx.put(readOnlyJournalKey(candidate.id), {
      version: 1, pins: {commit:readOnlyPins.commit,tree:readOnlyPins.tree},
      repository:candidate.repository, project:candidate.project, fingerprint:candidate.fingerprint,
      receipts:[]
    } satisfies ReadOnlyAdmissionJournal);
    await tx.put(LEDGER_KEY, ledger);
    return { kind: "granted", task: candidate,
      grant: { id: candidate.id, token: slot.token, generation: 1 }, reused: false };
  });
}

export async function supervisorBeginExternalEffect(
  storage: DurableObjectStorage, grant: StartGrant, effect: StartEffect, now = Date.now()
): Promise<void> {
  await storage.transaction(async tx => {
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[grant.id];
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(grant.id));
    if (task && isReadOnlyTask(task) || await readOnlyJournal(tx, grant.id))
      throw Error("READ_ONLY_TRANSACTION_REQUIRED");
    if (!task || task.status !== "preparing" && task.status !== "running" ||
        !slot || slot.token !== grant.token || slot.generation !== grant.generation ||
        slot.phase !== "reserved" || slot.expiresAt <= now)
      throw new Error("ADMISSION_FENCE_REJECTED");
    slot.phase = "effect_unknown";
    slot.effect = effect;
    await tx.put(LEDGER_KEY, ledger); // WRITE AHEAD, before external RPC
  });
}

export async function supervisorConfirmExternalEffect(
  storage: DurableObjectStorage, grant: StartGrant, effect: StartEffect,
  receipt: { confirmed: boolean }, now = Date.now()
): Promise<void> {
  if (!receipt.confirmed) throw new Error("ADMISSION_RECEIPT_UNCONFIRMED");
  await storage.transaction(async tx => {
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[grant.id];
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(grant.id));
    if (task && isReadOnlyTask(task) || await readOnlyJournal(tx, grant.id))
      throw Error("READ_ONLY_TRANSACTION_REQUIRED");
    if (!slot || slot.token !== grant.token || slot.generation !== grant.generation ||
        slot.phase !== "effect_unknown" || slot.effect !== effect)
      throw new Error("ADMISSION_FENCE_REJECTED");
    // A successfully submitted operation retains capacity until terminal
    // status is durably observed; an unknown operation is NEVER automatically released.
    slot.phase = effect === "submit" ? "running" : "reserved";
    slot.effect = undefined;
    slot.expiresAt = now + LEASE_MS;
    await tx.put(LEDGER_KEY, ledger);
  });
}

export async function supervisorAdmissionSlot(
  storage: Pick<DurableObjectStorage, "get">, id: string
): Promise<AdmissionSlot | undefined> {
  supervisorTaskKey(id);
  const ledger = decodeLedger(await storage.get<Ledger>(LEDGER_KEY));
  const slot = ledger.slots[id];
  return slot ? { ...slot } : undefined; // NEVER expose token on public receipts
}

/** For T04 cancellation: the existence of an admission slot invalidates a
 * claim that no session creation could have started. Inspect in same tx. */
export async function hasSupervisorAdmissionSlot(
  tx: Pick<DurableObjectTransaction, "get">, id: string
): Promise<boolean> {
  supervisorTaskKey(id);
  const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
  return Boolean(ledger.slots[id]);
}


/** Only a POSITIVE native OpenCode receipt may reconcile an ambiguous submit.
 * A timeout, missing session or operation.reason=not_found is never enough.
 * This does not replay submit and does not claim output correctness.
 */
export async function reconcileSupervisorSubmittedEffect(
  storage: DurableObjectStorage, id: string, operationId: string,
  receipt: { status: "done" | "unanswered"; reason?: string }
): Promise<boolean> {
  supervisorTaskKey(id);
  if (receipt.status !== "done" && receipt.status !== "unanswered" ||
      receipt.reason === "not_found") return false;
  return storage.transaction(async tx => {
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(id));
    if (!task || task.operationId !== operationId || !/^rc-start-[a-f0-9]{16}$/.test(operationId))
      return false;
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[id];
    if (!slot || slot.phase !== "effect_unknown" || slot.effect !== "submit") return false;
    if (isReadOnlyTask(task)) {
      const j = await requireReadOnlyJournal(tx, task);
      if (!task.session || !matchesPending(j, slot, "submit")) return false;
      finishReadOnlyReceipt(j, slot, {effect:"submit", project:task.project,
        repository:task.repository, sessionId:task.session, operationId,
        nativeStatus:receipt.status}, task, Date.now());
      await tx.put(readOnlyJournalKey(id), j);
    } else if (await readOnlyJournal(tx,id)) return false;
    slot.phase = "running";
    slot.effect = undefined;
    await tx.put(LEDGER_KEY, ledger);
    return true;
  });
}

/** Turn arbitration is task-local, but it cannot overtake an unsettled
 * initial T03 external effect. Legacy tasks without a slot retain their
 * existing continuation behavior; an active slot must be fully running. */
export function supervisorAdmissionAllowsContinuation(
  slot: AdmissionSlot | undefined, managedByAdmission = false
): boolean {
  // No new native turn is safe for unmetered legacy (no slot), regardless
  // of the old status string. T04 may still READ/reconcile prior receipts.
  return slot?.phase === "running";
}

/** The bounded authoritative SDK lookup is performed by the caller outside
 * this transaction. The positive result is only a candidate: the ledger,
 * per-task owner, and per-project scope are rechecked atomically before
 * ownership is transferred. This operation itself performs no SDK writes. */
export async function reconcileSupervisorCreatedSession(
  storage: DurableObjectStorage, id: string, sessionId: string,
  expected: AdmissionSlot, now = Date.now()
): Promise<{ kind: "recovered"; task: SupervisorTask; grant: StartGrant } |
           { kind: "stale"; reason: string }> {
  if (sessionId !== r2SessionId(id)) throw Error("SESSION_RECONCILE_ID_MISMATCH");
  if (!Number.isSafeInteger(now) || now < 0) throw Error("ADMISSION_CLOCK_INVALID");
  return storage.transaction(async tx => {
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(id));
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[id];
    if (!task || !slot || task.sessionIdPolicy !== "deterministic-v1" ||
        task.forkedFrom || task.session || task.sessionCreationAttempted !== true ||
        isReadOnlyTask(task) && (task.cancelAmbiguous || task.pendingTurn) ||
        task.status !== "preparing" && task.status !== "unknown" ||
        slot.token !== expected.token || slot.generation !== expected.generation ||
        slot.phase !== "effect_unknown" || slot.effect !== "session_create")
      return { kind: "stale" as const, reason: "SESSION_RECONCILE_FENCE_OR_STATE_CHANGED" };
    const reverse = await tx.get<string>("supervisor:session:" + sessionId);
    const scope = await tx.get<ProjectScope>(scopeStorageKey(sessionId));
    if (reverse && reverse !== task.id ||
        scope && (scope.project !== task.project ||
          scope.repository?.toLowerCase() !== task.repository.toLowerCase()))
      throw Error("SESSION_RECONCILE_SCOPE_CONFLICT");
    // Even if the original request returns after this point, its old token
    // cannot commit another task record. One session ID, one durable owner.
    if (isReadOnlyTask(task)) {
      const j = await requireReadOnlyJournal(tx, task);
      if (!matchesPending(j, slot, "session_create"))
        return {kind:"stale" as const,reason:"READ_ONLY_SESSION_INTENT_MISSING"};
      finishReadOnlyReceipt(j,slot,{effect:"session_create",project:task.project,
        repository:task.repository,sessionId},task,now);
      await tx.put(readOnlyJournalKey(id),j);
    } else if (await readOnlyJournal(tx,id)) throw Error("READ_ONLY_ADMISSION_IDENTITY_CONFLICT");
    const next = newGrant(id, slot.generation + 1, now);
    ledger.slots[id] = next;
    const updated: SupervisorTask = { ...task, session: sessionId,
      status: "preparing", error: undefined,
      revision: (task.revision ?? 0) + 1, updatedAt: now };
    await tx.put(supervisorTaskKey(id), updated);
    await tx.put("supervisor:session:" + sessionId, id);
    await tx.put(LEDGER_KEY, ledger);
    return { kind: "recovered" as const, task: updated,
      grant: { id, token: next.token, generation: next.generation } };
  });
}

/** Check a stale caller's original grant INSIDE the same transaction that
 * would modify the task after any external SDK failure. An earlier GET or a
 * local lock TTL does not fence a writer after session_create recovery. */
export async function supervisorGrantStillOwned(
  tx: Pick<DurableObjectTransaction, "get">, grant: StartGrant
): Promise<boolean> {
  const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
  const slot = ledger.slots[grant.id];
  return Boolean(slot && slot.token === grant.token &&
    slot.generation === grant.generation);
}

/** Original creator must commit its receipt under the exact initial fence.
 * A reconciler transferring ownership makes late creator receipts stale. */
export async function supervisorCommitCreatedSession(
  storage: DurableObjectStorage, grant: StartGrant, sessionId: string,
  now = Date.now()
): Promise<SupervisorTask> {
  if (sessionId !== r2SessionId(grant.id)) throw Error("SESSION_CREATE_ID_MISMATCH");
  return storage.transaction(async tx => {
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[grant.id];
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(grant.id));
    if (task && isReadOnlyTask(task) || await readOnlyJournal(tx,grant.id))
      throw Error("READ_ONLY_TRANSACTION_REQUIRED");
    if (!task || task.sessionIdPolicy !== "deterministic-v1" ||
        !task.sessionCreationAttempted || task.session || task.forkedFrom ||
        !slot || slot.token !== grant.token || slot.generation !== grant.generation ||
        slot.phase !== "effect_unknown" || slot.effect !== "session_create")
      throw Error("ADMISSION_FENCE_REJECTED");
    const reverse = await tx.get<string>("supervisor:session:" + sessionId);
    const scope = await tx.get<ProjectScope>(scopeStorageKey(sessionId));
    if (reverse && reverse !== grant.id ||
        scope && (scope.project !== task.project ||
          scope.repository?.toLowerCase() !== task.repository.toLowerCase()))
      throw Error("SESSION_CREATE_SCOPE_CONFLICT");
    const next: SupervisorTask = { ...task, session: sessionId,
      revision: (task.revision ?? 0) + 1, updatedAt: now };
    slot.phase = "reserved";
    slot.effect = undefined;
    slot.expiresAt = now + LEASE_MS;
    await tx.put(supervisorTaskKey(grant.id), next);
    await tx.put("supervisor:session:" + sessionId, grant.id);
    await tx.put(LEDGER_KEY, ledger);
    return next;
  });
}

export type TurnReservation =
  | { kind: "submit"; task: SupervisorTask; journal: R2TurnJournal }
  | { kind: "existing"; task: SupervisorTask; journal: R2TurnJournal }
  | { kind: "capacity"; reason: "CAPACITY_EXHAUSTED" | LegacyCapacityStop; retryAfterMs: number };

/** Reserve capacity and a continuation intent in ONE DO transaction.
 * No turn RPC is allowed between a separate capacity preflight and journal.
 * A task whose terminal slot was reclaimed is readmitted only for a new,
 * verified finished operation, and only if a slot is actually available. */
export async function reserveSupervisorContinuation(
  storage: DurableObjectStorage, id: string, turnId: string,
  hash: string, operationId: string, now = Date.now()
): Promise<TurnReservation> {
  const key = r2TurnJournalKey(id, turnId);
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(now) || now < 0)
    throw Error("SUPERVISOR_TURN_INPUT_INVALID");
  return storage.transaction(async tx => {
    if(await retiredHistoricalTask(tx,id))throw Error("HISTORICAL_TASK_QUARANTINED");
    const taskKey = supervisorTaskKey(id);
    const task = await tx.get<SupervisorTask>(taskKey);
    if (!task?.session) throw Error("Tarea no disponible");
    const previous = await tx.get<R2TurnJournal>(key);
    if (previous && (previous.hash !== hash || previous.session !== task.session ||
        previous.operationId !== operationId)) throw Error("turnId reutilizado con otra instrucción");
    // Once a native call could have escaped, *any* duplicate HTTP request
    // returns a receipt for reconciliation, never replays the side effect.
    if (previous) return {kind:"existing" as const, task, journal:previous};
    if (isReadOnlyTask(task)) {
      const j = await requireReadOnlyJournal(tx,task);
      if (j.pending || j.receipts.length !== READ_ONLY_STEPS.length)
        throw Error("READ_ONLY_INITIAL_EFFECT_NOT_SETTLED");
    } else if (await readOnlyJournal(tx,id)) throw Error("READ_ONLY_ADMISSION_IDENTITY_CONFLICT");
    // Preserve legacy journals without allowing another native submit.
    if (task.sessionIdPolicy !== "deterministic-v1")
      throw Error("SUPERVISOR_LEGACY_QUARANTINED");
    const decision = r2TurnAdmission(task, operationId);
    if (decision === "denied") throw Error("SUPERVISOR_TURN_DENIED_TERMINAL_OR_CANCEL");
    if (decision === "busy") throw Error("SUPERVISOR_TURN_IN_FLIGHT");
    if (task.sessionIdPolicy === "deterministic-v1") {
      const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
      const census = await auditLegacyCapacity(tx, ledger.slots);
      if (census.stopReason) {
        return {kind:"capacity" as const,reason:census.stopReason,retryAfterMs:0};
      }
      // Bounded at ten slots. Only terminal records with *confirmed* no
      // in-flight effect are released. Never reclaim effect_unknown on TTL.
      for (const [owner, slot] of Object.entries(ledger.slots)) {
        if (slot.phase === "effect_unknown") continue;
        const other = await tx.get<SupervisorTask>(supervisorTaskKey(owner));
        if (!other) throw Error("ADMISSION_ORPHAN_SLOT");
        if (terminal(other.status) && !other.pendingTurn && !other.cancelAmbiguous)
          delete ledger.slots[owner];
      }
      let slot = ledger.slots[id];
      if (!slot) {
        // Re-admission is only available to a completed task with a
        // stable native cursor. It does not start or retry an old operation.
        if (task.status !== "finished" || !task.operationId || task.pendingTurn ||
            task.cancelAmbiguous) throw Error("SUPERVISOR_READMISSION_REQUIRES_FINISHED");
        if (Object.keys(ledger.slots).length >= DEFAULT_CAPACITY)
          return {kind:"capacity" as const,reason:"CAPACITY_EXHAUSTED" as const,
            retryAfterMs:1_000};
        slot = newGrant(id, Math.max(task.revision ?? 0, 1) + 1, now);
        slot.phase = "running";
        ledger.slots[id] = slot;
      } else if (slot.phase !== "running") {
        throw Error("SUPERVISOR_INITIAL_EFFECT_NOT_SETTLED");
      }
      // A lost turn-submit receipt cannot be interpreted as free capacity.
      slot.phase = "effect_unknown";
      slot.effect = "turn_submit";
      slot.expiresAt = now + LEASE_MS;
      await tx.put(LEDGER_KEY, ledger);
    }
    const journal: R2TurnJournal = { hash, operationId, session:task.session,
      phase:"intent", revision:(task.revision ?? 0)+1 };
    const next: SupervisorTask = { ...task,
      pendingTurn: { turnId, operationId }, operationId, status:"running",
      revision:journal.revision, updatedAt:now };
    await tx.put(key,journal);
    await tx.put(taskKey,next);
    return {kind:"submit" as const, task:next, journal};
  });
}

/** A submission reply only confirms admission, not completion. Keep the
 * pending turn until exact native terminal evidence, and keep ambiguous
 * effects resident in the global capacity ledger. */
export async function recordSupervisorContinuationReceipt(
  storage: DurableObjectStorage, id: string, turnId: string, operationId: string,
  result: { accepted?: boolean; error?: string }, now = Date.now()
): Promise<SupervisorTask> {
  return storage.transaction(async tx => {
    const key = r2TurnJournalKey(id,turnId);
    const taskKey = supervisorTaskKey(id);
    const journal = await tx.get<R2TurnJournal>(key);
    const task = await tx.get<SupervisorTask>(taskKey);
    if (!journal || !task || journal.operationId !== operationId)
      throw Error("SUPERVISOR_TURN_JOURNAL_MISSING");
    if (journal.phase !== "intent") return task;
    const accepted = !result.error && typeof result.accepted === "boolean";
    await tx.put(key,{...journal,phase:accepted ? "accepted" as const : "unknown" as const});
    if (task.sessionIdPolicy === "deterministic-v1") {
      const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
      const slot = ledger.slots[id];
      if (!slot || slot.phase !== "effect_unknown" || slot.effect !== "turn_submit")
        throw Error("SUPERVISOR_TURN_CAPACITY_UNCONFIRMED");
      if (accepted) {
        slot.phase = "running"; slot.effect = undefined;
        await tx.put(LEDGER_KEY,ledger);
      }
    }
    if (task.operationId !== operationId || task.pendingTurn?.operationId !== operationId ||
        task.status === "cancel_requested" || task.status === "cancelled" || task.cancelAmbiguous)
      return task;
    const next: SupervisorTask = { ...task, status:accepted ? "running" : "unknown",
      ...(accepted ? {error:undefined} : {error:result.error ?? "TURN_RECEIPT_UNCONFIRMED"}),
      revision:(task.revision ?? 0)+1,updatedAt:now };
    await tx.put(taskKey,next);
    return next;
  });
}

/** Call inside the existing T04 status CAS transaction after a matching
 * native terminal receipt. Only a persisted terminal native receipt allows
 * a turn-submit unknown lease to return to running/terminal reclamation. */
export async function reconcileSupervisorTurnEffect(
  tx: Pick<DurableObjectTransaction,"get"|"put">,
  id: string, operationId: string,
  receipt: {status:"done"|"unanswered";reason?:string}
): Promise<boolean> {
  if (!r2TerminalNativeReceipt(receipt)) return false;
  const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
  const slot = ledger.slots[id];
  if (!slot || slot.phase !== "effect_unknown" || slot.effect !== "turn_submit")
    return false;
  const task = await tx.get<SupervisorTask>(supervisorTaskKey(id));
  if (!task || task.operationId !== operationId || task.pendingTurn?.operationId !== operationId)
    return false;
  slot.phase="running";slot.effect=undefined;
  await tx.put(LEDGER_KEY,ledger);
  return true;
}

/** Bounded status-only evidence: not a native execution metric. */
export async function inspectSupervisorAdmissionCapacity(
  storage: DurableObjectStorage
): Promise<AdmissionCapacityEvidence> {
  return storage.transaction(async tx => {
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    return auditLegacyCapacity(tx, ledger.slots);
  });
}


/**
 * C05/T02: bounded write-ahead journal for the initial read_only start.
 * One existing global slot, no additional capacity and NO provider authorization.
 * All receipts are internal trusted observations, never request-body assertions.
 */
export type ReadOnlySourcePins = { commit: string; tree: string };
const READ_ONLY_STEPS = ["project_reserve", "container_import", "session_create",
  "scope_bind", "configure_agent", "configure_model", "submit"] as const;
export type ReadOnlyStartEffect = typeof READ_ONLY_STEPS[number];
export type ReadOnlyEffectReceipt = {
  effect: ReadOnlyStartEffect; project: string; repository: string;
  commit?: string; tree?: string; files?: number; sha256?: string;
  sessionId?: string; agent?: string; model?: string; operationId?: string;
  accepted?: true; nativeStatus?: "done" | "unanswered";
};
type ReadOnlyStoredReceipt = { generation:number; confirmedAt:number; evidence:ReadOnlyEffectReceipt };
export type ReadOnlyAdmissionJournal = {
  version:1; pins:ReadOnlySourcePins; repository:string; project:string; fingerprint:string;
  sourceVerifiedAt?:number;
  pending?:{effect:ReadOnlyStartEffect; generation:number; startedAt:number};
  receipts:ReadOnlyStoredReceipt[];
};
const sha40 = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
function isReadOnlyTask(task: SupervisorTask): boolean {
  return (task as SupervisorTask & {mode?:string}).mode === "read_only";
}
function samePins(a:ReadOnlySourcePins, b:ReadOnlySourcePins):boolean {
  return a.commit === b.commit && a.tree === b.tree;
}
function readOnlyJournalKey(id:string):string {
  supervisorTaskKey(id);
  return "supervisor:read-only-start:v1:" + id;
}
function validateReadOnlyCandidate(task:SupervisorTask,pins:ReadOnlySourcePins):void {
  if (!pins || !sha40(pins.commit) || !sha40(pins.tree) || task.branch !== "" ||
      task.forkedFrom || task.session || task.operationId || task.baseCommit ||
      task.sessionCreationAttempted !== false || task.sessionIdPolicy !== "deterministic-v1" ||
      task.status !== "preparing" || task.pendingTurn || task.cancelAmbiguous)
    throw Error("READ_ONLY_ADMISSION_CANDIDATE_INVALID");
  if (task.sourceCommit !== pins.commit || task.sourceTree !== pins.tree) throw Error("READ_ONLY_SOURCE_PIN_MISMATCH");
}
async function readOnlyJournal(tx:Pick<DurableObjectTransaction,"get">,id:string):Promise<ReadOnlyAdmissionJournal|undefined> {
  const j = await tx.get<ReadOnlyAdmissionJournal>(readOnlyJournalKey(id));
  if (j === undefined) return undefined;
  if (!j || j.version !== 1 || !j.pins || !sha40(j.pins.commit) || !sha40(j.pins.tree) ||
      typeof j.repository !== "string" || typeof j.project !== "string" ||
      typeof j.fingerprint !== "string" || !Array.isArray(j.receipts) ||
      j.receipts.length > READ_ONLY_STEPS.length ||
      j.sourceVerifiedAt !== undefined && (!Number.isSafeInteger(j.sourceVerifiedAt) || j.sourceVerifiedAt < 0) ||
      (j.receipts.length > 0 || j.pending) && j.sourceVerifiedAt === undefined ||
      j.receipts.some((r,i)=>!r || !r.evidence || r.evidence.effect !== READ_ONLY_STEPS[i] ||
        !Number.isSafeInteger(r.generation) || r.generation < 1 || !Number.isSafeInteger(r.confirmedAt)) ||
      j.pending && (j.pending.effect !== READ_ONLY_STEPS[j.receipts.length] ||
        !Number.isSafeInteger(j.pending.generation) || j.pending.generation < 1 ||
        !Number.isSafeInteger(j.pending.startedAt)))
    throw Error("READ_ONLY_ADMISSION_JOURNAL_INVALID");
  return j;
}
async function requireReadOnlyJournal(tx:Pick<DurableObjectTransaction,"get">,task:SupervisorTask):Promise<ReadOnlyAdmissionJournal> {
  const j = await readOnlyJournal(tx,task.id);
  if (!j || !isReadOnlyTask(task) || task.branch !== "" || task.forkedFrom ||
      task.repository !== j.repository || task.project !== j.project || task.fingerprint !== j.fingerprint ||
      task.sourceCommit !== j.pins.commit || task.sourceTree !== j.pins.tree ||
      j.sourceVerifiedAt !== undefined && (task.baseCommit !== j.pins.commit ||
        (task as SupervisorTask & {sourceTree?:string}).sourceTree !== j.pins.tree))
    throw Error("READ_ONLY_ADMISSION_IDENTITY_CONFLICT");
  for (const r of j.receipts) normalizeReadOnlyReceipt(r.evidence,j,task);
  return j;
}
function matchesPending(j:ReadOnlyAdmissionJournal,slot:AdmissionSlot,effect:ReadOnlyStartEffect):boolean {
  return slot.phase === "effect_unknown" && slot.effect === effect &&
    j.pending?.effect === effect && j.pending.generation === slot.generation &&
    READ_ONLY_STEPS[j.receipts.length] === effect;
}
function activeReadOnlyStart(task:SupervisorTask):boolean {
  return (task.status === "preparing" || task.status === "running" || task.status === "unknown") &&
    !task.cancelAmbiguous && !task.pendingTurn;
}
function exactGrant(slot:AdmissionSlot|undefined,grant:StartGrant):slot is AdmissionSlot {
  return Boolean(slot && slot.token === grant.token && slot.generation === grant.generation);
}
function validClock(now:number):void {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - LEASE_MS)
    throw Error("ADMISSION_CLOCK_INVALID");
}
function normalizeReadOnlyReceipt(r:ReadOnlyEffectReceipt,j:ReadOnlyAdmissionJournal,task:SupervisorTask):ReadOnlyEffectReceipt {
  if (!r || r.project !== j.project || typeof r.repository !== "string" ||
      r.repository.toLowerCase() !== j.repository.toLowerCase())
    throw Error("READ_ONLY_RECEIPT_SCOPE_MISMATCH");
  const base = {effect:r.effect,project:j.project,repository:j.repository};
  if (r.effect === "project_reserve") return base;
  if (r.effect === "container_import") {
    if (r.commit !== j.pins.commit || r.tree !== j.pins.tree || typeof r.files !== "number" ||
        !Number.isSafeInteger(r.files) || r.files < 1 || typeof r.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(r.sha256)) throw Error("READ_ONLY_IMPORT_RECEIPT_INVALID");
    return {...base,commit:r.commit,tree:r.tree,files:r.files,sha256:r.sha256};
  }
  if (r.sessionId !== r2SessionId(task.id)) throw Error("READ_ONLY_RECEIPT_SESSION_MISMATCH");
  const session = {...base,sessionId:r.sessionId};
  if (r.effect === "session_create" || r.effect === "scope_bind") return session;
  if (r.effect === "configure_agent" && r.agent === "build") return {...session,agent:r.agent};
  if (r.effect === "configure_model" && r.model === (task.model ?? "economy"))
    return {...session,model:r.model};
  if (r.effect === "submit" && r.operationId === supervisorStartOperationId(task.id)) {
    if (r.accepted === true) return {...session,operationId:r.operationId,accepted:true};
    if (r.nativeStatus === "done" || r.nativeStatus === "unanswered")
      return {...session,operationId:r.operationId,nativeStatus:r.nativeStatus};
  }
  throw Error("READ_ONLY_EFFECT_RECEIPT_INVALID");
}
function finishReadOnlyReceipt(j:ReadOnlyAdmissionJournal,slot:AdmissionSlot,r:ReadOnlyEffectReceipt,task:SupervisorTask,now:number):void {
  if (!matchesPending(j,slot,r.effect)) throw Error("ADMISSION_FENCE_REJECTED");
  const evidence = normalizeReadOnlyReceipt(r,j,task);
  j.receipts.push({generation:slot.generation,confirmedAt:now,evidence});
  delete j.pending;
  slot.phase = r.effect === "submit" ? "running" : "reserved";
  slot.effect = undefined;
  slot.expiresAt = now + LEASE_MS;
}

/** GET has no Container/session effect. Expected pins were journalled at
 * reservation; a retry may repeat GET but only the current unexpired grant
 * can persist its exact authoritative result. No model setup before import. */
export async function supervisorVerifyReadOnlySource(storage:DurableObjectStorage,grant:StartGrant,source:{repo:string;commit:string;tree:string},now=Date.now()):Promise<SupervisorTask> {
  validClock(now);
  return storage.transaction(async tx=>{
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(grant.id));
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[grant.id];
    if (!task || !exactGrant(slot,grant) || slot.phase !== "reserved" || slot.expiresAt <= now ||
        task.status !== "preparing" || !activeReadOnlyStart(task)) throw Error("ADMISSION_FENCE_REJECTED");
    const j = await requireReadOnlyJournal(tx,task);
    if (typeof source?.repo !== "string" || source.repo.toLowerCase() !== j.repository.toLowerCase() ||
        !samePins(j.pins,source)) throw Error("READ_ONLY_SOURCE_PIN_MISMATCH");
    if (j.pending || j.receipts.length > 0) throw Error("READ_ONLY_SOURCE_ALREADY_ADVANCED");
    if (j.sourceVerifiedAt !== undefined) return task;
    j.sourceVerifiedAt = now;
    const updated = {...task,baseCommit:j.pins.commit,sourceTree:j.pins.tree,
      revision:(task.revision ?? 0)+1,updatedAt:now};
    slot.expiresAt = now + LEASE_MS;
    await tx.put(supervisorTaskKey(grant.id),updated);
    await tx.put(readOnlyJournalKey(grant.id),j);
    await tx.put(LEDGER_KEY,ledger);
    return updated;
  });
}

/** Exactly one fresh intent may dispatch exactly one named RPC. A caller
 * must not replay it after a lost response, including after a restart.
 * This is admission only: submit STILL needs the independent budget and
 * provider gate. STOP_LIVE is not lifted by a journal or a StartGrant. */
export async function supervisorBeginReadOnlyEffect(storage:DurableObjectStorage,grant:StartGrant,effect:ReadOnlyStartEffect,now=Date.now()):Promise<SupervisorTask> {
  validClock(now);
  return storage.transaction(async tx=>{
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(grant.id));
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[grant.id];
    if (!task || !exactGrant(slot,grant) || slot.phase !== "reserved" || slot.expiresAt <= now ||
        task.status !== "preparing" || !activeReadOnlyStart(task)) throw Error("ADMISSION_FENCE_REJECTED");
    const j = await requireReadOnlyJournal(tx,task);
    if (j.sourceVerifiedAt === undefined || j.pending || !READ_ONLY_STEPS.includes(effect) ||
        READ_ONLY_STEPS[j.receipts.length] !== effect)
      throw Error("READ_ONLY_EFFECT_ORDER");
    if (effect === "session_create" && (task.session || task.sessionCreationAttempted !== false) ||
        j.receipts.length >= 3 && task.session !== r2SessionId(task.id) ||
        task.operationId) throw Error("READ_ONLY_EFFECT_TASK_STATE");
    slot.phase = "effect_unknown";
    slot.effect = effect;
    j.pending = {effect,generation:slot.generation,startedAt:now};
    const updated:SupervisorTask = {...task,revision:(task.revision ?? 0)+1,updatedAt:now};
    if (effect === "session_create") updated.sessionCreationAttempted = true;
    if (effect === "submit") {
      updated.operationId = supervisorStartOperationId(task.id);
      updated.status = "running";
    }
    await tx.put(supervisorTaskKey(grant.id),updated);
    await tx.put(readOnlyJournalKey(grant.id),j);
    await tx.put(LEDGER_KEY,ledger);
    return updated;
  });
}

/** Persist the positive receipt and cursor in the SAME transaction as slot
 * release. A late receipt may settle uncertainty after cancellation, but
 * never clears cancel_requested/cancelled or authorizes another effect. */
export async function supervisorConfirmReadOnlyEffect(storage:DurableObjectStorage,grant:StartGrant,receipt:ReadOnlyEffectReceipt,now=Date.now()):Promise<SupervisorTask> {
  validClock(now);
  return storage.transaction(async tx=>{
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(grant.id));
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[grant.id];
    if (!task || !exactGrant(slot,grant)) throw Error("ADMISSION_FENCE_REJECTED");
    const j = await requireReadOnlyJournal(tx,task);
    if (!matchesPending(j,slot,receipt.effect)) throw Error("ADMISSION_FENCE_REJECTED");
    // Native terminal observations have their own exact-ID recovery path.
    if (receipt.nativeStatus !== undefined) throw Error("READ_ONLY_NATIVE_RECONCILE_REQUIRED");
    const evidence = normalizeReadOnlyReceipt(receipt,j,task);
    const updated:SupervisorTask = {...task,revision:(task.revision ?? 0)+1,updatedAt:now};
    if (receipt.effect === "session_create" || receipt.effect === "scope_bind") {
      const sessionId = r2SessionId(task.id);
      const reverse = await tx.get<string>("supervisor:session:" + sessionId);
      const scope = await tx.get<ProjectScope>(scopeStorageKey(sessionId));
      if (reverse && reverse !== task.id || scope && (scope.project !== task.project ||
          scope.repository?.toLowerCase() !== task.repository.toLowerCase()) ||
          receipt.effect === "scope_bind" && (!scope || reverse !== task.id))
        throw Error("SESSION_CREATE_SCOPE_CONFLICT");
      if (receipt.effect === "session_create") {
        if (!task.sessionCreationAttempted || task.session) throw Error("READ_ONLY_EFFECT_TASK_STATE");
        updated.session = sessionId;
        await tx.put("supervisor:session:" + sessionId,task.id);
      }
    }
    if (receipt.effect === "submit" && task.operationId !== evidence.operationId)
      throw Error("READ_ONLY_EFFECT_TASK_STATE");
    if (activeReadOnlyStart(task)) {
      updated.status = receipt.effect === "submit" ? "running" : "preparing";
      updated.error = undefined;
    } else if (receipt.effect === "submit") {
      // Acceptance racing cancellation does NOT prove the native operation
      // stopped. Retain capacity until cancellation is independently settled.
      updated.cancelAmbiguous = true;
    }
    finishReadOnlyReceipt(j,slot,evidence,task,now);
    await tx.put(supervisorTaskKey(grant.id),updated);
    await tx.put(readOnlyJournalKey(grant.id),j);
    await tx.put(LEDGER_KEY,ledger);
    return updated;
  });
}

/** Recover only from an independent positive exact observation: registry
 * GET, immutable Container receipt GET, or durable local scope binding.
 * Never repeat a mutation or interpret missing evidence/TTL as absence. */
export async function reconcileSupervisorReadOnlyPreparation(storage:DurableObjectStorage,id:string,expected:AdmissionSlot,receipt:ReadOnlyEffectReceipt,now=Date.now()):Promise<{task:SupervisorTask;grant:StartGrant}|undefined> {
  validClock(now);
  return storage.transaction(async tx=>{
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(id));
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[id];
    if (!task || !slot || slot.token !== expected.token || slot.generation !== expected.generation ||
        !activeReadOnlyStart(task) || task.status === "running" ||
        !["project_reserve","container_import","scope_bind"].includes(receipt.effect))
      return undefined;
    const j = await requireReadOnlyJournal(tx,task);
    if (!matchesPending(j,slot,receipt.effect)) return undefined;
    if (receipt.effect === "scope_bind") {
      const sid = r2SessionId(id);
      const scope = await tx.get<ProjectScope>(scopeStorageKey(sid));
      const reverse = await tx.get<string>("supervisor:session:" + sid);
      if (task.session !== sid || !scope || scope.project !== task.project ||
          scope.repository?.toLowerCase() !== task.repository.toLowerCase() || reverse !== id)
        return undefined;
    }
    finishReadOnlyReceipt(j,slot,receipt,task,now);
    const next = newGrant(id,slot.generation+1,now);
    ledger.slots[id] = next;
    const updated:SupervisorTask = {...task,status:"preparing",error:undefined,
      revision:(task.revision ?? 0)+1,updatedAt:now};
    await tx.put(supervisorTaskKey(id),updated);
    await tx.put(readOnlyJournalKey(id),j);
    await tx.put(LEDGER_KEY,ledger);
    return {task:updated,grant:{id,token:next.token,generation:next.generation}};
  });
}

/** Import-specific alias for T03: identical semantics, narrower recovery. */
export async function reconcileSupervisorReadOnlyImport(storage:DurableObjectStorage,id:string,expected:AdmissionSlot,receipt:ReadOnlyEffectReceipt,now=Date.now()):Promise<{task:SupervisorTask;grant:StartGrant}|undefined> {
  if (receipt.effect !== "container_import") throw Error("READ_ONLY_IMPORT_RECEIPT_INVALID");
  return reconcileSupervisorReadOnlyPreparation(storage,id,expected,receipt,now);
}

/** Failure reporting is fenced, never a substitute for a receipt. */
export async function supervisorRecordReadOnlyFailure(storage:DurableObjectStorage,grant:StartGrant,now=Date.now()):Promise<SupervisorTask|undefined> {
  validClock(now);
  return storage.transaction(async tx=>{
    const task = await tx.get<SupervisorTask>(supervisorTaskKey(grant.id));
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
    const slot = ledger.slots[grant.id];
    if (!task || !exactGrant(slot,grant) || !activeReadOnlyStart(task) ||
        slot.phase === "running" || slot.phase === "reserved" && slot.expiresAt <= now) return task;
    const j = await requireReadOnlyJournal(tx,task);
    if (slot.phase === "effect_unknown" && (!j.pending || !matchesPending(j,slot,j.pending.effect)))
      throw Error("READ_ONLY_ADMISSION_JOURNAL_INVALID");
    const updated:SupervisorTask = {...task,status:slot.phase === "effect_unknown" ? "unknown" : "failed",
      error:slot.phase === "effect_unknown" ? "READ_ONLY_EFFECT_UNCONFIRMED" : "READ_ONLY_PREFLIGHT_FAILED",
      revision:(task.revision ?? 0)+1,updatedAt:now};
    await tx.put(supervisorTaskKey(grant.id),updated);
    return updated;
  });
}

/** Internal read for restart routing; no token, no provider authorization. */
export async function inspectSupervisorReadOnlyAdmission(storage:Pick<DurableObjectStorage,"get">,id:string):Promise<ReadOnlyAdmissionJournal|undefined> {
  return readOnlyJournal(storage,id);
}

/** Maintenance-only caller: the Worker lane fences new producers and an
 * independent administrator attests prior-version drain. Two transactional
 * snapshots bracket the actual native reads. No RPC runs in a transaction.
 * Even a not_found/missing operation retains its original status forever:
 * this retires execution authority, not historical outcome uncertainty.
 */
export async function reconcileHistoricalSupervisor(storage:DurableObjectStorage,manifest:ReconciliationManifest,
 objectId:string,observe:()=>Promise<NativeQuiescence>,clock=Date.now){
 if(!parseReconciliationManifest(JSON.stringify(manifest),manifest.releaseSha,manifest.requestId,clock()))
  throw Error("HISTORICAL_MAINTENANCE_AUTHORIZATION_REQUIRED");
 const load=async(tx:DurableObjectTransaction)=>{
  if(await tx.get(PILOT_CLAIM)!==undefined)throw Error("HISTORICAL_PILOT_ALREADY_CONSUMED");
  // Never reset or rotate a potentially charged financial journal here.
  if(await tx.get("supervisor:inference:budget:v1")!==undefined)throw Error("HISTORICAL_BUDGET_RECONCILIATION_REQUIRED");
  const ledger=decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
  const snapshot=await captureHistoricalSnapshot(tx);
  return {ledger,snapshot};
 };
 const before=await storage.transaction(load);
 const native=await observe();
 return storage.transaction(async tx=>{
  const fresh=await load(tx);
  if(fresh.snapshot.digest!==before.snapshot.digest||JSON.stringify(fresh.ledger)!==JSON.stringify(before.ledger))
    throw Error("HISTORICAL_INVENTORY_CHANGED");
  const cert=await writeHistoricalCertificate(tx,manifest,objectId,fresh.snapshot,native,fresh.ledger.slots,clock());
  await tx.put(LEDGER_KEY,{version:1,slots:{}});
  const capacity=await auditLegacyCapacity(tx,{});
  if(capacity.stopReason||capacity.activeSlots!==0||!capacity.inventoryComplete)
    throw Error("HISTORICAL_RECONCILIATION_INCOMPLETE");
  return {...publicHistoricalCertificate(cert),capacity};
 });
}

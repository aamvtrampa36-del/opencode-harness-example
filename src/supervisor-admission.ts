import { supervisorTaskKey, type SupervisorTask } from "./supervisor-control";
import { auditLegacyCapacity, type AdmissionCapacityEvidence,
  type LegacyCapacityStop } from "./supervisor-legacy-capacity";
import { r2TurnAdmission, r2SessionId, r2TurnJournalKey, r2TerminalNativeReceipt, type R2TurnJournal } from "./supervisor-r2";
import { scopeStorageKey, type ProjectScope } from "./project-scope";

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
type StartEffect = "github_branch" | "session_create" | "configure" | "submit" | "turn_submit";
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
  storage: DurableObjectStorage, candidate: SupervisorTask, now = Date.now()
): Promise<AdmissionDecision> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("ADMISSION_CLOCK_INVALID");
  const key = supervisorTaskKey(candidate.id);
  return storage.transaction(async tx => {
    const old = await tx.get<SupervisorTask>(key);
    if (old && old.fingerprint !== candidate.fingerprint)
      throw new Error("requestId usado con otra tarea");
    const ledger = decodeLedger(await tx.get<Ledger>(LEDGER_KEY));
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
    const slot = newGrant(candidate.id, 1, now);
    ledger.slots[candidate.id] = slot;
    await tx.put(key, candidate);
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
    const taskKey = supervisorTaskKey(id);
    const task = await tx.get<SupervisorTask>(taskKey);
    if (!task?.session) throw Error("Tarea no disponible");
    const previous = await tx.get<R2TurnJournal>(key);
    if (previous && (previous.hash !== hash || previous.session !== task.session ||
        previous.operationId !== operationId)) throw Error("turnId reutilizado con otra instrucción");
    // Once a native call could have escaped, *any* duplicate HTTP request
    // returns a receipt for reconciliation, never replays the side effect.
    if (previous) return {kind:"existing" as const, task, journal:previous};
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

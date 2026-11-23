import { supervisorTaskKey, type SupervisorTask } from "./supervisor-control";

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
type StartEffect = "github_branch" | "session_create" | "configure" | "submit";
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
  | { kind: "capacity"; reason: "CAPACITY_EXHAUSTED"; retryAfterMs: number };

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
      if (slot.phase !== "effect_unknown" && terminal(task.status)) {
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
      // A pre-effect reservation can be reclaimed only when its TTL expired.
      // The old owner is fenced by token+generation on every external transition.
      const next = newGrant(candidate.id, slot.generation + 1, now);
      ledger.slots[candidate.id] = next;
      await tx.put(LEDGER_KEY, ledger);
      return { kind: "granted", task: old,
        grant: { id: candidate.id, token: next.token, generation: next.generation }, reused: true };
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

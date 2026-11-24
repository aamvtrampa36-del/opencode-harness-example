import { test } from "node:test";
import assert from "node:assert/strict";
import { deferSupervisorStart, canResumeDeferredStart, type AsyncStartPorts, type AsyncStartSnapshot, type DeferredStartOutcome } from "./supervisor-async-start.ts";
import type { AdmissionDecision, StartGrant } from "./supervisor-admission";
import type { SupervisorTask } from "./supervisor-control";

// Port-level fault injection only; this is NOT durable storage or a DO restart test.
const id = "0123456789abcdef";
const task: SupervisorTask = { id, repository: "owner/repo", project: "p", branch: "b",
  fingerprint: "f".repeat(64), createdAt: 1, status: "preparing" };
const grant: StartGrant = { id, token: "00000000-0000-4000-8000-000000000001", generation: 1 };
const granted: AdmissionDecision = { kind: "granted", task, grant, reused: false };
function fixture() {
  let current: AsyncStartSnapshot = { task: { ...task }, slot: { ...grant, phase: "reserved", expiresAt: 100 } };
  let now = 10;
  let calls = 0;
  const pending: Promise<DeferredStartOutcome>[] = [];
  const ports: AsyncStartPorts = { waitUntil: p => { pending.push(p); },
    readCurrent: async () => structuredClone(current), now: () => now,
    withStartLock: async (_id, run) => run(), advance: async () => { calls++; } };
  return { ports, pending, get current() { return current; }, set current(x) { current = x; },
    get calls() { return calls; }, set now(x: number) { now = x; } };
}

test("receipt precedes advance; reused and capacity decisions never schedule", async () => {
  const f = fixture();
  const receipt = deferSupervisorStart(granted, f.ports);
  assert.deepEqual(receipt, { id, accepted: true, confirmed: false, reused: false,
    status: "preparing", backgroundRegistered: true, retryAfterMs: 1000 });
  assert.equal(f.calls, 0);
  assert.equal(deferSupervisorStart({ kind: "reused", task, reason: "LEASE_HELD" }, f.ports), undefined);
  assert.equal(deferSupervisorStart({ kind: "capacity", reason: "CAPACITY_EXHAUSTED", retryAfterMs: 1000 }, f.ports), undefined);
  assert.equal(f.pending.length, 1);
  assert.equal(await f.pending[0], "advance_returned");
  assert.equal(f.calls, 1);
});

test("registration throws even after receiving promise: no advance", async () => {
  const f = fixture();
  f.ports.waitUntil = p => { f.pending.push(p); throw Error("registration lost"); };
  assert.equal(deferSupervisorStart(granted, f.ports)?.backgroundRegistered, false);
  assert.equal(await f.pending[0], "not_registered");
  assert.equal(f.calls, 0);
});

test("exception before effect leaves reservation untouched", async () => {
  const f = fixture();
  const before = structuredClone(f.current);
  f.ports.advance = async () => { throw Error("before intent"); };
  deferSupervisorStart(granted, f.ports);
  assert.equal(await f.pending[0], "interrupted");
  assert.deepEqual(f.current, before);
});

test("exception after intent retains ambiguity and never schedules reused grant", async () => {
  const f = fixture();
  f.ports.advance = async () => {
    f.current.slot = { ...f.current.slot!, phase: "effect_unknown", effect: "session_create" };
    throw Error("response lost");
  };
  deferSupervisorStart(granted, f.ports);
  assert.equal(await f.pending[0], "interrupted");
  assert.equal(f.current.slot?.phase, "effect_unknown");
  f.now = 1000;
  assert.equal(deferSupervisorStart({ kind: "reused", task, reason: "EFFECT_UNCONFIRMED", slot: f.current.slot }, f.ports), undefined);
  assert.equal(canResumeDeferredStart(f.current, grant, task.fingerprint, 1000), false);
});

test("expired or transferred grant cannot advance; newly granted generation can", async () => {
  const f = fixture();
  f.now = 100;
  deferSupervisorStart(granted, f.ports);
  assert.equal(await f.pending[0], "not_current");
  const next = { ...grant, token: "00000000-0000-4000-8000-000000000002", generation: 2 };
  f.current.slot = { ...next, phase: "reserved", expiresAt: 200 };
  deferSupervisorStart(granted, f.ports);
  deferSupervisorStart({ ...granted, grant: next, reused: true }, f.ports);
  assert.equal(await f.pending[1], "not_current");
  assert.equal(await f.pending[2], "advance_returned");
  assert.equal(f.calls, 1);
});

test("cancelled, unknown, pending turn or mismatched identity fails closed", async () => {
  for (const patch of [{ status: "cancel_requested" }, { status: "cancelled" }, { status: "unknown" },
    { cancelAmbiguous: true }, { pendingTurn: {} }, { fingerprint: "other" }, { operationId: "rc-turn-other" }]) {
    const f = fixture();
    f.current.task = { ...task, ...patch } as SupervisorTask;
    deferSupervisorStart(granted, f.ports);
    assert.equal(await f.pending[0], "not_current");
    assert.equal(f.calls, 0);
  }
});

test("late rejection cannot overwrite cancelled or transferred state", async () => {
  const f = fixture();
  f.ports.advance = async () => {
    f.current.task = { ...task, status: "cancelled", revision: 7 };
    f.current.slot = { ...grant, generation: 2, phase: "reserved", expiresAt: 200 };
    throw Error("late response");
  };
  deferSupervisorStart(granted, f.ports);
  assert.equal(await f.pending[0], "interrupted");
  assert.equal(f.current.task?.status, "cancelled");
  assert.equal(f.current.task?.revision, 7);
  assert.equal(f.current.slot?.generation, 2);
});

test("lost acceptance response: repeat is reused; after lease expiry only new grant resumes", async () => {
  const f = fixture();
  f.ports.waitUntil = () => { throw Error("simulated lost registration"); };
  deferSupervisorStart(granted, f.ports);
  assert.equal(deferSupervisorStart({ kind: "reused", task, reason: "LEASE_HELD" }, f.ports), undefined);
  const next = { ...grant, generation: 2, token: "00000000-0000-4000-8000-000000000002" };
  f.now = 101;
  f.current.slot = { ...next, phase: "reserved", expiresAt: 201 };
  f.ports.waitUntil = p => { f.pending.push(p); };
  deferSupervisorStart({ ...granted, grant: next, reused: true }, f.ports);
  assert.equal(await f.pending[0], "advance_returned");
  assert.equal(f.calls, 1);
});

test("failed atomic read, missing record or denied lock never advances", async () => {
  const f = fixture();
  f.ports.readCurrent = async () => { throw Error("storage read failed"); };
  deferSupervisorStart(granted, f.ports);
  assert.equal(await f.pending[0], "interrupted");
  f.ports.readCurrent = async () => ({});
  deferSupervisorStart(granted, f.ports);
  assert.equal(await f.pending[1], "not_current");
  f.ports.withStartLock = async () => ({ retryAfterMs: 1000 });
  deferSupervisorStart(granted, f.ports);
  assert.equal(await f.pending[2], "not_current");
  assert.equal(f.calls, 0);
});

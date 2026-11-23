/** F0-C10/R3-T02. Offline single-JS-process reference model, NOT real SDK/workerd/DO. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const LEVELS = Object.freeze([1, 2, 4, 10]);
export const MODES = Object.freeze(['full-history', 'bounded-tail', 'coordinator-only']);
const SELF = fileURLToPath(import.meta.url);
const mib = n => Math.round(n / 1048576 * 1000) / 1000;
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed; };
const assert = (ok, reason) => { if (!ok) throw Error(reason); };

/** storage/nativeRows are durable *mocks*; maps are shared only for synthetic restart. */
export class LifecycleFixture {
  constructor({ mode = 'bounded-tail', capacity = 10, store = new Map(), nativeRows = new Map() } = {}) {
    assert(MODES.includes(mode) && Number.isInteger(capacity) && capacity >= 1 && capacity <= 10, 'INVALID_OPTIONS');
    this.mode = mode;
    this.capacity = capacity;
    this.store = store;
    this.nativeRows = nativeRows;
    this.slots = new Map([...store].filter(([,v]) => v.slot).map(([id,v]) => [id, v.generation]));
    this.resident = new Map();
    this.counts = { created: 0, duplicateCreates: 0, reconciled: 0, turns: 0, duplicatedTurns: 0, released: 0 };
    this.peakSlots = this.slots.size;
    this.peakResident = 0;
  }
  id(index) { return 'ses_r2_' + String(index).padStart(16, '0'); }
  record(id) { const r = this.store.get(id); assert(r, 'UNKNOWN_TASK'); return r; }
  reserve(id) {
    const old = this.store.get(id);
    if (old) return { kind: 'reused', status: old.status };
    if (this.slots.size >= this.capacity) return { kind: 'capacity' };
    this.store.set(id, { status: 'reserved', generation: 1, slot: true, turns: new Map(), session: id });
    this.slots.set(id, 1);
    this.peakSlots = Math.max(this.peakSlots, this.slots.size);
    return { kind: 'granted' };
  }
  create(id, { loseReceipt = false } = {}) {
    const r = this.record(id);
    assert(r.status === 'reserved' && r.slot, 'BAD_CREATE_STATE');
    // Write intent before native create; an absent receipt is not proof of absence.
    r.status = 'effect_unknown'; r.effect = 'session_create';
    assert(!this.nativeRows.has(id), 'DUPLICATE_CREATE');
    this.nativeRows.set(id, { id, owner: id }); this.counts.created++;
    if (!loseReceipt) { r.status = 'running'; r.effect = undefined; this.#activate(id); }
    return { accepted: !loseReceipt };
  }
  reconcileExact(id) {
    const r = this.record(id);
    if (r.status !== 'effect_unknown' || r.effect !== 'session_create') return { kind: 'not-pending' };
    const exact = this.nativeRows.get(id); // exact ID read, never enumeration or new create
    if (!exact || exact.id !== id || exact.owner !== id) return { kind: 'unknown' };
    const previousGeneration = r.generation;
    r.generation++;
    this.slots.set(id, r.generation);
    r.status = 'running'; r.effect = undefined;
    this.#activate(id); this.counts.reconciled++;
    return { kind: 'recovered', previousGeneration, generation: r.generation };
  }
  staleCommit(id, generation) { return this.record(id).generation === generation; }
  #activate(id) {
    if (this.mode !== 'coordinator-only') this.resident.set(id, { history: [], waiting: true, leased: true });
    this.peakResident = Math.max(this.peakResident, this.resident.size);
  }
  write(id, count = 160, bytes = 1024) {
    const r = this.record(id);
    assert(r.status === 'running', 'NOT_RUNNING');
    assert(Number.isInteger(count) && count >= 0 && count <= 1000 && Number.isInteger(bytes) && bytes >= 32 && bytes <= 4096, 'INVALID_BYTES');
    const cache = this.resident.get(id);
    for (let i = 0; i < count; i++) {
      // Unique event objects approximate message materialization but not SDK shape.
      const payload = { seq: i, data: (id + ':' + i + ':').padEnd(bytes, 'x') };
      if (this.mode === 'full-history') cache.history.push(payload);
      if (this.mode === 'bounded-tail') {
        cache.history.push({ seq: i, bytes: payload.data.length });
        if (cache.history.length > 20) cache.history.shift();
      }
    }
    return cache?.history.length ?? 0;
  }
  finish(id, { cancelled = false } = {}) {
    const r = this.record(id);
    assert(r.status === 'running' && r.slot, 'NOT_RUNNING');
    r.status = cancelled ? 'cancelled' : 'finished';
    r.slot = false; r.effect = undefined;
    this.slots.delete(id);
    this.resident.delete(id); // settlement releases strong references / leases in fixture
    this.counts.released++;
  }
  continueTurn(id, turnId, hash) {
    const r = this.record(id);
    assert(typeof turnId === 'string' && turnId.length && typeof hash === 'string' && hash.length, 'INVALID_TURN');
    const old = r.turns.get(turnId);
    if (old) { assert(old.hash === hash, 'TURN_CONFLICT'); this.counts.duplicatedTurns++; return { kind: 'reused' }; }
    if (r.status !== 'finished' || r.slot) return { kind: 'unavailable' };
    if (this.slots.size >= this.capacity) return { kind: 'capacity' };
    r.generation++; r.slot = true; r.status = 'effect_unknown'; r.effect = 'turn_submit';
    r.turns.set(turnId, { hash, phase: 'intent' });
    this.slots.set(id, r.generation); this.peakSlots = Math.max(this.peakSlots, this.slots.size);
    this.counts.turns++;
    return { kind: 'submit' };
  }
  turnReceipt(id, turnId, { accepted = true } = {}) {
    const r = this.record(id), turn = r.turns.get(turnId);
    assert(turn?.phase === 'intent' && r.status === 'effect_unknown' && r.effect === 'turn_submit', 'INVALID_RECEIPT');
    if (!accepted) return { kind: 'unknown' }; // slot remains held
    turn.phase = 'accepted'; r.status = 'running'; r.effect = undefined;
    this.#activate(id); return { kind: 'running' };
  }
  nativeNotFound(id) {
    const r = this.record(id);
    assert(r.status === 'effect_unknown', 'NOT_UNKNOWN');
    return { kind: 'unknown', slotHeld: r.slot && this.slots.has(id) };
  }
  restart() {
    return new LifecycleFixture({mode: this.mode, capacity: this.capacity,
      store: this.store, nativeRows: this.nativeRows });
  }
  get liveReferences() { return this.resident.size; }
}

export function scenario(sessions, mode) {
  assert(LEVELS.includes(sessions) && MODES.includes(mode), 'INVALID_CASE');
  const t = new LifecycleFixture({ mode }); const baseline = heap();
  for (let i = 0; i < sessions; i++) assert(t.reserve(t.id(i)).kind === 'granted', 'RESERVE_FAILED');
  for (let i = 0; i < sessions; i++) {
    const id = t.id(i), lost = i === sessions - 1;
    t.create(id, { loseReceipt: lost });
    if (lost) { const g = t.record(id).generation; const r = t.reconcileExact(id);
      assert(r.kind === 'recovered' && !t.staleCommit(id, g), 'RECONCILE_FAILED'); }
  }
  for (let i = 0; i < sessions; i++) t.write(t.id(i));
  const active = heap();
  const peakBuffer = [...t.resident.values()].reduce((n, v) => n + v.history.length, 0);
  for (let i = 0; i < sessions; i++) t.finish(t.id(i));
  const firstSettle = heap();
  for (let i = 0; i < sessions; i++) {
    const id = t.id(i), turn = 'turn1';
    assert(t.continueTurn(id, turn, 'hash-synthetic').kind === 'submit', 'CONTINUE_FAILED');
    assert(t.continueTurn(id, turn, 'hash-synthetic').kind === 'reused', 'DEDUP_FAILED');
    assert(t.turnReceipt(id, turn).kind === 'running', 'RECEIPT_FAILED');
    t.write(id, 32, 512);
  }
  const duringContinuation = heap();
  for (let i = 0; i < sessions; i++) t.finish(t.id(i), { cancelled: i === sessions - 1 });
  const released = heap(); const restarted = t.restart();
  assert(t.slots.size === 0 && t.liveReferences === 0 && restarted.liveReferences === 0 && restarted.slots.size === 0, 'LEAKED_REFERENCES');
  const rows = [...restarted.store.values()];
  assert(rows.every(r => !r.slot && r.turns.size === 1) && rows.filter(r => r.status === 'cancelled').length === 1, 'LEDGER_LOST');
  return { sessions, mode, kind: 'node-single-process-reference-model', workerd: false, isolateCount: null,
    nativeCreateCalls: t.counts.created, recovered: t.counts.reconciled,
    continuationSubmits: t.counts.turns, duplicateContinuationReused: t.counts.duplicatedTurns,
    peakSlots: t.peakSlots, peakResidentReferences: t.peakResident, peakBufferedEntries: peakBuffer,
    afterFirstSettlementReferences: 0, afterFinalSettlementReferences: t.liveReferences,
    afterRestartReferences: restarted.liveReferences, afterRestartSlots: restarted.slots.size,
    statusCounts: { cancelled: 1, finished: sessions - 1 },
    heapDeltaMiB: { active: mib(active - baseline), firstSettle: mib(firstSettle - baseline),
      continuation: mib(duringContinuation - baseline), released: mib(released - baseline) } };
}

if (process.argv[1] === SELF) {
  if (process.argv[2] === '--child') console.log(JSON.stringify(scenario(Number(process.argv[3]), process.argv[4])));
  else {
    const cases = [];
    for (const n of LEVELS) for (const mode of MODES) {
      const p = spawnSync(process.execPath, ['--expose-gc', SELF, '--child', String(n), mode],
        {encoding:'utf8', timeout: 15000, maxBuffer: 200000});
      assert(p.status === 0, 'SUBPROCESS_FAILED_' + n + '_' + mode + ':' + p.stderr);
      cases.push(JSON.parse(p.stdout));
    }
    console.log(JSON.stringify({ schema:'opencode.r3-t02.offline.v1', sdkUsed:false, workerdUsed:false,
      fullIsolationClaim:false, cases }, null, 2));
  }
}

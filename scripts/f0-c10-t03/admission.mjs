/** F0-C10/T03. OFFLINE reference model, not wired into the Staging supervisor.
 * Deliberately has no network, billing, DO, session or subprocess effects.
 * A real adapter MUST provide an atomic durable transaction for each mutation.
 */
const REQUEST_ID = /^[a-f0-9]{16}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['finished', 'failed', 'cancelled']);
const OCCUPIED = new Set(['claimed', 'running', 'unknown']);

export class AdmissionLedger {
  constructor({ maxOutstanding = 100, runningCapacity = 10 } = {}) {
    if (!Number.isSafeInteger(maxOutstanding) || maxOutstanding < 10 ||
        !Number.isSafeInteger(runningCapacity) || runningCapacity < 1)
      throw new Error('INVALID_CAPACITY');
    this.maxOutstanding = maxOutstanding;
    this.runningCapacity = runningCapacity;
    this.records = new Map();
    this.nextSequence = 0;
    this.tail = Promise.resolve();
  }
  // Models one Durable Object storage transaction; not a distributed mutex.
  async atomic(fn) {
    let release;
    const next = new Promise(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = next;
    await previous;
    try { return await fn(); } finally { release(); }
  }
  snapshot() { return [...this.records.values()].map(x => ({ ...x })); }
  async admit({ requestId, fingerprint }) {
    if (!REQUEST_ID.test(requestId) || !FINGERPRINT.test(fingerprint)) throw new Error('INVALID_REQUEST');
    return this.atomic(() => {
      const old = this.records.get(requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
        return { ...old, reused: true };
      }
      const outstanding = [...this.records.values()].filter(x => !TERMINAL.has(x.state)).length;
      if (outstanding >= this.maxOutstanding)
        return { requestId, accepted: false, reason: 'BACKPRESSURE', retrySameRequestId: true };
      const row = { requestId, fingerprint, sequence: ++this.nextSequence,
        state: 'queued', operationId: null, lease: null, progress: 0 };
      this.records.set(requestId, row);
      return { ...row, accepted: true, reused: false };
    });
  }
  async claim(limit = this.runningCapacity) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.runningCapacity)
      throw new Error('INVALID_CLAIM_LIMIT');
    return this.atomic(() => {
      const occupied = [...this.records.values()].filter(x => OCCUPIED.has(x.state)).length;
      const free = Math.max(0, Math.min(limit, this.runningCapacity - occupied));
      const chosen = [...this.records.values()].filter(x => x.state === 'queued')
        .sort((a, b) => a.sequence - b.sequence).slice(0, free);
      for (const row of chosen) {
        row.state = 'claimed';
        row.lease = `claim-${row.sequence}`; // Fixture token; production must use a fenced durable generation.
      }
      return chosen.map(x => ({ ...x }));
    });
  }
  async confirmStarted(id, lease, operationId) {
    return this.atomic(() => {
      const x = this.records.get(id);
      if (!x || x.state !== 'claimed' || x.lease !== lease ||
          operationId !== `rc-start-${id}`) throw new Error('START_PROOF_REQUIRED');
      x.operationId = operationId;
      x.state = 'running';
      return { ...x };
    });
  }
  async evidence(id, lease, sequence) {
    return this.atomic(() => {
      const x = this.records.get(id);
      if (!x || x.lease !== lease || x.state !== 'running' ||
          !Number.isSafeInteger(sequence) || sequence <= x.progress)
        throw new Error('INVALID_PROGRESS_EVIDENCE');
      // This ONLY validates a candidate event sequence; real events must come
      // from the OpenCode durable log and be bound to operation/session/executor.
      x.progress = sequence;
      return { ...x };
    });
  }
  async loseResponseOrRestart(id) {
    return this.atomic(() => {
      const x = this.records.get(id);
      if (!x || !OCCUPIED.has(x.state)) throw new Error('NO_PENDING_EFFECT');
      x.state = 'unknown';
      return { ...x };
    });
  }
  async reconcile(id, { operationId, completed = false } = {}) {
    return this.atomic(() => {
      const x = this.records.get(id);
      if (!x || x.state !== 'unknown' || !operationId ||
          operationId !== `rc-start-${id}` || x.operationId !== operationId)
        throw new Error('AUTHORITATIVE_RECEIPT_REQUIRED');
      // A positive durable native receipt may resolve an ambiguous operation;
      // absence/not_found NEVER licenses another submit.
      // Native operation completion is NOT a verified task result.
      x.operationCompleted = Boolean(completed);
      x.state = 'running';
      return { ...x };
    });
  }
  async finish(id, lease, { verified }) {
    return this.atomic(() => {
      const x = this.records.get(id);
      if (!x || x.lease !== lease || x.state !== 'running' ||
          x.progress < 1 || verified !== true) throw new Error('VERIFICATION_REQUIRED');
      x.state = 'finished';
      return { ...x };
    });
  }
  counts() {
    const all = this.snapshot();
    return { admitted: all.length, queued: all.filter(x => x.state === 'queued').length,
      occupied: all.filter(x => OCCUPIED.has(x.state)).length,
      running: all.filter(x => x.state === 'running').length,
      finished: all.filter(x => x.state === 'finished').length,
      withProgress: all.filter(x => x.progress > 0).length };
  }
}

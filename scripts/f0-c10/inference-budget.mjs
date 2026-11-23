/**
 * F0-C10/R2-T07 -- IN-MEMORY REFERENCE CONTRACT; NOT WIRED TO INFERENCE.
 * No scheduler/rate limiter (T03 owns admission). No network, API keys or paid calls.
 * A production implementation MUST replace atomic() and snapshot persistence with
 * one durable transaction and verify the T03 fenced claim at the backend boundary.
 */
const TASK_ID = /^[a-f0-9]{16}$/;
const CALL_ID = /^[a-z0-9][a-z0-9:_-]{0,79}$/;
const MAX_TOKENS = 1_048_576;
const MAX_RATE = 1_000_000_000;
const clone = x => JSON.parse(JSON.stringify(x));
const safeInteger = (n, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;
const keyOf = (requestId, callId) => requestId + '/' + callId;

/**
 * Ceil cost to micro-USD: unknown billing overhead and upstream pricing must
 * be separately covered. This is NOT a guaranteed invoice or account hard cap.
 */
export function worstCaseMicroUsd(inputTokens, outputTokens, price) {
  if (!safeInteger(inputTokens, 1, MAX_TOKENS) || !safeInteger(outputTokens, 1, MAX_TOKENS) ||
      !price || !safeInteger(price.inputMicroUsdPerMillion, 1, MAX_RATE) ||
      !safeInteger(price.outputMicroUsdPerMillion, 1, MAX_RATE)) throw new Error('INVALID_PRICE_ENVELOPE');
  return Math.ceil((inputTokens * price.inputMicroUsdPerMillion +
    outputTokens * price.outputMicroUsdPerMillion) / 1_000_000);
}

export class InferenceBudgetReference {
  constructor({ budgetMicroUsd, taskBudgetMicroUsd, prices, verifyT03Claim, maxAttempts = 2, snapshot } = {}) {
    if (!safeInteger(budgetMicroUsd, 1) || !safeInteger(taskBudgetMicroUsd, 1) ||
        taskBudgetMicroUsd > budgetMicroUsd || !prices || typeof prices !== 'object' ||
        typeof verifyT03Claim !== 'function' || !safeInteger(maxAttempts, 1, 8))
      throw new Error('INVALID_BUDGET_POLICY');
    this.policy = { budgetMicroUsd, taskBudgetMicroUsd, maxAttempts };
    this.prices = clone(prices);
    this.verifyT03Claim = verifyT03Claim;
    this.records = new Map(snapshot?.records ?? []);
    this.tail = Promise.resolve();
  }
  async atomic(fn) {
    let unlock;
    const next = new Promise(resolve => { unlock = resolve; });
    const last = this.tail;
    this.tail = next;
    await last;
    try { return await fn(); } finally { unlock(); }
  }
  async authorize(proof, requestId, operationId) {
    if (!(await this.verifyT03Claim({ proof: proof?.proof, requestId, operationId })))
      throw new Error('T03_CLAIM_REQUIRED');
  }
  record(requestId, callId, attemptId) {
    const row = this.records.get(keyOf(requestId, callId));
    if (!row || row.attemptId !== attemptId) throw new Error('ATTEMPT_NOT_FOUND');
    return row;
  }
  snapshot() { return { records: clone([...this.records]) }; }
  summary() {
    let confirmedMicroUsd = 0, reservedMicroUsd = 0, unknownMicroUsd = 0;
    let completed = 0, attempts = 0;
    const perTask = {};
    for (const x of this.records.values()) {
      attempts += x.attempts;
      let value = 0;
      if (x.state === 'completed') { confirmedMicroUsd += x.chargeMicroUsd; value = x.chargeMicroUsd; completed++; }
      if (x.state === 'reserved' || x.state === 'sent') { reservedMicroUsd += x.reserveMicroUsd; value = x.reserveMicroUsd; }
      if (x.state === 'unknown') { unknownMicroUsd += x.reserveMicroUsd; value = x.reserveMicroUsd; }
      perTask[x.requestId] = (perTask[x.requestId] ?? 0) + value;
    }
    return { confirmedMicroUsd, reservedMicroUsd, unknownMicroUsd,
      exposureMicroUsd: confirmedMicroUsd + reservedMicroUsd + unknownMicroUsd,
      perTask, completed, attempts, logicalCalls: this.records.size };
  }
  async reserve(input, proof) {
    const { requestId, operationId, callId, attemptId, provider, model, inputTokenCap, outputTokenCap } = input;
    if (!TASK_ID.test(requestId) || typeof operationId !== 'string' ||
        !operationId.startsWith('rc-start-' + requestId) && !operationId.startsWith('rc-turn-' + requestId + '-') ||
        !CALL_ID.test(callId) || !CALL_ID.test(attemptId) ||
        typeof provider !== 'string' || typeof model !== 'string') throw new Error('INVALID_IDENTITY');
    const price = this.prices[provider + '|' + model];
    if (!price) throw new Error('MODEL_NOT_AUTHORIZED');
    const reserveMicroUsd = worstCaseMicroUsd(inputTokenCap, outputTokenCap, price);
    const identity = JSON.stringify({ requestId, operationId, callId, provider, model, inputTokenCap, outputTokenCap, priceRevision: price.revision });
    return this.atomic(async () => {
      await this.authorize(proof, requestId, operationId);
      const key = keyOf(requestId, callId), existing = this.records.get(key);
      if ([...this.records.values()].some(x => x.requestId === requestId && (x.provider !== provider || x.model !== model)))
        throw new Error('UNAUTHORIZED_FALLBACK');
      if (existing) {
        if (existing.identity !== identity) throw new Error('FINGERPRINT_CONFLICT');
        if (existing.attemptId === attemptId) return { created: false, state: existing.state, reserveMicroUsd: existing.reserveMicroUsd };
        if (existing.state === 'completed') throw new Error('ALREADY_COMPLETED');
        if (existing.state === 'unknown' || existing.state === 'sent' || existing.state === 'reserved')
          throw new Error('AMBIGUOUS_UPSTREAM_EFFECT');
        if (existing.reason === '402') throw new Error('PAYMENT_BLOCKED');
        if (existing.attempts >= this.policy.maxAttempts) throw new Error('RETRY_LIMIT');
        if (existing.previousAttemptIds.includes(attemptId)) throw new Error('ATTEMPT_REPLAY');
      }
      const current = this.summary(), taskExposure = current.perTask[requestId] ?? 0;
      if (current.exposureMicroUsd + reserveMicroUsd > this.policy.budgetMicroUsd ||
          taskExposure + reserveMicroUsd > this.policy.taskBudgetMicroUsd) throw new Error('BUDGET_EXHAUSTED');
      const row = { requestId, operationId, callId, attemptId, provider, model, identity,
        inputTokenCap, outputTokenCap, reserveMicroUsd, price: clone(price), state: 'reserved',
        attempts: (existing?.attempts ?? 0) + 1, previousAttemptIds: [...(existing?.previousAttemptIds ?? []), attemptId] };
      this.records.set(key, row);
      return { created: true, state: 'reserved', reserveMicroUsd };
    });
  }
  async dispatch(requestId, callId, attemptId, proof) {
    return this.atomic(async () => {
      const x = this.record(requestId, callId, attemptId);
      await this.authorize(proof, requestId, x.operationId);
      if (x.state !== 'reserved') return { proceed: false, state: x.state };
      // Durable implementation commits 'sent' before handing control to SDK.
      // A crash after this write MAY prevent a request; no blind replay.
      x.state = 'sent';
      return { proceed: true, state: x.state };
    });
  }
  async markUnknown(requestId, callId, attemptId, { reason }) {
    return this.atomic(() => {
      const x = this.record(requestId, callId, attemptId);
      if (x.state === 'unknown') return { state: 'unknown', reused: true };
      if (x.state !== 'sent') throw new Error('NOT_DISPATCHED');
      if (typeof reason !== 'string' || !reason) throw new Error('UNKNOWN_REASON_REQUIRED');
      x.state = 'unknown'; x.reason = reason;
      return { state: 'unknown', reused: false };
    });
  }
  async rejectBeforeGeneration(requestId, callId, attemptId, { reason, proof }) {
    return this.atomic(() => {
      const x = this.record(requestId, callId, attemptId);
      if (proof !== 'provider-pre-generation') throw new Error('PROVIDER_PROOF_REQUIRED');
      if (x.state === 'rejected' && x.reason === reason) return { reused: true };
      if (x.state !== 'sent') throw new Error('NOT_DISPATCHED');
      if (!['429', '3040', '402'].includes(reason)) throw new Error('NOT_A_DEFINITE_REJECTION');
      x.state = 'rejected'; x.reason = reason; x.reserveMicroUsd = 0;
      return { reused: false, released: true };
    });
  }
  async settle(requestId, callId, attemptId, { receiptId, usage }) {
    return this.atomic(() => {
      const x = this.record(requestId, callId, attemptId);
      if (!CALL_ID.test(receiptId) || !usage ||
          !safeInteger(usage.inputTokens, 0, MAX_TOKENS) || !safeInteger(usage.outputTokens, 0, MAX_TOKENS))
        throw new Error('INVALID_USAGE_RECEIPT');
      if (x.state === 'completed') {
        if (x.receiptId !== receiptId || x.inputTokens !== usage.inputTokens || x.outputTokens !== usage.outputTokens)
          throw new Error('RECEIPT_CONFLICT');
        return { reused: true, chargeMicroUsd: x.chargeMicroUsd };
      }
      if (!['sent', 'unknown'].includes(x.state)) throw new Error('NOT_DISPATCHED');
      if (usage.inputTokens > x.inputTokenCap || usage.outputTokens > x.outputTokenCap)
        throw new Error('USAGE_EXCEEDS_CAP');
      const price = x.price;
      const chargeMicroUsd = Math.ceil((usage.inputTokens * price.inputMicroUsdPerMillion +
        usage.outputTokens * price.outputMicroUsdPerMillion) / 1_000_000);
      if (chargeMicroUsd > x.reserveMicroUsd) throw new Error('COST_EXCEEDS_RESERVATION');
      x.state = 'completed'; x.chargeMicroUsd = chargeMicroUsd;
      x.receiptId = receiptId; x.inputTokens = usage.inputTokens;
      x.outputTokens = usage.outputTokens;
      return { reused: false, chargeMicroUsd };
    });
  }
}

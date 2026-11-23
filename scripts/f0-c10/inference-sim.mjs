/**
 * F0-C10/T07: entirely offline, deterministic discrete-event inference simulator.
 * No network, credentials, wall-clock waiting, paid models, or Cloudflare resources.
 * NOT a provider-capacity or deployed-backend benchmark.
 */
export const DEFAULT = Object.freeze({
  tasks: 10, turns: 3, rpm: 20, concurrency: 2,
  windowMs: 60_000, maxRetries: 2, maxWaitMs: 120_000,
  budgetUSD: 0.10, reconcileAmbiguous: true,
});
export const DEEPSEEK_USD_PER_M = Object.freeze({ input: 0.30, output: 1.20 });
export const usd = (tokens, rate) => tokens / 1_000_000 * rate;
export const cost = ({ input, output }) => usd(input, DEEPSEEK_USD_PER_M.input) + usd(output, DEEPSEEK_USD_PER_M.output);

function checkConfig(o) {
  for (const key of ['tasks', 'turns', 'rpm', 'concurrency', 'windowMs']) {
    if (!Number.isSafeInteger(o[key]) || o[key] < 1) throw new Error('INVALID_CONFIG:' + key);
  }
  for (const key of ['budgetUSD', 'maxWaitMs']) {
    if (!Number.isFinite(o[key]) || o[key] < 0) throw new Error('INVALID_CONFIG:' + key);
  }
  if (!Number.isSafeInteger(o.maxRetries) || o.maxRetries < 0) throw new Error('INVALID_CONFIG:maxRetries');
}
const logical = (t, step) => t.id + ':turn-' + (step + 1);
const inputTokens = (t, step) => 1200 + t.index * 20 + step * 80;
const outputTokens = (t, step) => 350 + step * 60;
const reserveCost = (t, step) => cost({ input: inputTokens(t, step) + 200, output: 1000 });

/**
 * The fake provider remembers whether a call produced tokens even if the caller
 * did not receive the response. Its readback API is a TEST FIXTURE, NOT a claim
 * about Workers AI or OpenRouter idempotency/retrievability.
 */
export class FakeProvider {
  generated = new Map();
  calls = [];
  constructor({ faults = true } = {}) { this.faults = faults; }
  start({ task, step, attempt, at }) {
    const key = logical(task, step);
    const rules = this.faults ? {
      'task-02:turn-2': { attempt: 1, kind: '429', retryAfterMs: 23_000 },
      'task-05:turn-1': { attempt: 1, kind: 'lost_response' },
      'task-08:turn-2': { attempt: 1, kind: 'timeout_after_generation' },
      'task-07:turn-3': { attempt: 1, kind: '3040', retryAfterMs: 9_000 },
    } : {};
    const rule = rules[key];
    const kind = rule?.attempt === attempt ? rule.kind : 'success';
    const latency = 600 + ((task.index * 7 + step * 11) % 9) * 330;
    const usage = { input: inputTokens(task, step), output: outputTokens(task, step) };
    const result = { key, kind, attempt, at, due: at + latency, retryAfterMs: rule?.retryAfterMs ?? 0, usage };
    this.calls.push({ key, kind, attempt, at });
    if (!['429', '3040'].includes(kind)) {
      if (this.generated.has(key)) throw new Error('DUPLICATE_GENERATION:' + key);
      this.generated.set(key, { usage, chargeUSD: cost(usage), generatedAt: result.due });
    }
    return result;
  }
  // Fake-only readback to exercise recovery after lost responses.
  inspect(key) { return this.generated.get(key) || null; }
}

export function simulate(overrides = {}) {
  const o = { ...DEFAULT, ...overrides };
  checkConfig(o);
  const provider = new FakeProvider({ faults: o.faults !== false });
  const tasks = Array.from({ length: o.tasks }, (_, index) => ({
    index, id: 'task-' + String(index + 1).padStart(2, '0'),
    state: 'active', phase: 'waiting', step: 0, availableAt: 0,
    firstAt: null, endAt: null, attempt: 0, toolCalls: 0, chargesUSD: 0,
  }));
  let now = 0, inFlight = [], attempts = [], maxInFlight = 0,
    maxEffectiveActive = 0, maxQueueDepth = 0, rejected = 0, reconciled = 0,
    unknown = 0, spentUSD = 0, reservedUSD = 0, stoppedByBudget = 0;
  const events = [];
  const log = (task, type, extra = {}) => events.push({ at: now, task: task?.id ?? null, type, ...extra });
  function updatePeaks() {
    maxInFlight = Math.max(maxInFlight, inFlight.length);
    const effective = tasks.filter(t => t.phase === 'tool' && t.availableAt > now ||
      inFlight.some(x => x.task === t)).length;
    maxEffectiveActive = Math.max(maxEffectiveActive, effective);
    const pending = tasks.filter(t => t.state === 'active' && t.phase === 'waiting').length;
    maxQueueDepth = Math.max(maxQueueDepth, pending);
  }
  function finish(call) {
    const t = call.task, r = call.result;
    reservedUSD = Math.max(0, reservedUSD - call.reserved);
    if (['429', '3040'].includes(r.kind)) {
      rejected++;
      if (t.attempt <= o.maxRetries && r.retryAfterMs <= o.maxWaitMs) {
        t.availableAt = now + r.retryAfterMs;
        t.phase = 'waiting';
        log(t, 'retry_scheduled_after_definite_rejection', { kind: r.kind, attempt: t.attempt, retryAt: t.availableAt });
      } else {
        t.state = 'failed'; t.phase = 'failed'; t.endAt = now;
        log(t, 'retry_limit', { kind: r.kind });
      }
      return;
    }
    const recorded = provider.inspect(r.key);
    const ambiguous = r.kind !== 'success';
    if (ambiguous && !o.reconcileAmbiguous) {
      // The charge may have happened. Do not resubmit; mark liability unknown.
      spentUSD += recorded.chargeUSD;
      t.chargesUSD += recorded.chargeUSD;
      t.state = 'unknown'; t.phase = 'unknown'; t.endAt = now; unknown++;
      log(t, 'ambiguous_held_no_retry', { reason: r.kind, logicalId: r.key });
      return;
    }
    if (ambiguous) {
      if (!recorded) throw new Error('FAKE_READBACK_INCONSISTENT');
      reconciled++;
      log(t, 'fake_readback_reconciled', { reason: r.kind, logicalId: r.key });
    }
    spentUSD += recorded.chargeUSD;
    t.chargesUSD += recorded.chargeUSD;
    t.step++;
    t.attempt = 0;
    if (t.step === o.turns) {
      t.state = 'done'; t.phase = 'done'; t.endAt = now;
      log(t, 'done');
    } else {
      t.phase = 'tool'; t.toolCalls++;
      t.availableAt = now + 12_000 + (t.index * 13 % 7) * 900;
      log(t, 'tool_simulated', { availableAt: t.availableAt });
    }
  }
  let guard = 0;
  while (tasks.some(t => t.state === 'active') || inFlight.length) {
    if (++guard > 100_000) throw new Error('SIMULATION_STALLED');
    // Finish all responses due at this instant, before handing out more permits.
    for (const call of inFlight.filter(c => c.result.due <= now)) finish(call);
    inFlight = inFlight.filter(c => c.result.due > now);
    for (const t of tasks) if (t.state === 'active' && t.phase === 'tool' && t.availableAt <= now) t.phase = 'waiting';
    attempts = attempts.filter(at => at > now - o.windowMs);
    updatePeaks();
    while (inFlight.length < o.concurrency && attempts.length < o.rpm) {
      const ready = tasks.filter(t => t.state === 'active' && t.phase === 'waiting' && t.availableAt <= now)
        .sort((a, b) => a.availableAt - b.availableAt || a.index - b.index);
      if (!ready.length) break;
      const t = ready[0];
      const required = reserveCost(t, t.step);
      // This is a conservative synthetic reservation, not a provider-side hard spending cap.
      if (spentUSD + reservedUSD + required > o.budgetUSD + 1e-12) {
        t.state = 'budget_blocked'; t.phase = 'budget_blocked'; t.endAt = now;
        stoppedByBudget++; log(t, 'budget_blocked');
        continue;
      }
      reservedUSD += required;
      t.attempt++;
      const r = provider.start({ task: t, step: t.step, attempt: t.attempt, at: now });
      t.phase = 'inference';
      if (t.firstAt === null) t.firstAt = now;
      attempts.push(now);
      inFlight.push({ task: t, result: r, reserved: required });
      log(t, 'inference_started', { logicalId: r.key, kind: r.kind, attempt: t.attempt });
      updatePeaks();
    }
    if (!tasks.some(t => t.state === 'active') && !inFlight.length) break;
    let candidates = [
      ...inFlight.map(c => c.result.due),
      ...tasks.filter(t => t.state === 'active' && t.phase !== 'inference' && t.availableAt > now).map(t => t.availableAt),
    ];
    if (tasks.some(t => t.state === 'active' && t.phase === 'waiting' && t.availableAt <= now) && attempts.length >= o.rpm)
      candidates.push(attempts[0] + o.windowMs + 1);
    candidates = candidates.filter(t => t > now);
    if (!candidates.length) throw new Error('SIMULATION_NO_FUTURE_EVENT');
    now = Math.min(...candidates);
  }
  const counts = Object.fromEntries([...new Set(tasks.map(t => t.state))].map(s => [s, tasks.filter(t => t.state === s).length]));
  return {
    config: o, durationMs: now, counts, taskCount: tasks.length, tasks, events,
    calls: provider.calls, generated: [...provider.generated.keys()],
    stats: { maxInFlight, maxEffectiveActive, maxQueueDepth, rejected, reconciled,
      unknown, stoppedByBudget, requests: provider.calls.length, actualFakeChargesUSD: spentUSD,
      unspentReservationsUSD: reservedUSD, toolActionsSimulated: tasks.reduce((n, t) => n + t.toolCalls, 0) }
  };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const result = simulate();
  console.log(JSON.stringify({ config: result.config, durationMs: result.durationMs,
    counts: result.counts, stats: result.stats, requestsByMinute: Object.entries(result.calls.reduce((m, c) => {
      const bucket = Math.floor(c.at / 60_000); m[bucket] = (m[bucket] ?? 0) + 1; return m;
    }, {})) }, null, 2));
}

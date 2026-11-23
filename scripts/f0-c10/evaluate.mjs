import { TASKS, verifyArtifact } from './tasks.mjs';

// Preset registered BEFORE live sampling. Monetary cap is intentionally unset: no live run
// is eligible until a measured provider-side spend stop and a run-specific cap are proven.
export const LIVE_LIMITS = Object.freeze({
  minRounds: 3,
  minOverlapMs: 1000,
  maxPeakIsolateMiB: 102.4, // 80% of Cloudflare's 128 MiB isolate ceiling
  maxStartP95Ms: 10000,
  maxStatusP95Ms: 5000,
  maxTaskDurationMs: 180000,
  maxRetriesPerTask: 1,
  maxOom: 0,
  maxOrphans: 0,
  maxUnexpectedFailures: 0,
  maxResponseBytes: 8192,
  maxCostUsd: null,
});
export const OFFLINE_LIMITS = Object.freeze({ ...LIVE_LIMITS, minOverlapMs: 50 });

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

// Sweep all genuine tool/inference intervals. A batch of HTTP starts, busy flags,
// queued sessions, or task records is never counted as activity.
export function measureOverlap(intervals, size) {
  const boundaries = intervals.flatMap(({ start, end, requestId }) => [
    { t: start, delta: 1, requestId }, { t: end, delta: -1, requestId },
  ]).sort((a, b) => a.t - b.t || a.delta - b.delta);
  const active = new Map();
  let before = null, maxActive = 0, longestFullMs = 0, fullStart = null, segmentStart = null;
  for (const b of boundaries) {
    if (before !== null && b.t > before) {
      const count = active.size;
      maxActive = Math.max(maxActive, count);
      if (count === size) {
        if (segmentStart === null) segmentStart = before;
        const elapsed = b.t - segmentStart;
        if (elapsed > longestFullMs) { longestFullMs = elapsed; fullStart = segmentStart; }
      } else segmentStart = null;
    }
    const n = (active.get(b.requestId) || 0) + b.delta;
    if (n <= 0) active.delete(b.requestId); else active.set(b.requestId, n);
    before = b.t;
  }
  return { maxActive, longestFullMs, fullStart };
}

export function evaluateTrace(trace, { mode = 'offline', limits = mode === 'live' ? LIVE_LIMITS : OFFLINE_LIMITS } = {}) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  if (!trace || !Array.isArray(trace.events) || !Array.isArray(trace.tasks)) {
    return { pass: false, failures: [{ code: 'INVALID_TRACE', detail: 'missing tasks/events' }] };
  }
  const { tasks, events } = trace;
  const size = tasks.length;
  if (![1, 2, 4, 10].includes(size)) fail('INVALID_SIZE', size);
  if (trace.mode !== mode) fail('MODE_MISMATCH', { expected: mode, actual: trace.mode });
  if (tasks.some((t, i) => !TASKS[i] || t.kind !== TASKS[i].kind)) fail('TASK_MATRIX', 'wrong task order/kinds');
  const ids = new Set(), sessions = new Set(), operations = new Set(), projects = new Set(), executors = new Set();
  const intervals = [], starts = [], durations = [], statusLatencies = [], seenEvents = new Set();
  let maxIsolateMiB = null, orphans = 0, bytes = 0;
  const oom = events.filter((e) => e.type === 'oom').length;
  const unexpectedFailures = events.filter((e) => e.type === 'failed' || e.type === 'cancelled').length;
  for (const task of tasks) {
    const identity = [task.requestId, task.sessionId, task.operationId, task.projectId, task.executorId];
    if (!/^[a-f0-9]{16}$/.test(task.requestId || '')) fail('INVALID_REQUEST_ID', task.requestId);
    for (const [set, val, label] of [[ids, task.requestId, 'REQUEST_ID'], [sessions, task.sessionId, 'SESSION_ID'], [operations, task.operationId, 'OPERATION_ID'], [projects, task.projectId, 'PROJECT_ID'], [executors, task.executorId, 'EXECUTOR_ID']]) {
      if (typeof val !== 'string' || !val.length || set.has(val)) fail('DUPLICATE_OR_MISSING_' + label, val);
      set.add(val);
    }
    if (identity.some((x) => typeof x !== 'string' || !x.length)) continue;
    const stream = events.filter((e) => e.requestId === task.requestId).sort((a, b) => a.seq - b.seq);
    const types = stream.map((e) => e.type);
    for (const required of ['received', 'admitted', 'persisted', 'execution_start', 'output', 'completed']) {
      if (types.filter((t) => t === required).length !== 1) fail('MISSING_OR_DUPLICATE_' + required.toUpperCase(), task.requestId);
    }
    const requiredOrder = ['received', 'admitted', 'persisted', 'execution_start', 'output', 'completed'];
    if (requiredOrder.some((t, i) => i > 0 && types.indexOf(t) <= types.indexOf(requiredOrder[i - 1]))) fail('INVALID_STATE_ORDER', task.requestId);
    const first = stream.find((e) => e.type === 'received');
    const admitted = stream.find((e) => e.type === 'admitted');
    const start = stream.find((e) => e.type === 'execution_start');
    const done = stream.find((e) => e.type === 'completed');
    if (!first || !admitted || !start || !done) { orphans++; continue; }
    if (done.verified !== true) fail('UNVERIFIED_COMPLETION', task.requestId);
    starts.push(admitted.atMs - first.atMs);
    durations.push(done.atMs - first.atMs);
    if (done.atMs - first.atMs > limits.maxTaskDurationMs) fail('DURATION_LIMIT', task.requestId);
    if (stream.filter((e) => e.type === 'retry').length > limits.maxRetriesPerTask) fail('RETRY_LIMIT', task.requestId);
    const output = stream.find((e) => e.type === 'output');
    if (!output || output.projectId !== task.projectId || !output.artifact || output.artifact.projectId !== task.projectId || output.artifact.path !== 'tmp/f0-c10/' + task.requestId + '/' + task.kind + '.json') {
      fail('OUTPUT_ISOLATION', task.requestId);
    } else {
      bytes += Buffer.byteLength(output.artifact.content || '', 'utf8');
      if (!verifyArtifact(task, output.artifact)) fail('FALSE_PASS_OUTPUT', task.requestId);
    }
    // Self-reported output is not evidence that the artifact is retrievable.
    // A separate collector read must supply the actual bytes; compare exact UTF-8
    // content, location, checksum and independent task oracle.
    const readbacks = stream.filter((e) => e.type === 'artifact_readback');
    if (readbacks.length !== 1) {
      fail('ARTIFACT_READBACK_MISSING', task.requestId);
    } else {
      const readback = readbacks[0];
      const original = output?.artifact;
      const artifact = readback.artifact;
      const expectedSource = mode === 'live' ? 'artifact-collector' : 'mock';
      const expectedRetrieval = mode === 'live' ? 'authenticated-byte-read' : 'local-fixture-read';
      if (readback.source !== expectedSource ||
          readback.retrieval !== expectedRetrieval ||
          !original || !artifact ||
          readback.seq <= output.seq || readback.seq >= done.seq ||
          artifact.path !== original.path ||
          artifact.projectId !== task.projectId ||
          artifact.content !== original.content ||
          artifact.sha256 !== original.sha256 ||
          !verifyArtifact(task, artifact)) {
        fail('ARTIFACT_READBACK_MISMATCH', task.requestId);
      }
    }
    // TDD receipt proves the RED test actually failed and GREEN actually passed.
    if (task.kind === 'tdd') {
      const tests = stream.filter((e) => e.type === 'test_result');
      if (tests.length !== 2 || tests[0].phase !== 'red' || tests[0].exitCode !== 1 || tests[1].phase !== 'green' || tests[1].exitCode !== 0) fail('TDD_RECEIPT_MISSING', task.requestId);
    }
    const open = new Map();
    for (const e of stream) {
      if (e.type === 'tool_start' || e.type === 'inference_start') open.set(e.type + ':' + e.callId, e);
      if (e.type === 'tool_end' || e.type === 'inference_end') {
        const startType = e.type === 'tool_end' ? 'tool_start' : 'inference_start';
        const item = open.get(startType + ':' + e.callId);
        if (!item || e.atMs <= item.atMs || item.atMs < start.atMs || e.atMs > done.atMs) fail('INVALID_ACTIVITY_INTERVAL', task.requestId);
        else if (item.source === (mode === 'live' ? 'runtime' : 'mock') && e.source === item.source && e.toolName === item.toolName && e.exitCode === 0) intervals.push({ requestId: task.requestId, start: item.atMs, end: e.atMs });
        else fail('UNTRUSTED_ACTIVITY', task.requestId);
        open.delete(startType + ':' + e.callId);
      }
    }
    if (open.size) fail('OPEN_ACTIVITY', task.requestId);
    if (!intervals.some((i) => i.requestId === task.requestId)) fail('NO_EXECUTION_EVIDENCE', task.requestId);
    const probes = stream.filter((e) => e.type === 'status_probe');
    if (!probes.some((e) => e.underLoad && e.status === 'ok' && intervals.some((i) => i.requestId === task.requestId && i.start <= e.atMs && e.atMs <= i.end))) fail('NO_UNDER_LOAD_STATUS_READ', task.requestId);
    for (const probe of probes) {
      if (probe.status === 'not_found' || probe.status === 'unknown') { fail('ORPHAN_OPERATION', task.requestId); orphans++; }
      if (typeof probe.latencyMs === 'number') statusLatencies.push(probe.latencyMs);
    }
    for (const e of stream) {
      if (!Number.isFinite(e.seq) || !Number.isFinite(e.atMs)) fail('INVALID_EVENT_CLOCK', task.requestId);
      if (e.sessionId !== task.sessionId || e.operationId !== task.operationId || e.projectId !== task.projectId || e.executorId !== task.executorId) fail('CROSS_SESSION_EVENT', task.requestId);
      if (mode === 'live' && (e.type === 'artifact_readback' ? e.source !== 'artifact-collector' : (e.source !== 'runtime' && e.source !== 'telemetry'))) fail('UNTRUSTED_LIVE_EVENT', task.requestId);
      const eventKey = task.requestId + ':' + e.seq;
      if (seenEvents.has(eventKey)) fail('DUPLICATE_EVENT_SEQUENCE', eventKey);
      seenEvents.add(eventKey);
    }
    for (let i = 1; i < stream.length; i++) {
      if (stream[i].seq <= stream[i - 1].seq || stream[i].atMs < stream[i - 1].atMs) fail('NON_MONOTONIC_STREAM', task.requestId);
    }
  }
  if (events.some((e) => !ids.has(e.requestId))) fail('UNKNOWN_REQUEST_EVENTS', 'event without declared task');
  const overlap = measureOverlap(intervals, size);
  if (overlap.maxActive !== size || overlap.longestFullMs < limits.minOverlapMs) fail('INSUFFICIENT_REAL_OVERLAP', overlap);
  if (oom > limits.maxOom) fail('OOM', oom);
  if (orphans > limits.maxOrphans) fail('ORPHANS', orphans);
  if (unexpectedFailures > limits.maxUnexpectedFailures) fail('UNEXPECTED_FAILURES', unexpectedFailures);
  const p95StartMs = percentile(starts, 95), p95StatusMs = percentile(statusLatencies, 95);
  if (p95StartMs !== null && p95StartMs > limits.maxStartP95Ms) fail('START_P95', p95StartMs);
  if (p95StatusMs === null || p95StatusMs > limits.maxStatusP95Ms) fail('STATUS_P95', p95StatusMs);
  if (mode === 'live') {
    for (const field of ['workerVersion', 'mcpVersion', 'sourceSha', 'gitBaseSha', 'environment', 'leaseId', 'clockSyncMaxSkewMs']) {
      if (!trace.metadata?.[field]) fail('MISSING_LIVE_PROVENANCE', field);
    }
    if ((trace.metadata?.clockSyncMaxSkewMs ?? Infinity) > 250) fail('CLOCK_SKEW', trace.metadata?.clockSyncMaxSkewMs);
    // Cloudflare samples belong to an isolate, never to an individual task.
    // Do not accept a self-declared memory field from an OpenCode task event.
    const samples = Array.isArray(trace.telemetry) ? trace.telemetry : [];
    const validSamples = samples.filter((s) => s.source === 'cloudflare' && s.service === 'opencode-g1-staging' && s.workerVersion === trace.metadata?.workerVersion && Number.isFinite(s.atMs) && Number.isFinite(s.isolateMiB) && s.isolateMiB >= 0);
    for (const s of validSamples) maxIsolateMiB = Math.max(maxIsolateMiB ?? 0, s.isolateMiB);
    if (!validSamples.some((s) => s.atMs >= overlap.fullStart && s.atMs <= overlap.fullStart + overlap.longestFullMs)) fail('MISSING_MEMORY_TELEMETRY', 'Cloudflare isolate sample required during ten-way overlap');
    if (maxIsolateMiB !== null && maxIsolateMiB > limits.maxPeakIsolateMiB) fail('MEMORY_HEADROOM', maxIsolateMiB);
    if (!(typeof limits.maxCostUsd === 'number' && limits.maxCostUsd > 0 && trace.metadata?.spendStopVerified === true)) fail('NO_EFFECTIVE_SPEND_CAP', 'live run forbidden without provider-enforced stop');
    if (!Number.isFinite(trace.metadata?.measuredTotalUsd)) fail('MISSING_COST', 'must include observed provider/container/CI costs');
    else if (trace.metadata.measuredTotalUsd > limits.maxCostUsd) fail('COST_LIMIT', trace.metadata.measuredTotalUsd);
    if (!trace.metadata?.observabilityQueryId) fail('MISSING_CLOUDFLARE_QUERY', 'independent query receipt required');
    if (trace.metadata?.sourceClock !== 'server') fail('CLOCK_UNTRUSTED', trace.metadata?.sourceClock);
    if (trace.metadata?.evidenceOrigin !== 'independent_runtime') fail('PROVENANCE_UNTRUSTED', trace.metadata?.evidenceOrigin);
    if (!trace.metadata?.exclusiveLeaseAtomicVerified) fail('LEASE_UNVERIFIED', 'atomic lease + fencing token required');
  }
  return {
    pass: failures.length === 0, size, failures, metrics: {
      ...overlap, p95StartMs, p95StatusMs,
      p95DurationMs: percentile(durations, 95), peakIsolateMiB: maxIsolateMiB,
      oom, orphans, unexpectedFailures, bytes, observedActivityIntervals: intervals.length,
      source: mode,
    },
  };
}

export function evaluateCampaign(rounds, limits = LIVE_LIMITS) {
  if (!Array.isArray(rounds) || rounds.length < limits.minRounds) return { pass: false, code: 'TOO_FEW_ROUNDS' };
  const ids = new Set();
  const reports = rounds.map((trace) => evaluateTrace(trace, { mode: 'live', limits }));
  for (const trace of rounds) {
    if (trace.tasks?.length !== 10) return { pass: false, code: 'NOT_TEN_TASKS', reports };
    if (!trace.metadata?.experimentId || ids.has(trace.metadata.experimentId)) return { pass: false, code: 'DUPLICATE_EXPERIMENT', reports };
    ids.add(trace.metadata.experimentId);
  }
  return { pass: reports.every((r) => r.pass), reports };
}

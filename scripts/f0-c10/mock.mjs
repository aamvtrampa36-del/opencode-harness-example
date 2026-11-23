import { TASKS, canonicalOutput, sha256 } from './tasks.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Intentionally NOT a real OpenCode executor; exercise only the independent observer.
export async function runMock({ size = 10, fault = null } = {}) {
  if (![1, 2, 4, 10].includes(size)) throw new Error('size must be 1, 2, 4 or 10');
  const experimentId = 'offline-' + size + '-' + (fault || 'green');
  const sourceSha = 'f'.repeat(40);
  const tasks = TASKS.slice(0, size).map((task) => {
    const requestId = (0xf0c1000000000000n + BigInt(task.slot)).toString(16);
    return { kind: task.kind, name: task.name, prompt: task.payload, requestId,
      experimentId, sourceSha,
      sessionId: 'ses_mock_' + requestId, operationId: 'op_mock_' + requestId,
      projectId: 'synthetic-' + requestId, executorId: 'mock-' + requestId };
  });
  const events = [];
  function emitter(task) {
    let seq = 0;
    return (type, more = {}) => events.push({ type, seq: ++seq, atMs: Date.now(),
      experimentId, sourceSha, requestId: task.requestId, sessionId: task.sessionId, operationId: task.operationId,
      projectId: task.projectId, executorId: task.executorId, source: 'mock', ...more });
  }
  await Promise.all(tasks.map(async (task, index) => {
    const emit = emitter(task);
    emit('received');
    await sleep(2);
    emit('admitted');
    await sleep(2);
    if (!(fault === 'partial' && index === 0)) emit('persisted');
    emit('queued');
    await sleep(2);
    emit('execution_start');
    await sleep(35);
    if (fault === 'queued-only' && index >= 4) {
      emit('status_probe', { underLoad: true, status: 'ok', latencyMs: 3 });
      await sleep(120);
    } else {
      emit('tool_start', { callId: 'shell-' + index, toolName: 'sandbox.shell' });
      if (task.kind === 'tdd') emit('test_result', { phase: 'red', exitCode: 1 });
      await sleep(55);
      emit('status_probe', { underLoad: true, status: (fault === 'orphan' && index === 0) || (fault === 'historical-red' && index < 2) ? 'not_found' : 'ok', latencyMs: 3 });
      if (fault === 'restart-recovered' && index === 0) {
        emit('restart', { reason: 'simulated_isolate_replacement', sameRequestId: true });
        emit('reconciled', { state: 'running', sameSessionId: true, sameOperationId: true });
      }
      await sleep(75);
      if (task.kind === 'tdd') emit('test_result', { phase: 'green', exitCode: 0 });
      emit('tool_end', { callId: 'shell-' + index, toolName: 'sandbox.shell', exitCode: 0 });
    }
    if ((fault === 'oom' && index === 0) || (fault === 'historical-red' && index < 6)) emit('oom', { code: 'exceededMemory' });
    if ((fault === 'cancelled' && index === 0) || (fault === 'historical-red' && index >= 6)) emit('cancelled', { reason: 'operator_cancelled' });
    if (fault === 'retry' && index === 0) emit('retry', { reason: '429', attempt: 1, sameRequestId: true });
    const content = fault === 'false-pass' && index === 0 ? JSON.stringify({ corrupted: true }) : canonicalOutput(task.kind);
    if (!(fault === 'historical-red' && index >= 6)) emit('output', { artifact: { kind: task.kind, content, sha256: sha256(content),
      projectId: fault === 'cross-project' && index === 0 ? tasks[Math.min(1, size - 1)].projectId + '-foreign' : task.projectId,
      path: 'tmp/f0-c10/' + task.requestId + '/' + task.kind + '.json' } });
    // Independent retrieval is simulated separately from the producer's output claim.
    // In live mode the collector MUST actually fetch bytes through an authenticated path.
    if (!(fault === 'historical-red' && index >= 6) &&
        !(fault === 'missing-readback' && index === 0)) {
      const bytes = fault === 'corrupt-readback' && index === 0 ? '{"tampered":true}' : content;
      emit('artifact_readback', { retrieval: 'local-fixture-read',
        artifact: { kind: task.kind, content: bytes, sha256: sha256(bytes),
          projectId: task.projectId, path: 'tmp/f0-c10/' + task.requestId + '/' + task.kind + '.json' } });
    }
    if (!(fault === 'historical-red' && index >= 6)) emit('completed', { verified: true });
  }));
  // Preserve per-stream sequence order; cross-stream order is by collection timestamp.
  if (fault === 'duplicate-request' && tasks.length > 1) tasks[1].requestId = tasks[0].requestId;
  if (fault === 'client-only') for (const e of events) if (e.type === 'tool_start') e.source = 'client';
  return { mode: 'offline', metadata: { experimentId, sourceSha, simulated: true }, tasks, events };
}

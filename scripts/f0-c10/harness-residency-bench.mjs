/**
 * F0-C10/R2-T02 synthetic strong-reference residency microbenchmark.
 * Node only, not real OpenCode SDK / Cloudflare isolate / tool concurrency.
 * node --test scripts/f0-c10/harness-residency-bench.test.mjs
 * node --expose-gc scripts/f0-c10/harness-residency-bench.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export const LEVELS = Object.freeze([1, 2, 4, 10]);
export const MODES = Object.freeze(['full-history', 'bounded-tail', 'coordinator-only']);
const FILE = fileURLToPath(import.meta.url);
const mib = n => Math.round(n / 1048576 * 100) / 100;
const measure = () => { global.gc?.(); return process.memoryUsage().heapUsed; };

export function simulate({ sessions, mode, messagesPerSession = 160, bytesPerMessage = 2048, cancelIndex = -1 }) {
  if (!LEVELS.includes(sessions) || !MODES.includes(mode) ||
      !Number.isInteger(messagesPerSession) || messagesPerSession < 1 || messagesPerSession > 3000 ||
      !Number.isInteger(bytesPerMessage) || bytesPerMessage < 32 || bytesPerMessage > 8192 ||
      !Number.isInteger(cancelIndex) || cancelIndex < -1 || cancelIndex >= sessions) throw new Error('INVALID_FIXTURE');
  const ledger = new Map();
  const host = { sessionCache: new Map(), waits: new Map(), admitting: new Map(), leases: 0 };
  const payload = 'x'.repeat(bytesPerMessage - 30);
  for (let s = 0; s < sessions; s++) {
    const id = 'ses-synthetic-' + s;
    host.sessionCache.set(id, { recent: [], bytes: 0, eventCount: 0 });
    host.admitting.set(id, true);
    host.waits.set(id, Promise.resolve());
    ledger.set(id, { status: 'running', lastSeq: -1 });
  }
  const started = performance.now();
  // Round-robin quanta approximate load overlaps; no actual inference or tools.
  for (let seq = 0; seq < messagesPerSession; seq++) for (let s = 0; s < sessions; s++) {
    const id = 'ses-synthetic-' + s;
    const state = host.sessionCache.get(id);
    const serialized = JSON.stringify({ session: id, seq, text: s + ':' + seq + ':' + payload });
    state.bytes += Buffer.byteLength(serialized);
    state.eventCount++;
    if (mode === 'full-history') state.recent.push(serialized);
    if (mode === 'bounded-tail') {
      state.recent.push(serialized.slice(0, 40));
      if (state.recent.length > 20) state.recent.shift();
    }
    ledger.get(id).lastSeq = seq;
  }
  const active = measure();
  const buffered = [...host.sessionCache.values()].reduce((a, x) => a + x.recent.length, 0);
  for (let s = 0; s < sessions; s++) {
    const id = 'ses-synthetic-' + s;
    ledger.get(id).status = s === cancelIndex ? 'cancelled' : 'finished';
    host.waits.delete(id);
    host.admitting.delete(id);
  }
  const settled = measure();
  const ledgerBeforeRestart = JSON.stringify([...ledger]);
  // Simulated idle close. Persistent ledger is a local Map, NOT SQLite.
  host.sessionCache.clear();
  const afterIdleClose = measure();
  if (ledgerBeforeRestart !== JSON.stringify([...ledger])) throw new Error('LEDGER_CHANGED');
  return { sessions, mode, messagesPerSession, bytesPerMessage,
    generated: sessions * messagesPerSession, bufferedBeforeIdleClose: buffered,
    expectedBufferCap: mode === 'full-history' ? sessions * messagesPerSession :
      mode === 'bounded-tail' ? sessions * Math.min(messagesPerSession, 20) : 0,
    settledStatuses: [...ledger.values()].map(v => v.status), activeBytes: active,
    settledBytes: settled, afterIdleCloseBytes: afterIdleClose,
    elapsedMs: Math.round(performance.now() - started), ledgerIntegrity: true };
}
function oneCase(sessions, mode) {
  const baseline = measure();
  const result = simulate({ sessions, mode, cancelIndex: sessions - 1 });
  return { ...result, baselineHeapMiB: mib(baseline),
    activeHeapDeltaMiB: mib(result.activeBytes - baseline),
    settledHeapDeltaMiB: mib(result.settledBytes - baseline),
    afterIdleCloseHeapDeltaMiB: mib(result.afterIdleCloseBytes - baseline),
    node: process.version, runtime: 'node-synthetic', dataNotEquivalentToWorkerd: true };
}
if (process.argv[1] === FILE) {
  if (process.argv[2] === '--child') {
    console.log(JSON.stringify(oneCase(Number(process.argv[3]), process.argv[4])));
  } else {
    const results = [];
    for (const sessions of LEVELS) for (const mode of MODES) {
      const subprocess = spawnSync(process.execPath, ['--expose-gc', FILE, '--child', String(sessions), mode],
        { encoding: 'utf8', timeout: 15000, maxBuffer: 512000 });
      if (subprocess.status !== 0) throw new Error('CASE_FAILED ' + sessions + '/' + mode + ': ' + subprocess.stderr);
      results.push(JSON.parse(subprocess.stdout));
    }
    console.log(JSON.stringify({ schema: 'opencode.f0-c10.r2.synthetic-memory.v1',
      note: 'Synthetic Node strong-reference model; not workerd, OpenCode, nor actual agent concurrency', results }, null, 2));
  }
}

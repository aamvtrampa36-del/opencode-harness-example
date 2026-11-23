/** F0-C10/T02: synthetic, offline memory-retention demonstration.
 * NOT a Cloudflare Durable Object or real OpenCode SDK load benchmark.
 * Usage: node --expose-gc scripts/f0-c10/memory-retention-prototype.mjs
 */
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export function* events(sessions = 10, each = 1200, bytes = 4096) {
  if (![sessions, each, bytes].every(n => Number.isSafeInteger(n) && n > 0) ||
      sessions > 100 || each > 10000 || bytes > 65536) throw Error('LIMIT');
  for (let s = 0; s < sessions; s++) {
    for (let n = 0; n < each; n++) {
      const id = String(s) + ':' + String(n);
      const filler = String(s).padStart(2, '0') + String(n).padStart(6, '0');
      yield { session: s, seq: n, id, body: (filler + 'x'.repeat(Math.max(1, bytes - filler.length))).slice(0, bytes) };
    }
  }
}

export function fullHistory(source, tail = 20) {
  const all = [];
  for (const event of source) all.push(event);
  const transcript = all.map(event => JSON.stringify(event)).join('\n');
  const recent = all.slice(-tail).map(({id}) => id);
  return { recent, count: all.length, bytes: Buffer.byteLength(transcript) };
}

export function boundedHistory(source, tail = 20) {
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > 256) throw Error('TAIL_LIMIT');
  const ring = new Array(tail);
  let count = 0, bytes = 0;
  for (const event of source) {
    ring[count % tail] = event.id;
    bytes += Buffer.byteLength(JSON.stringify(event));
    count++;
  }
  const recent = Array.from({length: Math.min(count, tail)}, (_, i) =>
    ring[(count - Math.min(count, tail) + i) % tail]);
  return { recent, count, bytes };
}

function measure(label, fn) {
  global.gc?.();
  const start = process.memoryUsage().heapUsed;
  const t = performance.now();
  const value = fn();
  const held = process.memoryUsage().heapUsed;
  return { strategy: label, count: value.count, bytesProcessed: value.bytes,
    milliseconds: Math.round(performance.now() - t),
    heapIncreaseMiB: Math.round((held - start) / 1048576 * 100) / 100,
    lastId: value.recent.at(-1), result: value };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = [10, 1200, 4096];
  const a = measure('full-history', () => fullHistory(events(...args)));
  const b = measure('bounded-cursor-simulation', () => boundedHistory(events(...args)));
  if (JSON.stringify(a.result.recent) !== JSON.stringify(b.result.recent)) throw Error('TAIL_MISMATCH');
  console.log(JSON.stringify({environment: {node:process.version,synthetic:true,
    sessions:args[0],eventsPerSession:args[1],payloadBytes:args[2]},
    results: [a,b].map(({result,...rest})=>rest), equivalentTail:true},null,2));
}

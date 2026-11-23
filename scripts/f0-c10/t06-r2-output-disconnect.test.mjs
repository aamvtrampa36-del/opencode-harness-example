#!/usr/bin/env node
// Offline-only RED/GREEN regression of the actual DevContainer Linux runner source.
// No Staging, shared Containers, external accounts, pkill, or global PID scans.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = await readFile(new URL('../../src/dev-container.ts', import.meta.url), 'utf8');
const fence = String.fromCharCode(96);
const runner = src.match(new RegExp('const LINUX_RUNNER_SOURCE = String\\.raw' + fence + '([\\s\\S]*?)' + fence + ';'))?.[1];
assert.ok(runner, 'Expected the actual production runner source');

function procState(pid) {
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0];
  } catch (error) { if (error.code === 'ENOENT') return 'gone'; throw error; }
}
function exited(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}
function deadline(promise, millis) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('runner did not stop after EPIPE')), millis); })])
    .finally(() => clearTimeout(timer));
}
async function exercise(channel) {
  const dir = await mkdtemp(join(tmpdir(), 'f0-c10-disconnect-' + channel + '-'));
  let worker, pid;
  try {
    const cmd = "node -e 'const fs=require(\"node:fs\");fs.writeFileSync(\"child.pid\",String(process.pid));setInterval(()=>process." + channel + ".write(\"Q\".repeat(4096)),15)'";
    // Same positional-argument transport as DevContainer.run().
    worker = spawn('bash', ['-lc', 'cd "$3" && exec node -e "$2" "$1"', 'opencode', cmd, runner, dir], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const result = exited(worker);
    let disconnected = false;
    let bytes = 0;
    for (const name of ['stdout','stderr']) {
      worker[name].on('data', chunk => {
        if (name === channel) {
          bytes += chunk.length;
          if (!disconnected && bytes >= 8192) {
            disconnected = true;
            worker[name].destroy(); // Simulates client dropping just this output stream.
          }
        }
      });
    }
    const status = await deadline(result, 8000);
    pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    assert.ok(disconnected, channel + ' was not intentionally closed');
    assert.equal(status.exitCode, 125, 'closed ' + channel + ' must not crash with uncaught EPIPE or report success');
    const state = procState(pid);
    assert.ok(['gone', 'Z', 'X'].includes(state), channel + ': descendant still active in state ' + state);
    return { channel, ...status, descendantState: state, bytesReadBeforeDisconnect: bytes };
  } finally {
    if (pid && Number.isSafeInteger(pid) && pid > 1) {
      // Only a PID created and recorded by this fixture, never a PID scan.
      try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
}
for (const channel of ['stdout', 'stderr']) {
  test('closing ' + channel + " terminates only the runner's child group (exit 125)", async () => {
    const result = await exercise(channel);
    assert.equal(result.exitCode, 125);
  });
}

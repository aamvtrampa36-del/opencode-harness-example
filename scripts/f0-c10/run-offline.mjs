#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { evaluateTrace } from './evaluate.mjs';
import { runMock } from './mock.mjs';

const args = process.argv.slice(2);
const option = (key) => { const i = args.indexOf(key); return i === -1 ? undefined : args[i + 1]; };
const size = Number(option('--size') || 10);
const fault = option('--fault') || null;
const suite = args.includes('--suite');
const negativeFaults = ['historical-red', 'oom', 'partial', 'orphan', 'false-pass', 'queued-only', 'cross-project', 'duplicate-request', 'client-only', 'cancelled'];
try {
  if (suite) {
    const results = [];
    for (const count of [1, 2, 4, 10]) {
      const report = evaluateTrace(await runMock({ size: count }));
      results.push({ size: count, scenario: 'green', accepted: report.pass, expected: true, metrics: report.metrics, failures: report.failures });
    }
    for (const injected of negativeFaults) {
      const report = evaluateTrace(await runMock({ size: 10, fault: injected }));
      results.push({ size: 10, scenario: injected, accepted: report.pass, expected: false, failures: report.failures });
    }
    const restart = evaluateTrace(await runMock({ size: 10, fault: 'restart-recovered' }));
    results.push({ size: 10, scenario: 'restart-reconciled', accepted: restart.pass, expected: true, failures: restart.failures });
    const recovered = evaluateTrace(await runMock({ size: 10, fault: 'retry' }));
    results.push({ size: 10, scenario: 'bounded-429-retry', accepted: recovered.pass, expected: true, failures: recovered.failures });
    const pass = results.every((r) => r.accepted === r.expected);
    const output = { pass, executor: 'local-mock-only', realStagingTested: false, results };
    if (option('--out')) await writeFile(option('--out'), JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = pass ? 0 : 1;
  } else {
    const trace = await runMock({ size, fault });
    const report = evaluateTrace(trace);
    if (option('--out')) await writeFile(option('--out'), JSON.stringify({ trace, report }, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 2;
}

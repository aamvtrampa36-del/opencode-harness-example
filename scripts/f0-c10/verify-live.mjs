#!/usr/bin/env node
// Read-only evaluator: never starts OpenCode tasks or calls a remote API.
// Trust keys and limits MUST be provisioned independently from the trace.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluateTrace, evaluateCampaign } from './evaluate.mjs';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
async function readJson(path, maxBytes = 2_000_000) {
  if (!path) throw new Error('required offline file path absent');
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error('offline input too large');
  return { parsed: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}
try {
  const paths = (option('--traces') || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!paths.length || paths.length > 3) throw new Error('use --traces trace1.json[,trace2.json,trace3.json]');
  const { parsed: limits } = await readJson(option('--limits'), 32_000);
  const { parsed: trustedKeys } = await readJson(option('--trust'), 32_000);
  const traced = await Promise.all(paths.map((p) => readJson(p)));
  const traces = traced.map((v) => v.parsed);
  const result = traces.length === 1
    ? evaluateTrace(traces[0], { mode: 'live', limits, trustedKeys })
    : evaluateCampaign(traces, limits, { trustedKeys });
  const report = {
    schema: 'f0-c10-live-evaluation-v1',
    pass: result.pass === true,
    mode: 'signed-live-trace-offline-verification',
    remoteCallsMade: 0,
    sourceFilesSha256: traced.map((t) => t.sha256),
    evaluatedExperimentIds: traces.map((t) => t.metadata?.experimentId || null),
    result,
  };
  const output = option('--out');
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = result.pass ? 0 : 1;
} catch (error) {
  console.error('FAIL-CLOSED: ' + String(error?.message || error));
  process.exitCode = 2;
}

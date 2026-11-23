import { createHash } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

// Deterministic, non-sensitive, disposable fixtures. No network, repository write or remote inference.
const tasks = [
  { kind: 'sha256', name: 'SHA-256 de entrada local', payload: 'F0-C10|sha256|mañana|2026', answer: () => ({ digest: sha256('F0-C10|sha256|mañana|2026') }) },
  { kind: 'unicode', name: 'JavaScript y Unicode', payload: 'A😀e\u0301', answer: () => ({ utf16Units: 'A😀e\u0301'.length, codePoints: [...'A😀e\u0301'].length, upper: 'mañana'.toLocaleUpperCase('es') }) },
  { kind: 'csv', name: 'CSV agregado', payload: 'team,amount\nA,7\nB,4\nA,5\nB,3\n', answer: () => ({ sum: 19, byTeam: { A: 12, B: 7 }, rows: 4 }) },
  { kind: 'json', name: 'JSON válido e inválido', payload: '{"valid":true}\n{"invalid":}', answer: () => ({ valid: true, invalid: false }) },
  { kind: 'logs', name: 'Logs sintéticos', payload: 'INFO ok\nERROR timeout\nWARN retry\nINFO done\nERROR rejected', answer: () => ({ INFO: 2, WARN: 1, ERROR: 2 }) },
  { kind: 'html', name: 'HTML accesible', payload: 'Un título y un botón etiquetado', answer: () => ({ html: '<main><h1>Estado</h1><button type="button" aria-label="Actualizar">Actualizar</button></main>' }) },
  { kind: 'tdd', name: 'TDD RED→GREEN', payload: 'Límite inclusivo de 256', answer: () => ({ boundary: 256, redExitCode: 1, greenExitCode: 0, passingTests: 3 }) },
  { kind: 'config', name: 'Combinación de configuración', payload: '{"timeoutMs":3000,"retries":1}+{"timeoutMs":5000,"retries":2,"featureX":false}', answer: () => ({ merged: { timeoutMs: 5000, retries: 2, featureX: false } }) },
  { kind: 'dag', name: 'DAG y detección de ciclo', payload: 'fetch→parse→validate→report; X→Y→X', answer: () => ({ order: ['fetch', 'parse', 'validate', 'report'], cycleDetected: true }) },
  { kind: 'pipeline', name: 'Pipeline y reporte', payload: '2,6,10', answer: () => ({ rows: 3, total: 18, report: 'rows=3;total=18', reportSha256: sha256('rows=3;total=18') }) },
];

export const TASKS = Object.freeze(tasks.map((t, i) => Object.freeze({ ...t, slot: i + 1 })));
export const canonicalOutput = (kind) => {
  const t = TASKS.find((item) => item.kind === kind);
  if (!t) throw new Error('unknown task kind: ' + kind);
  return JSON.stringify(t.answer());
};

export function verifyArtifact(spec, artifact) {
  if (!artifact || artifact.kind !== spec.kind || typeof artifact.content !== 'string') return false;
  if (Buffer.byteLength(artifact.content, 'utf8') > 8192) return false;
  if (artifact.sha256 !== sha256(artifact.content)) return false;
  let actual, expected;
  try { actual = JSON.parse(artifact.content); expected = JSON.parse(canonicalOutput(spec.kind)); }
  catch { return false; }
  // Exact contract for synthetic tasks; a self-reported verified flag is never sufficient.
  return JSON.stringify(actual) === JSON.stringify(expected);
}

import { TASKS, canonicalOutput, sha256, verifyArtifact } from '../tasks.mjs';

export const SIZES = Object.freeze([1, 2, 4, 10]);
export const NEGATIVES = Object.freeze(['historical-red', 'queued-only', 'false-pass', 'cross-project', 'duplicate-request', 'no-overlap', 'oom', 'over-budget', 'missing-close', 'missing-readback', 'corrupt-readback', 'cancelled', 'restart', 'response-lost', 'read-only']);
const repo = 'aamvtrampa36-del/opencode-harness-example';
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const bytes = text => Buffer.byteLength(text, 'utf8');
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The manifest is a fixture, never a submission payload or a live authorization.
export function manifest(size) {
  if (!SIZES.includes(size)) throw new Error('invalid round size');
  const tasks = TASKS.slice(0, size).map(t => {
    const content = canonicalOutput(t.kind);
    const fixtureId = `fixture-${size}-${t.slot}-${t.kind}`;
    const path = `tmp/f0-c10/fixtures/${fixtureId}/result.json`;
    const input = t.kind === 'unicode' ? { text: t.payload, upperText: 'mañana', locale: 'es' } : { text: t.payload };
    return { fixtureId, kind: t.kind, input, inputSha256: sha256(JSON.stringify(input)),
      expected: { content, sha256: sha256(content), size: bytes(content), type: 'application/json', path },
      scope: { project: fixtureId, path, github: t.kind === 'pipeline' ? { repo, path: 'docs/opencode-agent-lab/fixture-report.json', draft: true, authorizationRequired: true, branch: null, baseSha: null } : null },
      limits: { maxOutputBytes: 8192, maxFixtureDurationMs: 180000, liveInferenceCalls: 0, liveCostUsd: 0 } };
  });
  const body = { schema: 'metralla.m07.manifest.v1', mode: 'fixture', size, tasks, liveAuthorization: null };
  return freeze({ ...body, digest: sha256(JSON.stringify(body)) });
}

export function validManifest(value) {
  try { return SIZES.includes(value?.size) && exact(value, manifest(value.size)); } catch { return false; }
}

// Independent readback must contain bytes, not a producer's success flag.
// This validator only certifies fixture output; P23 owns runtime identity/activity and closure.
export function verifyFixtureOutput(spec, evidence) {
  if (!spec || !evidence || evidence.schema !== 'metralla.m07.output.v1' || evidence.mode !== 'fixture' || evidence.fixtureId !== spec.fixtureId || evidence.project !== spec.scope.project || evidence.exitCode !== 0) return false;
  const a = evidence.readback;
  if (!a || a.source !== 'fixture-readback' || a.path !== spec.expected.path || a.type !== spec.expected.type || typeof a.content !== 'string' || bytes(a.content) !== a.size || a.size !== spec.expected.size || a.content !== spec.expected.content || a.sha256 !== spec.expected.sha256 || !verifyArtifact(spec, { ...a, kind: spec.kind })) return false;
  const g = evidence.github;
  if (spec.scope.github) {
    if (!g || g.mode !== 'fixture' || g.effect !== 'simulated-draft' || g.repo !== spec.scope.github.repo || g.path !== spec.scope.github.path || g.contentSha256 !== a.sha256 || g.liveWrite !== false) return false;
  } else if (g !== null) return false;
  return evidence.liveEffects === 0;
}

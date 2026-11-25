/** P11 candidate against OWNERS Execution/source v1. No VM starts or network calls here.
 * Inputs must be built from server-owned scope, durable boot receipt and fresh observations,
 * never model/tool arguments. The effect receiver must enforce fencing atomically. */
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const slug = /^[a-z][a-z0-9-]{0,39}$/;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);
const fail = (code: string): never => { throw new Error(code); };
export type SourceScope = { project: string; repository: string; commit: string; tree: string };
export type SourceReceipt = SourceScope & { certification: string; sha256: string; files: number };
export type Lease = { requestId: string; project: string; generation: number; token: string; expiresAt: number };
export type ImagePolicy = { kind: 'reference'; reference: string } |
  { kind: 'pinned'; reference: string; digest: string };
export type BootReceipt = { project: string; objectId: string; bootLabel: string; bootId: string; image: ImagePolicy };
export type RuntimeObservation = { project: string; objectId: string; running: boolean; bootLabel: string; bootId: string; imageReference: string };
export type ExecutionScope = { source: SourceScope; lease: Lease; boot: BootReceipt };
export function assertSourceScope(expected: SourceScope, actual: SourceScope): void {
  if (!expected || !actual || !matches(slug, expected.project) || !matches(repo, expected.repository) ||
      !matches(sha1, expected.commit) || !matches(sha1, expected.tree) || actual.project !== expected.project ||
      typeof actual.repository !== 'string' || actual.repository.toLowerCase() !== expected.repository.toLowerCase() ||
      actual.commit !== expected.commit || actual.tree !== expected.tree) fail('M03_SOURCE_SCOPE_MISMATCH');
}
export function assertSourceReceipt(expected: SourceScope, actual: SourceReceipt): void {
  assertSourceScope(expected, actual);
  if (actual.certification !== 'raw-git-tree-v1' || !matches(sha256, actual.sha256) ||
      !Number.isSafeInteger(actual.files) || actual.files < 1 || actual.files > 15000)
    fail('M03_SOURCE_UNCERTIFIED');
}
/** A managed reference is allowed in the normal lane, but is never digest-certified.
 * For a pinned policy, the exact reference must already exist in the deployed image map. */
export function assertImagePolicy(policy: ImagePolicy, configured: readonly string[]): void {
  if (!policy || typeof policy.reference !== 'string' || !policy.reference || !configured.includes(policy.reference))
    fail('M03_IMAGE_NOT_CONFIGURED');
  if (policy.kind === 'pinned') {
    if (!matches(digest, policy.digest) || !/^registry\.cloudflare\.com\/[A-Za-z0-9_./:-]+@sha256:[a-f0-9]{64}$/.test(policy.reference) ||
        !policy.reference.endsWith('@' + policy.digest)) fail('M03_IMAGE_DIGEST_MISMATCH');
  } else if (policy.kind !== 'reference') fail('M03_IMAGE_POLICY_INVALID');
}
export function assertLease(expected: Lease, current: Lease | undefined, project: string, now: number): void {
  if (!expected || !current || !Number.isSafeInteger(now) || now < 0 ||
      !matches(/^[a-f0-9]{16}$/, expected.requestId) || expected.project !== project ||
      (project.startsWith("supervised-") && project !== "supervised-" + expected.requestId) ||
      !Number.isSafeInteger(expected.generation) || expected.generation < 1 ||
      typeof expected.token !== 'string' || !expected.token ||
      !Number.isSafeInteger(expected.expiresAt) || now >= expected.expiresAt ||
      current.requestId !== expected.requestId || current.project !== project ||
      current.generation !== expected.generation || current.token !== expected.token ||
      current.expiresAt !== expected.expiresAt) fail('M03_LEASE_FENCED');
}
export function assertRuntime(expected: BootReceipt, actual: RuntimeObservation, project: string, configured: readonly string[]): void {
  if (!expected || !actual || expected.project !== project || actual.project !== project ||
      !matches(sha256, expected.objectId) || actual.objectId !== expected.objectId || actual.running !== true ||
      !matches(uuid, expected.bootLabel) || !matches(uuid, expected.bootId) ||
      actual.bootLabel !== expected.bootLabel || actual.bootId !== expected.bootId)
    fail('M03_VM_IDENTITY_MISMATCH');
  assertImagePolicy(expected.image, configured);
  // inspect() echoes the start reference. Equality is not proof of a registry resolution.
  if (actual.imageReference !== expected.image.reference) fail('M03_IMAGE_REFERENCE_MISMATCH');
}
/** Validate just before a protected effect; no recovery or fallback on mismatch.
 * This is NOT a mutex or an atomic check-and-effect implementation. */
export function assertExecutionIdentity(scope: ExecutionScope, receipt: SourceReceipt,
  observation: RuntimeObservation, currentLease: Lease | undefined, configured: readonly string[], now: number): void {
  assertLease(scope.lease, currentLease, scope.source.project, now);
  assertSourceReceipt(scope.source, receipt);
  assertRuntime(scope.boot, observation, scope.source.project, configured);
}

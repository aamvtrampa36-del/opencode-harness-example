import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  validateSupervisorStart, supervisorFingerprint, supervisorBranch, supervisorPrompt,
  supervisorProject, assertSupervisorBoundGitHubOperation, supervisorStartOperationId,
  supervisorSessionCreationDisposition, canConfirmSupervisorPreSessionCancellation
} from "./supervisor-control";

const repo = "aamvtrampa36-del/opencode-harness-example";
const approved = [repo, "aamvtrampa36-del/cdf-cloud-engine"];
const input = { requestId: "a1234567890bcdef", repository: repo,
  prompt: "Auditar contrato común\ncon evidencia local" };
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const ro = validateSupervisorStart({ ...input, mode: "read_only", sourceCommit: commit, sourceTree: tree }, approved);

test("ordinary fingerprints are byte-compatible with the pre-C05 SHA-256 vectors", async () => {
  assert.equal(await supervisorFingerprint(input), "ae337a7e85b67481d91435035dd829d06f1556182066ecd3ad573c5c7a99b8ef");
  assert.equal(await supervisorFingerprint({ ...input, model: "economy" }), await supervisorFingerprint(input));
  assert.equal(await supervisorFingerprint({ ...input, model: "review", sourceSession: "sesAbc123" }), "a7bbd0e0ca6b611ba105bd30b7d295ca410f51286d4594b6e25aca9eb4c9ce76");
  assert.equal(await supervisorFingerprint({ ...input, model: "openrouter:google/gemini-3.8-flash" }), "ab9f02fe821e01a66e79c66d84b84733ef3d451dd77c8f44e099d6a2f91eb0ec");
  assert.equal(await supervisorFingerprint({ ...input, sourceSession: "sesAbc123" }), "1ae9ce5200d056df3d035310366e45378ddeff6dbc7c1a1055f5f36fb31b41ed");
  assert.deepEqual(validateSupervisorStart(input, approved), input);
});

test("read-only pins, mode and identity are canonical and disjoint", async () => {
  assert.deepEqual(ro, { ...input, mode: "read_only", sourceCommit: commit, sourceTree: tree });
  const digest = await supervisorFingerprint(ro);
  assert.equal(digest, "4e0355362631e8d996ea0c8abb60d51e445559b8b4ab7bfedc6b82279ff337fb");
  assert.notEqual(digest, await supervisorFingerprint(input));
  assert.equal(digest, await supervisorFingerprint({ ...ro, model: "economy" }));
  assert.equal(digest, await supervisorFingerprint({ ...ro, repository: repo.toUpperCase() }));
  assert.notEqual(digest, await supervisorFingerprint({ ...ro, prompt: input.prompt + "\n" + tree }));
  assert.notEqual(digest, await supervisorFingerprint({ ...ro, sourceCommit: tree, sourceTree: commit }));
  assert.notEqual(digest, await supervisorFingerprint({ ...ro, model: "review" }));
});

test("same requestId with different commit or tree cannot replay the same fingerprint", async () => {
  const original = await supervisorFingerprint(ro);
  const changedCommit = validateSupervisorStart({ ...ro, sourceCommit: "c".repeat(40) }, approved);
  const changedTree = validateSupervisorStart({ ...ro, sourceTree: "d".repeat(40) }, approved);
  assert.equal(supervisorStartOperationId(changedCommit.requestId), supervisorStartOperationId(ro.requestId));
  assert.notEqual(await supervisorFingerprint(changedCommit), original);
  assert.notEqual(await supervisorFingerprint(changedTree), original);
  assert.equal(await supervisorFingerprint({ ...ro }), original);
});

test("invalid mode, pins, forks and unauthorized repositories fail closed", async () => {
  for (const candidate of [
    { ...ro, sourceCommit: undefined }, { ...ro, sourceTree: undefined },
    { ...ro, sourceCommit: "A".repeat(40) }, { ...ro, sourceTree: "b".repeat(39) },
    { ...ro, sourceTree: null }, { ...ro, sourceCommit: 123 },
    { ...ro, mode: null }, { ...ro, mode: "write" },
    { ...input, sourceCommit: commit, sourceTree: tree },
    { ...ro, sourceSession: "sesAbc123" }, { ...ro, sourceSession: "" },
    { ...ro, repository: "another-owner/repo" },
    { ...ro, repository: "aamvtrampa36-del/not-approved" },
    { ...ro, unknown: true }, { ...ro, requestId: "invalid" },
    { ...ro, model: "unknown" }
  ]) assert.throws(() => validateSupervisorStart(candidate, approved));
  await assert.rejects(supervisorFingerprint({ ...ro, sourceTree: undefined }));
  await assert.rejects(supervisorFingerprint({ ...ro, sourceSession: "sesAbc123" }));
  await assert.rejects(supervisorFingerprint({ ...input, sourceCommit: commit }));
});

test("no branch for read_only, normal branches and durable creation guards remain", () => {
  assert.equal(supervisorBranch(ro.requestId, repo, ro.mode), "");
  assert.equal(supervisorBranch(input.requestId, repo), "opencode/staging-" + input.requestId);
  assert.equal(supervisorBranch(input.requestId), "opencode/supervised-" + input.requestId);
  assert.equal(supervisorBranch(input.requestId, approved[1]), "opencode/supervised-" + input.requestId);
  assert.throws(() => supervisorBranch("bad", repo, ro.mode));
  assert.equal(supervisorProject(ro.requestId), "supervised-" + input.requestId);
  assert.equal(supervisorSessionCreationDisposition({}), "reconcile");
  assert.equal(supervisorSessionCreationDisposition({ sessionCreationAttempted: false }), "create");
  assert.equal(canConfirmSupervisorPreSessionCancellation({ sessionCreationAttempted: false }, true), false);
});

test("read_only Github guard allows only current reads and denies mutations, review and unknown operations", () => {
  for (const op of ["repo", "read", "pr_search", "pr_info", "issue_info", "pr_files", "pr_reviews", "pr_checks"]) {
    assert.doesNotThrow(() => assertSupervisorBoundGitHubOperation(op, undefined, "", ro.mode));
  }
  for (const op of ["branch", "write", "pr", "review", "merge", "future_mutation", undefined]) {
    assert.throws(() => assertSupervisorBoundGitHubOperation(op, "", "", ro.mode));
    assert.throws(() => assertSupervisorBoundGitHubOperation(op, "opencode/other", "opencode/other", ro.mode));
  }
  assert.throws(() => assertSupervisorBoundGitHubOperation("write", "", ""));
  assert.throws(() => assertSupervisorBoundGitHubOperation("read", undefined, "opencode/other", ro.mode));
  const branch = supervisorBranch(input.requestId, repo);
  for (const op of ["write", "pr", "review"]) {
    assert.doesNotThrow(() => assertSupervisorBoundGitHubOperation(op, branch, branch));
    assert.throws(() => assertSupervisorBoundGitHubOperation(op, "main", branch));
  }
  assert.throws(() => assertSupervisorBoundGitHubOperation("branch", branch, branch));
});

test("prompt binds verified pins and forbids GitHub branch, write, PR and review", () => {
  const project = supervisorProject(ro.requestId);
  const p = supervisorPrompt(ro, "", project, commit, tree);
  for (const phrase of ["SOLO LECTURA", commit, tree, project, "no crees ramas", "no escribas en GitHub",
    "no abras PR", "ni solicites revisión", "antes de preparar el modelo", "SHA fijado como ref"]) assert.ok(p.includes(phrase));
  assert.ok(!p.includes("Rama precreada"));
  assert.ok(!p.includes("PR borrador"));
  assert.throws(() => supervisorPrompt(ro, "", project, commit));
  assert.throws(() => supervisorPrompt(ro, "", project, commit, commit));
  assert.throws(() => supervisorPrompt(ro, "", project, tree, tree));
  assert.throws(() => supervisorPrompt(ro, "opencode/other", project, commit, tree));
  const ordinary = supervisorPrompt(input, supervisorBranch(input.requestId, repo), project, commit);
  assert.ok(ordinary.includes("PR borrador"));
  assert.ok(ordinary.includes("No leas ni presentes main como Staging"));
});

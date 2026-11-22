#!/usr/bin/env node
/**
 * GitHub Actions durable selftest: short, bounded phases, one immutable SHA,
 * independent receipts and no background processes. Production is untouched.
 * GitHub Actions persists the preflight artifact between jobs/restarts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".ci-proof";
const SHA_RE = /^[a-f0-9]{40}$/;
const SCHEMA = "opencode-ci-phase/1";
const STAGES = ["unit-tests", "typecheck", "invariants", "preview-synthetic"];
const RUNTIME = ["preflight", "build", "serve", "http"];
const HTTP = ["functional-index", "functional-asset", "negative-404", "negative-source-isolation", "negative-method"];
const digest = (data) => createHash("sha256").update(data).digest("hex");
const fileDigest = (path) => digest(readFileSync(path));
const tail = (value) => String(value ?? "").slice(-1250).replace(/sk-(?:or-v1|proj)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
function fail(message) {
  throw new Error("FAIL-CLOSED: " + message);
}
function json(path) {
  if (!existsSync(path)) fail("Missing durable checkpoint " + path);
  return JSON.parse(readFileSync(path, "utf8"));
}
function save(name, record) {
  mkdirSync(ROOT, { recursive: true });
  const path = join(ROOT, name);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { flag: "w", mode: 0o600 });
  return path;
}
function identity() {
  if (process.env.GITHUB_ACTIONS !== "true") fail("GitHub Actions is required");
  const sha = process.env.GITHUB_SHA ?? "";
  const branch = process.env.GITHUB_REF_NAME ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  if (!SHA_RE.test(sha) || !/^opencode\/staging-[a-f0-9]{16}$/.test(branch) ||
      !/^[0-9]+$/.test(runId)) fail("Invalid fixed GitHub execution identity");
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (actual !== sha || dirty.trim()) fail("Git HEAD / clean tracked tree mismatch");
  return { sha, branch, runId };
}
function sameId(receipt, id) {
  if (!receipt || receipt.schema !== SCHEMA || receipt.sha !== id.sha ||
      receipt.branch !== id.branch || receipt.runId !== id.runId ||
      receipt.ok !== true) fail("Mismatched or failing persisted receipt");
}
function validateChecks(receipt, id) {
  sameId(receipt, id);
  if (receipt.phase !== "checks" || !Array.isArray(receipt.stages) ||
      receipt.stages.length !== STAGES.length ||
      STAGES.some((name, i) => receipt.stages[i]?.name !== name ||
        receipt.stages[i]?.exitCode !== 0 || receipt.stages[i]?.ok !== true)) {
    fail("Incomplete or reordered delegated check stages");
  }
}
function invoke(label, command, args, expected = 0) {
  const started = Date.now();
  const child = spawnSync(command, args, {
    encoding: "utf8", maxBuffer: 24 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=2048" },
    timeout: 12 * 60_000
  });
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  const result = {
    name: label, ok: child.status === expected && !child.error,
    exitCode: child.status, expectedExitCode: expected,
    ms: Date.now() - started,
    stdoutSha256: digest(stdout), stderrSha256: digest(stderr)
  };
  console.log(label + " exit=" + child.status + " expected=" + expected + " elapsedMs=" + result.ms);
  if (!result.ok) {
    console.error(tail(stdout));
    console.error(tail(stderr || String(child.error ?? "")));
    fail(label + " failed or exceeded timeout");
  }
  return result;
}
const id = identity();
const phase = process.argv[2];
if (phase === "checks") {
  const stages = [
    invoke("unit-tests", "bun", ["test"]),
    invoke("typecheck", "bun", ["run", "typecheck"]),
    invoke("invariants", "bun", ["scripts/check-invariants.mjs"]),
    invoke("preview-synthetic", "bun", ["scripts/test-preview.mjs"])
  ];
  const path = save("checks.json", { schema: SCHEMA, phase: "checks", ...id,
    stages, ok: true, at: new Date().toISOString() });
  console.log("PERSISTED " + path);
} else if (phase === "verify-checks") {
  validateChecks(json(join(ROOT, "checks.json")), id);
  console.log("CHECKPOINT CHECKS ACCEPTED (same SHA and GitHub run): " + id.sha);
} else if (phase === "full") {
  const checks = json(join(ROOT, "checks.json"));
  validateChecks(checks, id);
  const stage = invoke("real-selftest", "bun", ["scripts/selftest.mjs", "--branch", id.branch,
    "--commit", id.sha, "--receipt", join(ROOT, "runtime.json")]);
  const runtime = json(join(ROOT, "runtime.json"));
  if (runtime.schema !== "opencode-selftest-receipt/1" || runtime.verdict !== "pass" ||
      runtime.commitLinked !== true || runtime.commit !== id.sha ||
      runtime.branch !== id.branch || !Array.isArray(runtime.stages) ||
      runtime.stages.length !== RUNTIME.length ||
      RUNTIME.some((name, i) => runtime.stages[i]?.id !== name ||
        runtime.stages[i]?.ok !== true || runtime.stages[i]?.exitCode !== 0) ||
      !Array.isArray(runtime.checks) || runtime.checks.length !== HTTP.length ||
      HTTP.some((name, i) => runtime.checks[i]?.id !== name ||
        runtime.checks[i]?.ok !== true) ||
      runtime.checks[0]?.actual?.bodyMatchesDisk !== true ||
      runtime.checks[1]?.actual?.bodyMatchesDisk !== true) {
    fail("Runtime E2E HTTP and build evidence not complete");
  }
  const artifact = runtime.buildArtifact;
  if (!artifact?.clientIndexSha256 || !artifact?.workerEntrySha256 ||
      artifact.clientIndexSha256 !== fileDigest("dist/client/index.html") ||
      artifact.workerEntrySha256 !== fileDigest("dist/opencode_harness_example/index.js")) {
    fail("Built artifact not equal to tested filesystem bytes");
  }
  const negativeSha = invoke("reject-forged-sha", "bun", ["scripts/selftest.mjs", "--branch",
    id.branch, "--commit", "a".repeat(40), "--receipt", join(ROOT, "negative-sha.json")], 2);
  const rejectedSha = json(join(ROOT, "negative-sha.json"));
  if (rejectedSha.verdict !== "fail-closed" || rejectedSha.commitLinked !== false) {
    fail("Wrong Git SHA was accepted");
  }
  const negativePartial = invoke("reject-partial-pass", "bun", ["scripts/selftest.mjs", "--branch",
    id.branch, "--commit", id.sha, "--only", "preflight",
    "--receipt", join(ROOT, "negative-partial.json")], 2);
  const rejectedPartial = json(join(ROOT, "negative-partial.json"));
  if (rejectedPartial.verdict !== "fail-closed" ||
      !rejectedPartial.stages.some(s => s.id === "preflight" && s.ok)) {
    fail("Partial stage was accepted as full PASS");
  }
  const final = { schema: "opencode-ci-final/1", ...id, verdict: "pass",
    checksCheckpointSha256: fileDigest(join(ROOT, "checks.json")),
    runtimeCheckpointSha256: fileDigest(join(ROOT, "runtime.json")),
    artifact, positiveStages: [...STAGES, ...RUNTIME],
    negativeControls: [negativeSha.name, negativePartial.name],
    httpChecks: runtime.checks.map(x => ({ id: x.id, status: x.actual?.status, ok: x.ok })),
    previousJobReused: true,
    scope: "GitHub Actions/Linux preview; NOT a Worker+Container+DO disaster-recovery test",
    at: new Date().toISOString()
  };
  const path = save("final.json", final);
  console.log("VERIFIED FINAL RECEIPT " + path + " sha256=" + fileDigest(path));
} else {
  fail("Unknown operation");
}

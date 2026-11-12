import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOBILE_NOTE,
  RECEIPT_SCHEMA,
  STAGE_ORDER,
  assertNoSecrets,
  buildHttpChecks,
  buildReceipt,
  dependentsOf,
  selectStages,
  validateTarget,
} from "./selftest-core";

describe("selftest target validation (fail closed)", () => {
  test("accepts isolated review branch, valid project and commit", () => {
    const result = validateTarget({
      project: "cdf-staging",
      branch: "opencode/task-123",
      commit: "1234567890abcdef1234567890abcdef12345678",
    });
    expect(result.ok).toBe(true);
  });
  test("rejects a non-review branch even with a commit", () => {
    const result = validateTarget({ project: "cdf-staging", branch: "main", commit: "1234567890abcdef" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("branch");
  });
  test("rejects an invalid project slug", () => {
    const result = validateTarget({ project: "Bad_Slug", branch: "opencode/x", commit: null, allowUncommitted: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("project");
  });
  test("requires a commit unless explicitly allowed", () => {
    const missing = validateTarget({ project: "cdf-staging", branch: "opencode/x", commit: null });
    expect(missing.ok).toBe(false);
    const allowed = validateTarget({ project: "cdf-staging", branch: "opencode/x", commit: null, allowUncommitted: true });
    expect(allowed.ok).toBe(true);
    const malformed = validateTarget({ project: "cdf-staging", branch: "opencode/x", commit: "ZEBRA" });
    expect(malformed.ok).toBe(false);
  });
});

describe("affected-only stage selection", () => {
  const allPass = STAGE_ORDER.map((id) => ({ id, ok: true }));
  test("fresh run executes every stage", () => {
    expect(selectStages().run).toEqual([...STAGE_ORDER]);
    expect(selectStages({ previous: [] }).run).toEqual([...STAGE_ORDER]);
  });
  test("a failed build reruns build and its dependents", () => {
    const selection = selectStages({
      previous: [
        { id: "preflight", ok: true },
        { id: "build", ok: false },
        { id: "serve", ok: true },
        { id: "http", ok: true },
      ],
    });
    expect(selection.run).toEqual(["build", "serve", "http"]);
  });
  test("a failed http check reruns serve and http, not build", () => {
    const selection = selectStages({ previous: [...allPass.slice(0, 3), { id: "http", ok: false }] });
    expect(selection.run).toEqual(["serve", "http"]);
  });
  test("an all-passed previous receipt reruns nothing", () => {
    const selection = selectStages({ previous: allPass });
    expect(selection.run).toEqual([]);
    expect(selection.skipped.map((s) => s.because).every((b) => b.includes("passed previously"))).toBe(true);
  });
  test("an artifact change forces rebuild plus dependents", () => {
    const selection = selectStages({ previous: allPass, forceRebuild: true });
    expect(selection.run).toEqual(["build", "serve", "http"]);
  });
  test("--only narrows the selection", () => {
    expect(selectStages({ only: ["http"] }).run).toEqual(["http"]);
  });
  test("dependentsOf is transitive and ordered", () => {
    expect(dependentsOf("preflight")).toEqual(["build", "serve", "http"]);
    expect(dependentsOf("build")).toEqual(["serve", "http"]);
    expect(dependentsOf("serve")).toEqual(["http"]);
    expect(dependentsOf("http")).toEqual([]);
  });
});

describe("http checks, receipt verdict and secret scan", () => {
  test("checks cover functional endpoints and three negatives", () => {
    const checks = buildHttpChecks("selftest-candidate", { assetJs: "index-abc123.js", nonce: "feedc0de" });
    expect(checks.map((c) => c.id)).toEqual([
      "functional-index",
      "functional-asset",
      "negative-404",
      "negative-source-isolation",
      "negative-method",
    ]);
    const missing = checks.find((c) => c.id === "negative-404");
    expect(missing?.path).toContain("missing-feedc0de.js");
    const index = checks.find((c) => c.id === "functional-index");
    expect(index?.expect.contentType).toContain("text/html");
    expect(index?.expect.bodyEqualsDisk).toBe("index.html");
  });
  test("verdict is pass only when everything is ok", () => {
    const stages = STAGE_ORDER.map((id) => ({ id, ok: true, exitCode: 0, ms: 1, logTail: "" }));
    const pass = buildReceipt({
      runId: "r1",
      startedAt: "t0",
      finishedAt: "t1",
      project: "p",
      branch: "opencode/x",
      commit: null,
      commitLinked: false,
      runtime: { bun: "1.4.4", node: null, platform: "linux" },
      stages,
      checks: [],
      buildArtifact: null,
      mobile: MOBILE_NOTE,
    });
    expect(pass.schema).toBe(RECEIPT_SCHEMA);
    expect(pass.verdict).toBe("pass");
    const broken = buildReceipt({ ...pass, stages: stages.map((s) => ({ ...s, ok: s.id !== "http" })) });
    expect(broken.verdict).toBe("fail");
    const closed = buildReceipt({ ...pass, failClosed: "no bun runtime" });
    expect(closed.verdict).toBe("fail-closed");
    expect(closed.failClosedReason).toBe("no bun runtime");
  });
  test("receipts must not carry secrets", () => {
    const stages = STAGE_ORDER.map((id) => ({ id, ok: true, exitCode: 0, ms: 1, logTail: "" }));
    const receipt = buildReceipt({
      runId: "r1",
      startedAt: "t0",
      finishedAt: "t1",
      project: "p",
      branch: "opencode/x",
      commit: null,
      commitLinked: false,
      runtime: { bun: "1.4.4", node: null, platform: "linux" },
      stages,
      checks: [],
      buildArtifact: null,
      mobile: MOBILE_NOTE,
      notes: ["clean note"],
    });
    expect(() => assertNoSecrets(receipt)).not.toThrow();
    expect(() => assertNoSecrets({ ...receipt, notes: ["sk-or-v1-abcdefabcdefabcdef"] })).toThrow();
  });
});


describe("selftest CLI independent acceptance gates (real subprocess)", () => {
  const run = (...args: string[]) => {
    const scratch = mkdtempSync(join(tmpdir(), "opencode-negative-selftest-"));
    try {
      return spawnSync(process.execPath,
        ["scripts/selftest.mjs", "--branch", "opencode/verify-safety",
         "--receipt", join(scratch, "receipt.json"), ...args],
        { encoding: "utf8", timeout: 30_000, env: process.env });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  test("cannot claim commit linkage with an invented SHA", () => {
    const result = run("--commit", "a".repeat(40));
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain("does not match the actual Git HEAD");
  });
  test("cannot claim reused artifacts without a matching prior receipt", () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
    expect(head.status).toBe(0);
    const result = run("--commit", head.stdout.trim(), "--reuse-dist");
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain("--reuse-dist requires --resume");
  });
  test("a partial --only preflight never passes as a complete candidate", () => {
    const result = run("--allow-uncommitted", "--only", "preflight");
    expect(result.status).toBe(2);
    expect(String(result.stdout)).toContain("verdict=fail-closed");
  });
});

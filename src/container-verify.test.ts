import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FS_VERIFY_SOURCE, assertRoundTripIntegrity, evaluateRollbackPaths,
  normalizeImageRef, parseVerifyReport, preflightSnapshotSupport
} from "./container-verify";

const hasNode = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;

function runVerify(root: string, project: string, opts: { negative?: boolean; runId?: string } = {}) {
  const runId = opts.runId ?? randomUUID().replace(/-/g, "").slice(0, 16);
  const result = spawnSync("node", ["--input-type=module", "-e", FS_VERIFY_SOURCE], {
    env: {
      ...process.env,
      VERIFY_ROOT: root,
      VERIFY_PROJECT: project,
      VERIFY_RUN_ID: runId,
      VERIFY_NEGATIVE: opts.negative ? "1" : "0"
    },
    encoding: "utf8",
    timeout: 120_000
  });
  return { result, runId };
}
const externalBackup = (runId: string) => join(tmpdir(), "verify-backup-" + runId + ".tgz");

describe("filesystem backup/restore round trip (real execution)", () => {
  test("corrupted live copy is restored with identical SHA-256 and identity", () => {
    if (!hasNode) throw new Error("node is required for the round-trip test");
    const root = mkdtempSync(join(tmpdir(), "fsverify-ok-"));
    try {
      const { result, runId } = runVerify(root, "unit-fs-verify");
      const report = parseVerifyReport(result.stdout ?? "");
      expect(report).not.toBeNull();
      expect(report?.ok).toBe(true);
      expect(result.status).toBe(0);
      expect(report?.checks.every((c) => c.status === "pass")).toBe(true);
      expect(report?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report?.archiveBytes ?? 0).toBeGreaterThan(0);
      // Successful runs clean up their isolated artifacts.
      expect(existsSync(join(root, "__verify-unit-fs-verify-" + runId))).toBe(false);
      expect(existsSync(externalBackup(runId))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("negative control: corrupted archive is detected as FAIL, never a synthetic PASS", () => {
    if (!hasNode) throw new Error("node is required for the negative control");
    const root = mkdtempSync(join(tmpdir(), "fsverify-neg-"));
    const runId = randomUUID().replace(/-/g, "").slice(0, 16);
    try {
      const { result } = runVerify(root, "unit-fs-verify", { negative: true, runId });
      const report = parseVerifyReport(result.stdout ?? "");
      expect(report).not.toBeNull();
      expect(report?.mode).toBe("negative");
      expect(report?.ok).toBe(false);
      expect(result.status).not.toBe(0);
      expect(report?.checks.some((c) => c.status === "fail")).toBe(true);
      expect(report?.artifactsKept).toBe(true);
      rmSync(externalBackup(runId), { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(externalBackup(runId), { force: true });
    }
  });

  test("invalid environment fails closed with ok:false and non-zero exit", () => {
    if (!hasNode) throw new Error("node is required");
    const root = mkdtempSync(join(tmpdir(), "fsverify-bad-"));
    try {
      const { result } = runVerify(root, "BAD_SLUG");
      const report = parseVerifyReport(result.stdout ?? "");
      expect(result.status).not.toBe(0);
      expect(report?.ok).toBe(false);
      expect(report?.checks[0]?.status).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verify source never contains shell interpolation placeholders", () => {
    expect(FS_VERIFY_SOURCE).not.toContain("${");
    expect(FS_VERIFY_SOURCE).not.toContain("`");
  });
});

describe("snapshot preflight (fail-closed)", () => {
  test("absent container API or methods is unsupported with explicit reasons", () => {
    const noBinding = preflightSnapshotSupport({
      containerApiAvailable: false, hasSnapshotContainer: false, hasSnapshotDirectory: false
    });
    expect(noBinding.supported).toBe(false);
    expect(noBinding.reasons.length).toBe(3);
    const partial = preflightSnapshotSupport({
      containerApiAvailable: true, hasSnapshotContainer: true, hasSnapshotDirectory: false
    });
    expect(partial.supported).toBe(false);
    expect(partial.fullContainerSnapshot).toBe(true);
    expect(partial.reasons.join(" ")).toContain("snapshotDirectory");
  });

  test("full API surface reports supported but live proof still pending deployment", () => {
    const full = preflightSnapshotSupport({
      containerApiAvailable: true, hasSnapshotContainer: true, hasSnapshotDirectory: true
    });
    expect(full.supported).toBe(true);
    expect(full.liveProof).toBe("pending-deployment");
  });
});

describe("image identity normalization", () => {
  test("accepts named tags, digests and bare sha256 references", () => {
    expect(normalizeImageRef(" cloudflare/debian-trixie ")).toBe("cloudflare/debian-trixie");
    expect(normalizeImageRef("cloudflare/debian-trixie@sha256:" + "a".repeat(64)))
      .toBe("cloudflare/debian-trixie@sha256:" + "a".repeat(64));
    expect(normalizeImageRef("sha256:" + "b".repeat(64))).toBe("sha256:" + "b".repeat(64));
    expect(normalizeImageRef("")).toBeNull();
    expect(normalizeImageRef(undefined)).toBeNull();
    expect(normalizeImageRef("bad ref with spaces")).toBeNull();
    expect(normalizeImageRef("sha256:short")).toBeNull();
  });
});

describe("round trip integrity", () => {
  test("only matching present anchors pass; mismatches list explicit failures", () => {
    const a = "aa".repeat(32);
    const b = "bb".repeat(32);
    expect(assertRoundTripIntegrity({
      payloadSha256Before: a, payloadSha256After: a,
      identitySha256Before: b, identitySha256After: b
    }).ok).toBe(true);
    const corruptedPayload = assertRoundTripIntegrity({
      payloadSha256Before: a, payloadSha256After: "cc".repeat(32),
      identitySha256Before: b, identitySha256After: b
    });
    expect(corruptedPayload.ok).toBe(false);
    expect(corruptedPayload.failures[0]).toContain("payload");
    const changedImage = assertRoundTripIntegrity({
      payloadSha256Before: a, payloadSha256After: a,
      identitySha256Before: b, identitySha256After: "dd".repeat(32)
    });
    expect(changedImage.ok).toBe(false);
    expect(changedImage.failures[0]).toContain("identity");
    expect(assertRoundTripIntegrity({
      payloadSha256Before: null, payloadSha256After: a,
      identitySha256Before: b, identitySha256After: b
    }).ok).toBe(false);
  });
});

describe("rollback path assessment", () => {
  test("durable_object policy: versions API unavailable, source redeploy available", () => {
    const statuses = evaluateRollbackPaths({ versionsCount: 0, schedulingPolicy: "durable_object" });
    const by = Object.fromEntries(statuses.map((s) => [s.path, s]));
    expect(by["worker-versions-api"].status).toBe("unavailable");
    expect(by["worker-versions-api"].reason).toContain("durable_object");
    expect(by["worker-source-redeploy"].status).toBe("available");
    expect(by["container-image-restore"].status).toBe("requires-deployment");
    expect(by["container-filesystem-restore"].status).toBe("available");
    expect(by["persistent-do-storage"].status).toBe("available");
  });
});

describe("parseVerifyReport strictness", () => {
  test("garbage, missing marker and incomplete reports become null", () => {
    expect(parseVerifyReport("")).toBeNull();
    expect(parseVerifyReport("random output without marker")).toBeNull();
    expect(parseVerifyReport("VERIFY_REPORT:{not json")).toBeNull();
    expect(parseVerifyReport('VERIFY_REPORT:{"ok":true}')).toBeNull();
  });

  test("valid failing report parses with ok:false", () => {
    const good = "VERIFY_REPORT:" + JSON.stringify({
      ok: false, mode: "normal", project: "p", runId: "r", artifactsKept: true,
      identity: null, identitySha256: null, payloadSha256: null,
      archiveSha256: null, archiveBytes: null,
      checks: [{ step: "s", status: "fail", detail: "d" }]
    });
    const parsed = parseVerifyReport(good);
    expect(parsed?.ok).toBe(false);
    expect(parsed?.checks[0]?.status).toBe("fail");
  });
});

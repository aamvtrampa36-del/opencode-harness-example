import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRILL_PROJECT_PREFIX, DRILL_ROOT_PATH, DRILL_SOURCE,
  assertCompatibleImage, assertManagedSnapshotImage, assertDrillProject, assertDrillRecordProject,
  assertMarkerIntegrity, assertSnapshotHandle, drillProjectNames,
  evaluateDrillChecks, hashText, parseDrillRecord, parseDrillReport,
  type DrillRecord
} from "./container-recovery";

const hasNode = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function drillRecord(overrides: Partial<DrillRecord> = {}): DrillRecord {
  const now = Date.now();
  return {
    version: 1,
    project: "snaprec-a-0123456789ab",
    runId: "0123456789abcdef",
    markerPath: "__drill-snaprec-a-0123456789ab-0123456789abcdef/marker.txt",
    markerContent: "opencode-snapshot-drill-v1|x|0123456789abcdef|" + "a".repeat(48),
    markerSha256: "1".repeat(64),
    mutatedSha256: "2".repeat(64),
    mutationFileSha256: "3".repeat(64),
    manifestSha256: "4".repeat(64),
    snapshotId: "snapshot-abc123",
    snapshotSavedAt: now,
    image: "sha256:" + "a".repeat(64),
    identitySha256: "5".repeat(64),
    createdAt: new Date(now).toISOString(),
    ...overrides
  };
}

function runDrill(env: Record<string, string>) {
  return spawnSync("node", ["--input-type=module", "-e", DRILL_SOURCE], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000
  });
}

describe("operación fuera del proyecto", () => {
  test("drill methods reject non-disposable projects", () => {
    expect(() => assertDrillProject("personal")).toThrow(/operación fuera del proyecto/);
    expect(() => assertDrillProject("repo-my-project")).toThrow(/operación fuera del proyecto/);
    expect(() => assertDrillProject(undefined)).toThrow();
    expect(() => assertDrillProject("snaprec-A-UPPERCASE")).toThrow();
    expect(assertDrillProject("snaprec-a-0123456789ab")).toBe("snaprec-a-0123456789ab");
  });

  test("drill record is bound to exactly one disposable project", () => {
    const record = drillRecord();
    expect(assertDrillRecordProject(record, record.project).runId).toBe(record.runId);
    expect(() => assertDrillRecordProject(record, "snaprec-b-0123456789ab"))
      .toThrow(/operación fuera del proyecto/);
    expect(() => assertDrillRecordProject(null, record.project))
      .toThrow(/operación fuera del proyecto/);
    expect(() => assertDrillRecordProject(
      drillRecord({ project: "personal" }), "personal"
    )).toThrow();
  });

  test("drill names require a 12 hex nonce", () => {
    expect(drillProjectNames("0123456789ab"))
      .toEqual({ creator: "snaprec-a-0123456789ab", restorer: "snaprec-b-0123456789ab" });
    expect(() => drillProjectNames("nothex")).toThrow();
    expect(() => drillProjectNames(undefined)).toThrow();
    expect(() => drillProjectNames("0123456789AB")).toThrow();
  });
});

describe("instantánea ausente o vencida", () => {
  const now = 1_800_000_000_000;
  test("missing handle refuses the restore (fail-closed, no blank image)", () => {
    expect(() => assertSnapshotHandle(undefined, now - 1000, now))
      .toThrow(/no tiene instantánea guardada/);
    expect(() => assertSnapshotHandle("", now - 1000, now)).toThrow();
    expect(() => assertSnapshotHandle("bad id with spaces", now - 1000, now)).toThrow();
  });
  test("expired handle beyond the 30-day TTL refuses the restore", () => {
    expect(() => assertSnapshotHandle("snapshot-abc", now - 30 * 24 * 3600_000, now))
      .toThrow(/venció/);
  });
  test("valid handle is accepted", () => {
    expect(assertSnapshotHandle("snapshot-abc", now - 5000, now))
      .toEqual({ id: "snapshot-abc", ageMs: 5000 });
  });
});

describe("rechazo de imagen diferente", () => {
  test("different digest is rejected", () => {
    expect(() => assertCompatibleImage("sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)))
      .toThrow(/Imagen incompatible/);
  });
  test("missing or malformed references are rejected", () => {
    expect(() => assertCompatibleImage(null, "sha256:" + "a".repeat(64))).toThrow();
    expect(() => assertCompatibleImage("sha256:" + "a".repeat(64), null)).toThrow();
    expect(() => assertCompatibleImage("sha256:truncated", "sha256:truncated")).toThrow();
    expect(() => assertCompatibleImage(undefined, undefined)).toThrow();
  });
  test("equal valid references are accepted", () => {
    const ref = "sha256:" + "a".repeat(64);
    expect(assertCompatibleImage(ref, ref)).toBe(ref);
  });
});

describe("Cloudflare-managed image aliases across snapshot restore", () => {
  const canonical = "registry.cloudflare.com/bb6aa21e251466eda5c5c076cabc69ef/cf/production/node-24-trixie@sha256:" + "a".repeat(64);
  test("accepts the platform-managed alias resolved to an immutable digest", () => {
    expect(assertManagedSnapshotImage("cloudflare/debian-trixie", canonical))
      .toBe("cloudflare-managed-alias");
    expect(assertManagedSnapshotImage(canonical, canonical)).toBe("exact-reference");
  });
  test("rejects unrelated image families or malformed digests", () => {
    expect(() => assertManagedSnapshotImage("cloudflare/debian-trixie", canonical.replace("/node-24-trixie", "/node-22-trixie"))).toThrow();
    expect(() => assertManagedSnapshotImage("cloudflare/debian-trixie", canonical.replace(/a+$/, "short"))).toThrow();
    expect(() => assertManagedSnapshotImage("cloudflare/debian-trixie", "ghcr.io/other@sha256:" + "a".repeat(64))).toThrow();
    expect(() => assertManagedSnapshotImage("sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64))).toThrow();
  });
});

describe("marcador alterado", () => {
  const anchor = "a".repeat(64);
  test("changed marker hash is rejected", () => {
    expect(() => assertMarkerIntegrity(anchor, "b".repeat(64), false))
      .toThrow(/no provino de la instantánea/);
    expect(() => assertMarkerIntegrity(anchor, null, false)).toThrow();
    expect(() => assertMarkerIntegrity(anchor, "short", false)).toThrow();
  });
  test("surviving post-snapshot mutation is rejected", () => {
    expect(() => assertMarkerIntegrity(anchor, anchor, true))
      .toThrow(/sobrevivieron/);
  });
  test("unchanged marker without mutation passes", () => {
    expect(() => assertMarkerIntegrity(anchor, anchor, false)).not.toThrow();
  });
});

describe("registro e informes fail-closed", () => {
  test("parseDrillRecord validates a complete record", () => {
    const record = drillRecord();
    expect(parseDrillRecord(record)?.snapshotId).toBe(record.snapshotId);
    expect(parseDrillRecord({ ...record, markerSha256: "short" })).toBeNull();
    expect(parseDrillRecord({ ...record, project: "personal" })).toBeNull();
    expect(parseDrillRecord({ ...record, version: 2 })).toBeNull();
    expect(parseDrillRecord(null)).toBeNull();
    expect(parseDrillRecord({ ...record, snapshotSavedAt: "nope" })).toBeNull();
  });
  test("evaluateDrillChecks demands every check to pass", () => {
    expect(evaluateDrillChecks([{ step: "x", status: "pass" }])).toBe(true);
    expect(evaluateDrillChecks([
      { step: "x", status: "pass" }, { step: "y", status: "fail" }
    ])).toBe(false);
    expect(evaluateDrillChecks([])).toBe(false);
  });
  test("parseDrillReport rejects malformed or wrong-phase reports", () => {
    const report = {
      ok: true, phase: "create", project: "snaprec-a-0123456789ab", runId: "0123456789abcdef",
      dir: DRILL_ROOT_PATH + "/__drill-x", markerRelPath: "d/marker.txt",
      markerContent: "content", markerBytes: 7, markerSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      identity: { os: "Debian", kernel: "k", node: "v24", arch: "x64" },
      identitySha256: "c".repeat(64),
      checks: [{ step: "marker-created", status: "pass" }]
    };
    expect(parseDrillReport("DRILL_REPORT:" + JSON.stringify(report), "create")?.ok).toBe(true);
    expect(parseDrillReport("DRILL_REPORT:" + JSON.stringify(report), "verify")).toBeNull();
    expect(parseDrillReport("no report here", "create")).toBeNull();
    expect(parseDrillReport("DRILL_REPORT:{broken", "create")).toBeNull();
    expect(parseDrillReport(
      "DRILL_REPORT:" + JSON.stringify({ ...report, project: "personal" }), "create"
    )).toBeNull();
    expect(parseDrillReport(
      "DRILL_REPORT:" + JSON.stringify({ ...report, checks: [] }), "create"
    )).toBeNull();
    expect(parseDrillReport(
      "DRILL_REPORT:" + JSON.stringify({ ...report, markerSha256: "x" }), "create"
    )).toBeNull();
  });
  test("hashText matches node crypto SHA-256 (real WebCrypto cross-check)", async () => {
    const content = "opencode-snapshot-drill-v1|probe|" + randomUUID();
    expect(await hashText(content)).toBe(sha(content));
  });
});

describe("in-container drill program (real execution)", () => {
  test("program refuses non-drill projects even when invoked directly", () => {
    if (!hasNode) throw new Error("node is required");
    const root = mkdtempSync(join(tmpdir(), "drill-refuse-"));
    try {
      const result = runDrill({
        DRILL_PROJECT: "personal", DRILL_RUN_ID: "0123456789abcdef",
        DRILL_ROOT: root, DRILL_PHASE: "create"
      });
      expect(result.status).not.toBe(0);
      const report = parseDrillReport(result.stdout ?? "", "create");
      expect(report?.ok ?? false).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("create/mutate/verify detects an altered marker (control negativo real)", () => {
    if (!hasNode) throw new Error("node is required");
    const root = mkdtempSync(join(tmpdir(), "drill-live-"));
    const project = "snaprec-a-" + randomUUID().replace(/-/g, "").slice(0, 12);
    const runId = randomUUID().replace(/-/g, "").slice(0, 16);
    try {
      const create = parseDrillReport(runDrill({
        DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_ROOT: root, DRILL_PHASE: "create"
      }).stdout ?? "", "create");
      expect(create?.ok).toBe(true);
      const markerPath = join(root, create!.markerRelPath);
      // Independent cross-check: the anchor equals the real file bytes.
      expect(create!.markerSha256).toBe(sha(readFileSync(markerPath)));
      expect(create!.markerContent.length).toBe(create!.markerBytes);

      const mutate = parseDrillReport(runDrill({
        DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_ROOT: root, DRILL_PHASE: "mutate"
      }).stdout ?? "", "mutate");
      expect(mutate?.ok).toBe(true);
      expect(mutate!.mutatedSha256).not.toBe(create!.markerSha256);
      expect(sha(readFileSync(markerPath))).toBe(mutate!.mutatedSha256);
      expect(existsSync(join(root, mutate!.mutationFileRelPath))).toBe(true);

      // A restore claiming the PRE-snapshot anchor must FAIL: the live disk
      // was mutated after the snapshot. Altered-marker negative control.
      const negative = runDrill({
        DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_ROOT: root, DRILL_PHASE: "verify",
        DRILL_EXPECT_SHA256: create!.markerSha256,
        DRILL_EXPECT_MANIFEST_SHA: create!.manifestSha256,
        DRILL_MUTATION_ABSENT: "1"
      });
      const negativeReport = parseDrillReport(negative.stdout ?? "", "verify");
      expect(negativeReport?.ok ?? true).toBe(false);
      expect(negative.status).not.toBe(0);
      expect(negativeReport?.checks.some((c) => c.status === "fail")).toBe(true);

      // The program reads the mutated disk correctly (marker hash equals the
      // mutated anchor) but still fails overall because the manifest keeps the
      // pre-snapshot anchor: a snapshot-consistent restore can never look like
      // the mutated disk. No synthetic PASS either way.
      const positive = runDrill({
        DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_ROOT: root, DRILL_PHASE: "verify",
        DRILL_EXPECT_SHA256: mutate!.mutatedSha256
      });
      const positiveReport = parseDrillReport(positive.stdout ?? "", "verify");
      expect(positiveReport?.markerSha256).toBe(mutate!.mutatedSha256);
      expect(positiveReport?.checks.find((c) => c.step === "marker-integrity")?.status).toBe("pass");
      expect(positiveReport?.ok ?? true).toBe(false);
      expect(positive.status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("pristine state (a real snapshot restore) passes all checks", () => {
    if (!hasNode) throw new Error("node is required");
    const root = mkdtempSync(join(tmpdir(), "drill-clean-"));
    const project = "snaprec-b-" + randomUUID().replace(/-/g, "").slice(0, 12);
    const runId = randomUUID().replace(/-/g, "").slice(0, 16);
    try {
      const create = parseDrillReport(runDrill({
        DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_ROOT: root, DRILL_PHASE: "create"
      }).stdout ?? "", "create");
      expect(create?.ok).toBe(true);
      const verify = runDrill({
        DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_ROOT: root, DRILL_PHASE: "verify",
        DRILL_EXPECT_SHA256: create!.markerSha256,
        DRILL_EXPECT_MANIFEST_SHA: create!.manifestSha256,
        DRILL_MUTATION_ABSENT: "1"
      });
      const report = parseDrillReport(verify.stdout ?? "", "verify");
      expect(verify.status).toBe(0);
      expect(report?.ok).toBe(true);
      expect(report?.markerSha256).toBe(create!.markerSha256);
      expect(report?.mutationPresent).toBe(false);
      expect(evaluateDrillChecks(report!.checks)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("prefix invariants", () => {
  test("every drill name is disposable and slug-valid", () => {
    const { creator, restorer } = drillProjectNames("ffffffffffff");
    expect(creator.startsWith(DRILL_PROJECT_PREFIX)).toBe(true);
    expect(restorer.startsWith(DRILL_PROJECT_PREFIX)).toBe(true);
    expect(creator).not.toBe(restorer);
    expect(creator.length).toBeLessThanOrEqual(40);
  });
});

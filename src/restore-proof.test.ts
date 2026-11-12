import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  assertRestoreProofFresh,
  evaluateRestoreProof,
  parseRestoreProofReport,
  FS_RESTORE_PROOF_SOURCE as FS_SOURCE,
  restoreProofFixtureName,
  runRestoreProofFixture,
  validateRestoreProofFixtureId,
  RESTORE_PROOF_DATUM_KEY,
  RESTORE_PROOF_PREFIX,
  RESTORE_PROOF_STATE_KEY,
  type RestoreProofContainer,
  type RestoreProofDatum,
  type RestoreProofFsReport,
  type RestoreProofIo
} from "./restore-proof";

const ID = "a1b2c3d4e5f60718";
const IMAGE = "sha256:" + "a".repeat(64);

function makeStorage(initial?: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    async get<T>(key: string): Promise<T | undefined> { return map.get(key) as T | undefined; },
    async put<T>(key: string, value: T): Promise<unknown> { map.set(key, value); return map; },
    async list(options?: { limit?: number }): Promise<Map<string, unknown>> {
      const entries = [...map.entries()];
      return new Map(options?.limit ? entries.slice(0, options.limit) : entries);
    },
    map
  };
}

type HarnessOptions = {
  inspectImage?: string;
  snapshotFails?: boolean;
  snapshotId?: string;
  destroyFails?: boolean;
  restoreFails?: boolean;
  restoreCorrupts?: boolean;
  restoreDropsFiles?: boolean;
  loseDatum?: boolean;
  alreadyRunning?: boolean;
  execExitCodes?: { prime?: number; verify?: number };
  execStdout?: { prime?: string; verify?: string };
};

function makeHarness(options: HarnessOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const root = mkdtempSync("/tmp/opencode/tmp/restore-proof-test-");
  let running = options.alreadyRunning === true;
  const storage = makeStorage();
  const markerDirs = () =>
    readdirSync(root).filter((name) => name.startsWith("__restore-proof-"))
      .map((name) => root + "/" + name);
  const container = {
    get running() { return running; },
    async exec(argv: readonly string[], execOptions?: { env?: Record<string, string> }) {
      calls.push({ method: "exec", args: [argv, execOptions?.env] });
      const mode = execOptions?.env?.RESTORE_PROOF_MODE === "verify" ? "verify" : "prime";
      if (options.execStdout?.[mode]) {
        return {
          output: async () => ({
            exitCode: options.execExitCodes?.[mode] ?? 0,
            stdout: new TextEncoder().encode(options.execStdout?.[mode] ?? ""),
            stderr: new Uint8Array()
          })
        };
      }
      const result = spawnSync("node", ["--input-type=module", "-e", String(argv[3])], {
        env: { ...process.env, ...(execOptions?.env ?? {}) },
        encoding: "buffer"
      });
      return {
        output: async () => ({
          exitCode: result.status,
          stdout: new Uint8Array(result.stdout ?? Buffer.alloc(0)),
          stderr: new Uint8Array(result.stderr ?? Buffer.alloc(0))
        })
      };
    },
    async inspect() {
      calls.push({ method: "inspect", args: [] });
      return { image: options.inspectImage ?? IMAGE };
    },
    async snapshotContainer(input: { name: string }) {
      calls.push({ method: "snapshotContainer", args: [input] });
      if (options.snapshotFails) throw new Error("snapshot unavailable");
      if (options.loseDatum) storage.map.delete(RESTORE_PROOF_DATUM_KEY);
      return { id: options.snapshotId ?? "snap-" + "b".repeat(60) };
    },
    async destroy(reason?: string) {
      calls.push({ method: "destroy", args: [reason] });
      if (options.destroyFails) throw new Error("destroy failed");
      running = false;
    },
    async start(startOptions: Record<string, unknown>) {
      calls.push({ method: "start", args: [startOptions] });
      if (startOptions.containerSnapshot) {
        if (options.restoreFails) throw new Error("snapshot restore failed");
        if (options.restoreDropsFiles) {
          for (const dir of markerDirs()) rmSync(dir, { recursive: true, force: true });
        }
        if (options.restoreCorrupts) {
          for (const dir of markerDirs()) {
            const path = dir + "/marker-payload.bin";
            writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("corrupted")]));
          }
        }
      }
      running = true;
    }
  } as unknown as RestoreProofContainer;
  const io: RestoreProofIo = { id: ID, storage, container, root };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { io, container, storage, calls, cleanup, markerDirs };
}

function primedDatum(overrides: Partial<RestoreProofDatum> = {}): RestoreProofDatum {
  return {
    version: "restore-proof-v1",
    runId: "0123456789abcdef",
    payloadSha256: "c".repeat(64),
    nonceSha256: "d".repeat(64),
    imageRef: IMAGE,
    at: 1000,
    ...overrides
  };
}

function fsReport(overrides: Partial<RestoreProofFsReport> = {}): RestoreProofFsReport {
  return {
    ok: true, mode: "verify", runId: "0123456789abcdef",
    payloadSha256: "c".repeat(64), nonceSha256: "d".repeat(64), bytes: 65536,
    checks: [{ step: "payload-sha256", status: "pass" }],
    ...overrides
  };
}

describe("restore-proof fixture identity", () => {
  test("accepts only a 16 hex character test-exclusive id", () => {
    expect(validateRestoreProofFixtureId(ID)).toBe(ID);
    expect(restoreProofFixtureName(ID)).toBe(RESTORE_PROOF_PREFIX + ID);
  });
  test("rejects real workspaces and every malformed id (fail closed)", () => {
    expect(() => validateRestoreProofFixtureId("personal")).toThrow();
    expect(() => validateRestoreProofFixtureId("project-v1:" + ID)).toThrow();
    expect(() => validateRestoreProofFixtureId(RESTORE_PROOF_PREFIX + ID)).toThrow();
    expect(() => validateRestoreProofFixtureId("a1b2c3d4e5f6071")).toThrow();
    expect(() => validateRestoreProofFixtureId("a1b2c3d4e5f607188")).toThrow();
    expect(() => validateRestoreProofFixtureId("A1B2C3D4E5F60718")).toThrow();
    expect(() => validateRestoreProofFixtureId(undefined)).toThrow();
    expect(() => validateRestoreProofFixtureId(1234)).toThrow();
  });
  test("the fixture name never collides with personal or project containers", () => {
    expect(restoreProofFixtureName(ID).startsWith("project-v1:")).toBe(false);
    expect(restoreProofFixtureName(ID)).not.toBe("personal");
  });
});

describe("restore-proof freshness", () => {
  test("accepts an empty DO", () => {
    expect(() => assertRestoreProofFresh([])).not.toThrow();
  });
  test("rejects any DO with prior state", () => {
    expect(() => assertRestoreProofFresh(["snapshotId"])).toThrow("estado previo");
    expect(() => assertRestoreProofFresh(["restore-proof-state"])).toThrow("estado previo");
  });
});

describe("restore-proof filesystem program (real node execution)", () => {
  const run = (env: Record<string, string>) => {
    const result = spawnSync("node", ["--input-type=module", "-e", FS_SOURCE], {
      env: { ...process.env, ...env }, encoding: "buffer"
    });
    return {
      exitCode: result.status,
      stdout: new TextDecoder().decode(result.stdout ?? Buffer.alloc(0)),
      stderr: new TextDecoder().decode(result.stderr ?? Buffer.alloc(0))
    };
  };

  test("prime writes marker files and anchors them with SHA-256", () => {
    const root = mkdtempSync("/tmp/opencode/tmp/restore-proof-prime-");
    try {
      const outcome = run({
        RESTORE_PROOF_MODE: "prime",
        RESTORE_PROOF_ROOT: root,
        RESTORE_PROOF_RUN_ID: ID
      });
      expect(outcome.exitCode).toBe(0);
      const report = parseRestoreProofReport(outcome.stdout);
      expect(report).not.toBeNull();
      expect(report?.ok).toBe(true);
      expect(report?.mode).toBe("prime");
      expect(report?.runId).toBe(ID);
      expect(report?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report?.nonceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report?.bytes).toBe(65536);
      const payload = readFileSync(root + "/__restore-proof-" + ID + "/marker-payload.bin");
      expect(payload.byteLength).toBe(65536);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("verify passes when the marker survives unchanged", () => {
    const root = mkdtempSync("/tmp/opencode/tmp/restore-proof-verify-");
    try {
      const prime = run({
        RESTORE_PROOF_MODE: "prime", RESTORE_PROOF_ROOT: root, RESTORE_PROOF_RUN_ID: ID
      });
      const report = parseRestoreProofReport(prime.stdout);
      const after = run({
        RESTORE_PROOF_MODE: "verify", RESTORE_PROOF_ROOT: root, RESTORE_PROOF_RUN_ID: ID,
        RESTORE_PROOF_EXPECT_PAYLOAD_SHA: report?.payloadSha256 ?? "",
        RESTORE_PROOF_EXPECT_NONCE_SHA: report?.nonceSha256 ?? ""
      });
      expect(after.exitCode).toBe(0);
      const verified = parseRestoreProofReport(after.stdout);
      expect(verified?.ok).toBe(true);
      expect(verified?.checks.every(c => c.status === "pass")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("verify fails closed when the payload was altered (negative control)", () => {
    const root = mkdtempSync("/tmp/opencode/tmp/restore-proof-tamper-");
    try {
      const prime = run({ RESTORE_PROOF_MODE: "prime", RESTORE_PROOF_ROOT: root, RESTORE_PROOF_RUN_ID: ID });
      const report = parseRestoreProofReport(prime.stdout);
      const marker = root + "/__restore-proof-" + ID + "/marker-payload.bin";
      writeFileSync(marker, Buffer.concat([readFileSync(marker), Buffer.from("tampered")]));
      const after = run({
        RESTORE_PROOF_MODE: "verify", RESTORE_PROOF_ROOT: root, RESTORE_PROOF_RUN_ID: ID,
        RESTORE_PROOF_EXPECT_PAYLOAD_SHA: report?.payloadSha256 ?? "",
        RESTORE_PROOF_EXPECT_NONCE_SHA: report?.nonceSha256 ?? ""
      });
      expect(after.exitCode).toBe(1);
      const verified = parseRestoreProofReport(after.stdout);
      expect(verified?.ok).toBe(false);
      expect(verified?.checks.some(c => c.step === "payload-sha256" && c.status === "fail")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("verify fails closed when marker files are missing", () => {
    const outcome = run({
      RESTORE_PROOF_MODE: "verify", RESTORE_PROOF_ROOT: "/tmp/opencode/tmp/no-such-root",
      RESTORE_PROOF_RUN_ID: ID,
      RESTORE_PROOF_EXPECT_PAYLOAD_SHA: "e".repeat(64),
      RESTORE_PROOF_EXPECT_NONCE_SHA: "f".repeat(64)
    });
    expect(outcome.exitCode).toBe(1);
    const verified = parseRestoreProofReport(outcome.stdout);
    expect(verified?.checks.some(c => c.step === "marker-present" && c.status === "fail")).toBe(true);
  });

  test("preflight rejects an unsafe root", () => {
    const outcome = run({ RESTORE_PROOF_MODE: "prime", RESTORE_PROOF_ROOT: "../escape", RESTORE_PROOF_RUN_ID: ID });
    expect(outcome.exitCode).toBe(1);
    expect(parseRestoreProofReport(outcome.stdout)?.checks[0]?.step).toBe("preflight");
  });
});

describe("restore-proof fail-closed evaluation", () => {
  const happy = () => evaluateRestoreProof({
    runId: "0123456789abcdef",
    snapshotId: "snap-" + "b".repeat(60),
    imageRefAfter: IMAGE,
    imageRefBefore: IMAGE,
    datum: primedDatum(),
    fs: fsReport()
  });

  test("the complete consistent world passes", () => {
    expect(happy()).toEqual({ ok: true, failures: [] });
  });

  test("missing or unusable snapshot id fails", () => {
    const noSnapshot = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: null,
      imageRefAfter: IMAGE, datum: primedDatum(), fs: fsReport()
    });
    expect(noSnapshot.ok).toBe(false);
    expect(noSnapshot.failures.some(f => f.includes("no hay snapshot compatible"))).toBe(true);
    const shortId = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "sn",
      imageRefAfter: IMAGE, datum: primedDatum(), fs: fsReport()
    });
    expect(shortId.ok).toBe(false);
  });

  test("unknown image digest fails; a changed image fails", () => {
    const unknown = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "snap-" + "b".repeat(60),
      imageRefAfter: null, datum: primedDatum(), fs: fsReport()
    });
    expect(unknown.failures.some(f => f.includes("image digest desconocido"))).toBe(true);
    const changed = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "snap-" + "b".repeat(60),
      imageRefAfter: "sha256:" + "9".repeat(64),
      imageRefBefore: IMAGE,
      datum: primedDatum(), fs: fsReport()
    });
    expect(changed.ok).toBe(false);
    expect(changed.failures.some(f => f.includes("cambió"))).toBe(true);
  });

  test("missing or foreign DO datum fails", () => {
    const missing = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "snap-" + "b".repeat(60),
      imageRefAfter: IMAGE, datum: null, fs: fsReport()
    });
    expect(missing.ok).toBe(false);
    expect(missing.failures.some(f => f.includes("DO storage falta"))).toBe(true);
    const foreign = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "snap-" + "b".repeat(60),
      imageRefAfter: IMAGE, datum: primedDatum({ runId: "ffffffffffffffff" }), fs: fsReport()
    });
    expect(foreign.failures.some(f => f.includes("otro ensayo"))).toBe(true);
  });

  test("unverifiable sha256 fails", () => {
    const mismatch = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "snap-" + "b".repeat(60),
      imageRefAfter: IMAGE, datum: primedDatum(), fs: fsReport({ payloadSha256: "e".repeat(64) })
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.failures.some(f => f.includes("marker no es verificable"))).toBe(true);
    const absent = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "snap-" + "b".repeat(60),
      imageRefAfter: IMAGE, datum: primedDatum({ payloadSha256: "c".repeat(64) }),
      fs: fsReport({ payloadSha256: null })
    });
    expect(absent.failures.some(f => f.includes("marker no es verificable"))).toBe(true);
  });

  test("unparseable or failed filesystem report fails", () => {
    const noReport = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "snap-" + "b".repeat(60),
      imageRefAfter: IMAGE, datum: primedDatum(), fs: null
    });
    expect(noReport.failures.some(f => f.includes("informe analizable"))).toBe(true);
    const failed = evaluateRestoreProof({
      runId: "0123456789abcdef", snapshotId: "snap-" + "b".repeat(60),
      imageRefAfter: IMAGE, datum: primedDatum(),
      fs: fsReport({ ok: false, checks: [{ step: "nonce-sha256", status: "fail" }] })
    });
    expect(failed.ok).toBe(false);
    expect(failed.failures.some(f => f.includes("verificación del filesystem falló"))).toBe(true);
  });
});

describe("restore-proof report parser", () => {
  test("returns null for garbage, truncated or incomplete reports", () => {
    expect(parseRestoreProofReport("")).toBeNull();
    expect(parseRestoreProofReport("RESTORE_PROOF_REPORT:{not json")).toBeNull();
    expect(parseRestoreProofReport('RESTORE_PROOF_REPORT:{"ok":true}')).toBeNull();
    expect(parseRestoreProofReport('RESTORE_PROOF_REPORT:{"ok":"yes","mode":"prime","runId":"' +
      ID + '","checks":[]}')).toBeNull();
  });
  test("accepts a well formed report", () => {
    const parsed = parseRestoreProofReport('RESTORE_PROOF_REPORT:' + JSON.stringify({
      ok: true, mode: "verify", runId: ID, payloadSha256: "c".repeat(64),
      nonceSha256: "d".repeat(64), bytes: 65536,
      checks: [{ step: "marker-present", status: "pass", detail: "ok" }]
    }));
    expect(parsed?.ok).toBe(true);
    expect(parsed?.checks[0]?.step).toBe("marker-present");
  });
});

describe("restore-proof fixture driver (fake Container, real filesystem program)", () => {
  test("full round trip: prime -> snapshot -> destroy -> snapshot restart -> verify", async () => {
    const harness = makeHarness();
    try {
      const report = await runRestoreProofFixture(harness.io);
      expect(report.ok).toBe(true);
      expect(report.liveProof).toBe("restore-round-trip");
      expect(report.datumVerified).toBe(true);
      expect(report.phase).toBe("verified");
      expect(report.snapshotId).toMatch(/^snap-/);
      expect(report.imageRef).toBe(IMAGE);
      expect(report.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
      // Contract: base boot carries the image; the snapshot restart MUST NOT.
      const starts = harness.calls.filter(c => c.method === "start");
      expect(starts.length).toBe(2);
      expect((starts[0].args[0] as Record<string, unknown>).image).toBe("cloudflare/debian-trixie");
      const restartArgs = starts[1].args[0] as Record<string, unknown>;
      expect("image" in restartArgs).toBe(false);
      expect((restartArgs.containerSnapshot as { id: string }).id).toBe(report.snapshotId);
      // The datum written before the restart is the one read after it.
      const datum = await harness.storage.get<RestoreProofDatum>(RESTORE_PROOF_DATUM_KEY);
      expect(datum?.payloadSha256).toBe(report.payloadSha256);
      expect(datum?.imageRef).toBe(IMAGE);
    } finally { harness.cleanup(); }
  });

  test("restore that loses marker files fails closed (negative control)", async () => {
    const harness = makeHarness({ restoreDropsFiles: true });
    try {
      const report = await runRestoreProofFixture(harness.io);
      expect(report.ok).toBe(false);
      expect(report.phase).toBe("failed");
      expect(report.liveProof).toBe("failed");
      expect(report.artifactsKept).toBe(true);
      expect(report.failures.join(" ")).toContain("filesystem falló");
    } finally { harness.cleanup(); }
  });

  test("restore that corrupts the payload fails closed (negative control)", async () => {
    const harness = makeHarness({ restoreCorrupts: true });
    try {
      const report = await runRestoreProofFixture(harness.io);
      expect(report.ok).toBe(false);
      expect(report.failures.join(" ")).toContain("filesystem falló");
    } finally { harness.cleanup(); }
  });

  test("missing DO datum after the restart fails closed", async () => {
    const harness = makeHarness({ loseDatum: true });
    try {
      const report = await runRestoreProofFixture(harness.io);
      expect(report.ok).toBe(false);
      expect(report.datumVerified).toBe(false);
      expect(report.failures.join(" ")).toContain("DO storage falta");
    } finally { harness.cleanup(); }
  });

  test("missing snapshot API fails closed before destroying anything", async () => {
    const harness = makeHarness();
    delete (harness.container as Record<string, unknown>).snapshotContainer;
    try {
      const report = await runRestoreProofFixture(harness.io);
      expect(report.ok).toBe(false);
      expect(report.failures.join(" ")).toContain("no hay snapshot compatible");
      expect(harness.calls.some(c => c.method === "destroy")).toBe(false);
    } finally { harness.cleanup(); }
  });

  test("unknown image digest fails closed", async () => {
    const harness = makeHarness({ inspectImage: "sha256:abc" });
    try {
      const report = await runRestoreProofFixture(harness.io);
      expect(report.ok).toBe(false);
      expect(report.failures.join(" ")).toContain("image digest desconocido");
    } finally { harness.cleanup(); }
  });

  test("a failed snapshot call fails closed", async () => {
    const harness = makeHarness({ snapshotFails: true });
    try {
      const report = await runRestoreProofFixture(harness.io);
      expect(report.ok).toBe(false);
      expect(report.phase).toBe("failed");
      expect(harness.calls.some(c => c.method === "destroy")).toBe(false);
    } finally { harness.cleanup(); }
  });

  test("a DO with prior state is rejected before any container interaction", async () => {
    const harness = makeHarness();
    harness.storage.map.set("snapshotId", "preexisting");
    try {
      expect(() => runRestoreProofFixture(harness.io)).toThrow();
      await expect(runRestoreProofFixture(harness.io)).rejects.toThrow("estado previo");
      expect(harness.calls.length).toBe(0);
    } finally { harness.cleanup(); }
  });

  test("a DO whose container is already running without state is left untouched", async () => {
    const harness = makeHarness({ alreadyRunning: true });
    try {
      await expect(runRestoreProofFixture(harness.io)).rejects.toThrow("en ejecución");
      expect(harness.calls.length).toBe(0);
    } finally { harness.cleanup(); }
  });

  test("the state machine resumes after eviction (destroy already done)", async () => {
    const harness = makeHarness();
    try {
      const first = await runRestoreProofFixture(harness.io);
      expect(first.ok).toBe(true);
      // Simulate an eviction that wiped in-flight memory but kept storage:
      // a second call on the terminal state returns the same verdict.
      const resumed = await runRestoreProofFixture(harness.io);
      expect(resumed.ok).toBe(true);
      expect(resumed.phase).toBe("verified");
      expect(resumed.runId).toBe(first.runId);
    } finally { harness.cleanup(); }
  });
});

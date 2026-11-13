import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./durable-backup";
import { RESTORE_PROJECT_SOURCE } from "./restore-project";
import {
  EXTBK_KEY_PREFIX, EXTBK_META_SCHEMA, EXTBK_MANIFEST_SCHEMA, EXTBK_PROJECT_PREFIX,
  EXTBK_SOURCE, assertArchiveIntegrity, assertExternalBackupProject, assertMetadataIntegrity,
  assertMissingRejected, assertR2Bucket, assertTamperRejected, buildExternalBackupManifest,
  buildTestTaskMetadata, canonicalDigest, canonicalJson, createTamperedProbe,
  deleteRunPrefix, downloadVerifiedBackup, externalBackupKeys, externalBackupProjectNames,
  externalBackupRunId, hashText, isOwnedExternalKey, parseExtBkManifest, parseExtBkReport, readCappedBytes,
  uploadExternalBackup,
  type ExtBkCreateReport, type ExtBkManifest, type R2LikeBucket
} from "./external-backup";
import {
  extBackupCleanup, extBackupCreate, extBackupCrossRestore, extBackupDestroyInstance,
  extBackupTamperProbe, type ExtBkHost
} from "./external-backup-do";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const RUN = "0123456789ab";
const CREATOR = "extbkc-a-" + RUN;
const RESTORER = "extbkc-b-" + RUN;

/** In-memory implementation of the exact R2 surface the drill uses,
 * including R2's put-side sha256 pin behavior. */
class MemoryR2Bucket implements R2LikeBucket {
  private store = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array, options?: { sha256?: string }) {
    if (options?.sha256) {
      const digest = await sha256Hex(value);
      if (digest !== options.sha256) throw new Error("Content sha256 mismatch (R2 put pin)");
    }
    this.store.set(key, value);
    return { key, size: value.length };
  }
  async get(key: string) {
    const value = this.store.get(key);
    if (!value) return null;
    return {
      key, size: value.length,
      arrayBuffer: async () => value.buffer.slice(
        value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
    };
  }
  async head(key: string) {
    const value = this.store.get(key);
    return value ? { key, size: value.length } : null;
  }
  async list(options: { prefix?: string; limit?: number }) {
    const prefix = options.prefix ?? "";
    const objects = [...this.store.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.length }));
    return { objects, truncated: false };
  }
  async delete(keys: string | readonly string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.store.delete(key);
  }
  keysIn(prefix: string): string[] {
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }
}

function extCreateReport(overrides: Partial<ExtBkCreateReport> = {}): ExtBkCreateReport {
  const content = "opencode-external-backup-v1|" + CREATOR + "|" + RUN + "|" + "a".repeat(48);
  return {
    ok: true, phase: "create", project: CREATOR, runId: RUN,
    identity: { os: "test", kernel: "test", node: "v24", arch: "x64" },
    identitySha256: "1".repeat(64),
    checks: [{ step: "preflight", status: "pass" }],
    dir: "/workspace/projects/" + CREATOR + "/__extbk-" + CREATOR + "-" + RUN,
    markerRelPath: "__extbk-" + CREATOR + "-" + RUN + "/marker.txt",
    markerContent: content,
    markerBytes: content.length,
    markerSha256: sha(Buffer.from(content, "utf8")),
    extManifestRelPath: "extbk-manifest.json",
    extManifestSha256: "2".repeat(64),
    ...overrides
  };
}

async function manifestFor(overrides: Partial<ExtBkManifest> = {}): Promise<ExtBkManifest> {
  const { manifest } = await buildExternalBackupManifest({
    report: extCreateReport(), archiveSha256: "3".repeat(64), archiveBytes: 1024
  });
  return { ...manifest, ...overrides };
}

describe("operación fuera del proyecto (guardas del ensayo externo)", () => {
  test("only disposable extbkc-* projects are accepted", () => {
    expect(() => assertExternalBackupProject("personal")).toThrow(/operación fuera del proyecto/);
    expect(() => assertExternalBackupProject("repo-my-project")).toThrow(/operación fuera del proyecto/);
    expect(() => assertExternalBackupProject("snaprec-a-0123456789ab")).toThrow(/operación fuera del proyecto/);
    expect(() => assertExternalBackupProject(undefined)).toThrow();
    expect(() => assertExternalBackupProject("extbkc-A-UPPERCASE")).toThrow();
    expect(assertExternalBackupProject(CREATOR)).toBe(CREATOR);
  });

  test("names and run ids require a 12 hex nonce", () => {
    expect(externalBackupProjectNames(RUN))
      .toEqual({ creator: CREATOR, restorer: RESTORER, runId: RUN });
    expect(() => externalBackupProjectNames("nothex")).toThrow();
    expect(() => externalBackupProjectNames("0123456789AB")).toThrow();
    expect(externalBackupRunId(RUN)).toBe(RUN);
    expect(() => externalBackupRunId("zzz")).toThrow();
  });

  test("keys stay inside one versioned prefix and reject traversal", () => {
    const keys = externalBackupKeys(RUN);
    for (const key of [keys.archive, keys.manifest, keys.tamperedArchive, keys.missingArchive]) {
      expect(key.startsWith(EXTBK_KEY_PREFIX + RUN + "/")).toBe(true);
      expect(isOwnedExternalKey(key)).toBe(true);
    }
    expect(isOwnedExternalKey("opencode-extbk-v1/zz/archive.tar.gz")).toBe(false);
    expect(isOwnedExternalKey("opencode-extbk-v1/../../etc/archive.tar.gz")).toBe(false);
    expect(isOwnedExternalKey("other-prefix/archive.tar.gz")).toBe(false);
    expect(isOwnedExternalKey(undefined)).toBe(false);
  });
});

describe("R2 binding ausente", () => {
  test("assertR2Bucket fails closed without simulating a bucket", () => {
    expect(() => assertR2Bucket(undefined, "test")).toThrow(/R2 binding no disponible/);
    expect(() => assertR2Bucket({}, "test")).toThrow(/R2 binding no disponible/);
    expect(() => assertR2Bucket({ put: async () => null }, "test")).toThrow(/R2 binding no disponible/);
    expect(assertR2Bucket(new MemoryR2Bucket(), "test")).toBeInstanceOf(MemoryR2Bucket);
  });
});

describe("metadatos de tarea/sesión de PRUEBA", () => {
  test("synthetic, versioned and clearly labeled as test data", () => {
    const meta = buildTestTaskMetadata(RUN);
    expect(meta.schema).toBe(EXTBK_META_SCHEMA);
    expect(meta.taskLabel).toBe("external-backup-drill");
    expect(meta.sessionRef).toBe("ses_extbk_" + RUN);
    expect(meta.sessionRef).toMatch(/^ses[A-Za-z0-9_]{1,64}$/);
    expect(meta.note).toContain("PRUEBA");
    expect(meta.note).toContain("no es una sesión real de OpenCode");
  });

  test("canonical JSON is order-stable and digests agree", async () => {
    const a = { b: 1, a: { d: [3, 2], c: 1 } };
    const b = { a: { c: 1, d: [3, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await canonicalDigest(a)).toBe(await canonicalDigest(b));
  });
});

describe("manifiesto: contrato estricto", () => {
  test("parses a valid manifest", async () => {
    const manifest = await manifestFor();
    expect(manifest.schema).toBe(EXTBK_MANIFEST_SCHEMA);
    expect(manifest.project).toBe(CREATOR);
    expect(manifest.archiveKey).toBe(externalBackupKeys(RUN).archive);
    expect(parseExtBkManifest(manifest)).not.toBeNull();
    await expect(assertMetadataIntegrity(manifest)).resolves.toBeUndefined();
  });

  test("rejects malformed manifests instead of guessing", async () => {
    const manifest = await manifestFor();
    expect(parseExtBkManifest(null)).toBeNull();
    expect(parseExtBkManifest({ ...manifest, schema: "other.v1" })).toBeNull();
    expect(parseExtBkManifest({ ...manifest, project: "personal" })).toBeNull();
    expect(parseExtBkManifest({ ...manifest, project: "extbkc-a-" + RUN, archiveKey: "opencode-extbk-v1/other/archive.tar.gz" })).toBeNull();
    expect(parseExtBkManifest({ ...manifest, archiveBytes: 0 })).toBeNull();
    expect(parseExtBkManifest({ ...manifest, archiveBytes: 3 * 1024 * 1024 })).toBeNull();
    expect(parseExtBkManifest({ ...manifest, archiveSha256: "nothex" })).toBeNull();
    expect(parseExtBkManifest({ ...manifest, markerRelPath: "../escape" })).toBeNull();
    const badMeta = { ...manifest, metadata: { ...manifest.metadata, sessionRef: "not-a-session" } };
    expect(parseExtBkManifest(badMeta)).toBeNull();
  });

  test("altered metadata is rejected by its digest", async () => {
    const manifest = await manifestFor();
    const altered: ExtBkManifest = {
      ...manifest,
      metadata: { ...manifest.metadata, note: "texto alterado" }
    };
    await expect(assertMetadataIntegrity(altered)).rejects.toThrow(/alteración detectada/);
  });
});

describe("round trip REAL: crear → R2 (stub) → perder origen → restaurar → verificar", () => {
  test("archive, metadata and digests survive into a new project", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-extbk-src-"));
    const root2 = mkdtempSync(join(tmpdir(), "opencode-extbk-dst-"));
    const bucket = new MemoryR2Bucket();
    let archiveFile = "";
    try {
      // Phase 1: REAL in-container program creates marker + manifest.
      const proc = Bun.spawnSync(
        ["node", "--input-type=module", "-e", EXTBK_SOURCE],
        { env: { ...process.env, EXT_PHASE: "create", EXT_PROJECT: CREATOR,
          EXT_RUN_ID: RUN, EXT_SOURCE_ROOT: root } });
      expect(proc.exitCode).toBe(0);
      const stdout = new TextDecoder().decode(proc.stdout);
      const report = parseExtBkReport(stdout, "create");
      expect(report?.ok).toBe(true);
      if (!report) throw new Error("informe create no analizable");
      expect(report.project).toBe(CREATOR);
      // DO-side double anchor of the marker.
      expect(await hashText(report.markerContent)).toBe(report.markerSha256);

      // The same tar layout the preview /__archive endpoint produces.
      archiveFile = join(root, "archive.tar.gz");
      const tar = Bun.spawnSync(["tar", "-czf", archiveFile, "-C", root, CREATOR]);
      expect(tar.exitCode).toBe(0);
      const bytes = new Uint8Array(readFileSync(archiveFile));
      const archiveSha256 = await sha256Hex(bytes);
      expect(bytes[0]).toBe(0x1f); expect(bytes[1]).toBe(0x8b);

      // Phase 2: commit-ordered upload (archive first, manifest LAST).
      const { manifest, manifestSha256 } = await buildExternalBackupManifest({
        report, archiveSha256, archiveBytes: bytes.length
      });
      await uploadExternalBackup(bucket, manifest, manifestSha256, bytes);
      const keys = externalBackupKeys(RUN);
      expect(bucket.keysIn(EXTBK_KEY_PREFIX)).toEqual(
        expect.arrayContaining([keys.archive, keys.manifest]));

      // Phase 3: the source tree is DESTROYED (simulated loss of the
      // creator instance); only the R2 copy remains.
      rmSync(join(root, CREATOR), { recursive: true, force: true });
      rmSync(archiveFile, { force: true });
      expect(existsSync(join(root, CREATOR))).toBe(false);

      // Phase 4: download + verify digest chain from the external store.
      const verified = await downloadVerifiedBackup(bucket, RUN, manifestSha256);
      expect(verified.archiveBytes).toEqual(bytes);
      expect(canonicalJson(verified.manifest)).toBe(canonicalJson(manifest));

      // Phase 5: REAL restore program into a fresh target tree.
      const restore = Bun.spawnSync(
        ["node", "--input-type=module", "-e", RESTORE_PROJECT_SOURCE, CREATOR, RESTORER],
        { stdin: verified.archiveBytes,
          env: { ...process.env, G4_RESTORE_TEST_ROOT: root2 } });
      expect(restore.exitCode).toBe(0);
      const receipt = JSON.parse(new TextDecoder().decode(restore.stdout)) as {
        source: string; target: string; files: number; sha256: string; bytes: number;
      };
      expect(receipt.source).toBe(CREATOR);
      expect(receipt.target).toBe(RESTORER);
      expect(receipt.files).toBeGreaterThanOrEqual(2);
      expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);

      // Phase 6: REAL in-container verify of the restored anchors.
      const verify = Bun.spawnSync(
        ["node", "--input-type=module", "-e", EXTBK_SOURCE],
        { env: { ...process.env, EXT_PHASE: "verify", EXT_PROJECT: RESTORER,
          EXT_SOURCE_PROJECT: CREATOR, EXT_RUN_ID: RUN, EXT_SOURCE_ROOT: root2,
          EXT_EXPECT_MARKER_SHA256: manifest.markerSha256,
          EXT_EXPECT_MANIFEST_SHA256: manifest.extManifestSha256 } });
      expect(verify.exitCode).toBe(0);
      const verifyReport = parseExtBkReport(new TextDecoder().decode(verify.stdout), "verify");
      expect(verifyReport?.ok).toBe(true);
      expect(verifyReport?.markerSha256).toBe(manifest.markerSha256);
      expect(verifyReport?.extManifestOk).toBe(true);
      expect(await hashText(readFileSync(join(root2, RESTORER, manifest.markerRelPath), "utf8")))
        .toBe(manifest.markerSha256);

      // Negative controls through the SAME store.
      const probe = await createTamperedProbe(bucket, RUN);
      expect(probe.key).toBe(externalBackupKeys(RUN).tamperedArchive);
      const tamper = await assertTamperRejected(bucket, RUN, manifest);
      expect(tamper.rejectedAsExpected).toBe(true);
      expect(tamper.alteredSha256).not.toBe(manifest.archiveSha256);
      expect(tamper.originalIntact).toBe(true);
      const missing = await assertMissingRejected(bucket, RUN);
      expect(missing.rejectedAsExpected).toBe(true);

      // Cleanup removes ONLY the run keys; other objects survive untouched.
      await bucket.put("foreign-bucket-key", new Uint8Array([1, 2, 3]));
      await bucket.put(EXTBK_KEY_PREFIX + "other/archive.tar.gz", new Uint8Array([4, 5, 6]));
      const cleaned = await deleteRunPrefix(bucket, RUN);
      expect(cleaned.deleted).toBe(3); // archive + manifest + tampered probe
      expect(bucket.keysIn(EXTBK_KEY_PREFIX + RUN)).toEqual([]);
      expect((await bucket.head("foreign-bucket-key"))?.size).toBe(3);
      expect(bucket.keysIn(EXTBK_KEY_PREFIX + "other")).toEqual(
        [EXTBK_KEY_PREFIX + "other/archive.tar.gz"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe("subidas, límites y atomicidad", () => {
  test("put-side sha256 pin rejects altered upload (R2 behavior mirrored)", async () => {
    const bucket = new MemoryR2Bucket();
    await expect(bucket.put("k", new Uint8Array([1, 2, 3]), { sha256: sha(Buffer.from([9])) }))
      .rejects.toThrow(/sha256 mismatch/);
  });

  test("archive without manifest is NOT restorable (manifest is the commit point)", async () => {
    const bucket = new MemoryR2Bucket();
    const bytes = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
    await bucket.put(externalBackupKeys(RUN).archive, bytes);
    await expect(downloadVerifiedBackup(bucket, RUN, "f".repeat(64)))
      .rejects.toThrow(/AUSENTE/);
  });

  test("hand-off digest mismatch rejects the manifest", async () => {
    const bucket = new MemoryR2Bucket();
    const bytes = new Uint8Array([0x1f, 0x8b, 7, 7, 7]);
    const { manifest, manifestSha256 } = await buildExternalBackupManifest({
      report: extCreateReport(), archiveSha256: await sha256Hex(bytes), archiveBytes: bytes.length
    });
    await uploadExternalBackup(bucket, manifest, manifestSha256, bytes);
    const wrong = "e".repeat(64);
    await expect(downloadVerifiedBackup(bucket, RUN, wrong)).rejects.toThrow(/handoff alterado/);
    // The legitimate digest still works end-to-end.
    const ok = await downloadVerifiedBackup(bucket, RUN, manifestSha256);
    expect(ok.manifest.runId).toBe(RUN);
  });

  test("altered archive bytes are rejected by the digest check", async () => {
    const manifest = await manifestFor({ archiveBytes: 5 });
    const altered = new Uint8Array([0x1f, 0x8b, 1, 2, 4]);
    await expect(assertArchiveIntegrity(altered, manifest)).rejects.toThrow(/SHA-256/);
    await expect(assertArchiveIntegrity(new Uint8Array([1, 2, 3]), manifest))
      .rejects.toThrow(/gzip válido/);
  });

  test("readCappedBytes enforces the archive byte cap", async () => {
    const big = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(big); controller.close(); }
    });
    expect((await readCappedBytes(stream, 128 * 1024, "prueba")).length).toBe(64 * 1024);
    const stream2 = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(big); controller.enqueue(big); controller.close(); }
    });
    await expect(readCappedBytes(stream2, 64 * 1024, "prueba")).rejects.toThrow(/límite/);
  });
});

describe("glue DO: guardas fail-closed con host falso", () => {
  function fakeHost(overrides: Partial<Record<string, unknown>> = {}): ExtBkHost {
    const store = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => { store.set(key, value); },
      delete: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        let deleted = 0;
        for (const key of list) if (store.delete(key)) deleted++;
        return deleted;
      },
      setAlarm: async () => undefined
    };
    return {
      ctx: { storage, container: undefined },
      ensureRunning: async () => { throw new Error("no container in unit tests"); },
      download: async () => { throw new Error("no download in unit tests"); },
      busy: 0,
      commandQueue: Promise.resolve(),
      ...overrides
    } as unknown as ExtBkHost;
  }

  test("create refuses a missing R2 binding BEFORE touching any container", async () => {
    let ensureCalled = false;
    const host = fakeHost({
      ensureRunning: async () => { ensureCalled = true; throw new Error("must not run"); }
    });
    await expect(extBackupCreate(host, undefined, CREATOR, RUN))
      .rejects.toThrow(/R2 binding no disponible/);
    expect(ensureCalled).toBe(false);
  });

  test("create refuses foreign slugs and duplicate records", async () => {
    const bucket = new MemoryR2Bucket();
    await expect(extBackupCreate(fakeHost(), bucket, "personal", RUN))
      .rejects.toThrow(/operación fuera del proyecto/);
    const host = fakeHost();
    await host.ctx.storage.put("extbk-record-v1", { project: CREATOR });
    await expect(extBackupCreate(host, bucket, CREATOR, RUN))
      .rejects.toThrow(/nonce nuevo/);
  });

  test("destroy refuses without OUR record; cleanup reports zero records", async () => {
    await expect(extBackupDestroyInstance(fakeHost(), CREATOR))
      .rejects.toThrow(/no se destruye ninguna instancia \(fail-closed\)/);
    const stranger = fakeHost();
    await stranger.ctx.storage.put("extbk-record-v1", { project: "extbkc-a-other123456", runId: "other123456" });
    await expect(extBackupDestroyInstance(stranger, CREATOR))
      .rejects.toThrow(/no se destruye ninguna instancia/);
    const cleaned = await extBackupCleanup(fakeHost(), CREATOR);
    expect(cleaned.containerDestroyed).toBe(false);
    expect(cleaned.recordsDeleted).toBe(0);
    await expect(extBackupCleanup(fakeHost(), "personal")).rejects.toThrow(/operación fuera del proyecto/);
  });

  test("cross-restore refuses foreign manifest, same DO and handoff tampering", async () => {
    const bucket = new MemoryR2Bucket();
    const manifest = await manifestFor();
    const digest = await canonicalDigest(manifest);
    // A distinct restorer proceeds into the queue; with an empty store the
    // download fails closed and the OUTCOME (not a thrown error) reports it.
    const foreign = await extBackupCrossRestore(fakeHost(), bucket, "extbkc-b-other123456",
      manifest, digest);
    expect(foreign.ok).toBe(false);
    expect(foreign.metadataRoundTrip).toBe("failed");
    expect(foreign.error).toMatch(/AUSENTE/);
    await expect(extBackupCrossRestore(fakeHost(), bucket, CREATOR, manifest, digest))
      .rejects.toThrow(/distinto del creador/);
    await expect(extBackupCrossRestore(fakeHost(), bucket, RESTORER,
      { ...manifest, archiveSha256: "4".repeat(64) }, digest))
      .rejects.toThrow(/no coincide con el digest esperado/);
    await expect(extBackupCrossRestore(fakeHost(), bucket, RESTORER, manifest, "d".repeat(64)))
      .rejects.toThrow(/digest esperado/);
    await expect(extBackupCrossRestore(fakeHost(), undefined, RESTORER, manifest, digest))
      .rejects.toThrow(/R2 binding no disponible/);
  });

  test("tamper and missing probes reject invalid inputs before touching R2", async () => {
    await expect(extBackupDestroyInstance(fakeHost(), CREATOR)).rejects.toThrow();
    const bucket = new MemoryR2Bucket();
    await expect(extBackupTamperProbeCall(fakeHost(), bucket)).rejects.toThrow(/manifiesto/);
  });

  async function extBackupTamperProbeCall(host: ExtBkHost, bucket: R2LikeBucket) {
    return extBackupTamperProbe(host, bucket, CREATOR, RUN, { schema: "bogus" });
  }
});

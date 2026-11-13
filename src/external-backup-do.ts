/**
 * Durable Object side of the external R2 backup and cross-restore drill.
 * Explicit DevContainer RPC methods (declared in src/dev-container.ts)
 * delegate here; there is no prototype mutation. Only disposable
 * "extbkc-*" Durable Objects and throwaway "opencode-extbk-v1/<runId>/"
 * R2 keys are ever touched; the personal DO and its data are unreachable.
 *
 * Phase map (one Workflow invocation, steps with retries disabled):
 *   1. extBackupCreate        creator DO: marker + test metadata + tar.gz
 *                             (preview /__archive path, same as saveBackup),
 *                             digest double-anchored container/DO, upload to
 *                             R2 (archive first, manifest LAST = commit).
 *   2. extBackupDestroyInstance: destroy ONLY this disposable Container
 *                             (guarded by the record persisted in step 1).
 *   3. extBackupCrossRestore  restorer DO: downloads manifest+archive from
 *                             R2 (never from the creator DO), re-verifies
 *                             digests and metadata, restores with the
 *                             preexisting RESTORE_PROJECT_SOURCE program and
 *                             re-anchors marker/manifest SHA-256 in-container.
 *   4. extBackupTamperProbe   altered bytes at a throwaway key are rejected;
 *                             the original object stays intact.
 *   5. extBackupMissingProbe  a key that was never written fails closed.
 *   6. extBackupCleanup + deleteRunPrefix: containers destroyed, DO evidence
 *                             keys dropped, every run key removed from R2.
 */
import { MAX_ARCHIVE_BYTES, sha256Hex } from "./durable-backup";
import {
  EXTBK_SOURCE, EXTBK_SOURCE_ROOT,
  assertArchiveIntegrity, assertExternalBackupProject, assertMissingRejected,
  assertR2Bucket, assertTamperRejected, buildExternalBackupManifest,
  canonicalDigest, canonicalJson, createTamperedProbe, deleteRunPrefix,
  downloadVerifiedBackup, evaluateExtChecks, externalBackupKeys, externalBackupRunId,
  hashText, parseExtBkManifest, parseExtBkReport, readCappedBytes, uploadExternalBackup,
  type ExtBkCheck, type ExtBkCreateReport, type ExtBkManifest, type R2LikeBucket
} from "./external-backup";
import { RESTORE_PROJECT_SOURCE } from "./restore-project";

/** Structural view of the DevContainer the drill binds to. */
export type ExtBkHost = {
  ctx: DurableObjectState;
  ensureRunning(): Promise<NonNullable<DurableObjectState["container"]>>;
  /** Streamed tar.gz of the project (preview /__archive path, proven in saveBackup). */
  download(project: string): Promise<Response>;
  busy: number;
  commandQueue: Promise<void>;
};

type ExtBkContainer = NonNullable<DurableObjectState["container"]>;

export type ExtBkRecord = {
  version: 1;
  project: string;
  runId: string;
  manifestSha256: string;
  archiveSha256: string;
  archiveBytes: number;
  keys: { archive: string; manifest: string };
  containerIdentitySha256: string | null;
  uploadedAt: string;
};

export type ExtBkCreateResult = {
  record: ExtBkRecord;
  manifest: ExtBkManifest;
  manifestSha256: string;
  r2: { archive: string; manifest: string; archiveBytes: number; headsVerified: boolean };
};

export type ExtBkDestroyResult = {
  wasRunning: boolean;
  destroyedInstance: boolean;
  project: string;
  runId: string;
  recordManifestSha256: string;
};

export type ExtBkRestoreOutcome = {
  ok: boolean;
  phase: "restore-cross-do";
  project: string;
  runId: string;
  checks: ExtBkCheck[];
  restoredReceipt?: { source: string; target: string; files: number; sha256: string; bytes: number };
  r2: { archiveKey: string; manifestKey: string; archiveSha256: string };
  metadataRoundTrip: "verified" | "failed";
  error?: string;
};

export type ExtBkProbeOutcome = {
  rejectedAsExpected: boolean;
  reason: string;
  alteredSha256?: string;
  originalIntact?: boolean;
  error?: string;
};

export type ExtBkCleanupResult = {
  project: string;
  containerDestroyed: boolean;
  recordsDeleted: number;
};

const EXTBK_RECORD_KEY = "extbk-record-v1";
const EXTBK_RESULT_KEY = "extbk-result-v1";
// Mirrors the module-private lifecycle constants of src/dev-container.ts.
const EXTBK_INACTIVITY_MS = 15 * 60_000;
const EXTBK_CHECK_MS = 60_000;

function sleepExt(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilExt(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Tiempo de espera agotado en el ensayo de respaldo externo");
    }
    await sleepExt(250);
  }
}

async function execExt(
  container: ExtBkContainer,
  phase: "create" | "verify",
  env: Record<string, string>
): Promise<{ stdout: string; exitCode: number | null }> {
  const handle = await container.exec(
    ["node", "--input-type=module", "-e", EXTBK_SOURCE],
    { env, signal: AbortSignal.timeout(120_000) }
  );
  const output = await handle.output();
  return { stdout: new TextDecoder().decode(output.stdout), exitCode: output.exitCode };
}

/** Same serialization as run(): shell writes and drill phases never overlap. */
async function withExtBkQueue<T>(host: ExtBkHost, body: () => Promise<T>): Promise<T> {
  const queued = host as ExtBkHost & { busy: number; commandQueue: Promise<void> };
  const previous = queued.commandQueue;
  let release = () => {};
  queued.commandQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await body(); } finally { release(); }
}

async function touch(host: ExtBkHost): Promise<void> {
  await host.ctx.storage.put("lastActivity", Date.now());
  await host.ctx.storage.setAlarm(Date.now() + EXTBK_CHECK_MS);
}

/**
 * Phase 1 (creator DO): unique marker + SYNTHETIC test task metadata inside
 * the disposable project dir; archive via the proven /__archive streaming
 * path capped at MAX_ARCHIVE_BYTES; SHA-256 double anchor (container report
 * vs DO-side recompute); commit-ordered upload to R2. The persisted record
 * is what later AUTHORIZES destroying only this disposable instance.
 */
export async function extBackupCreate(
  host: ExtBkHost, rawBucket: unknown, project: string, runId: string
): Promise<ExtBkCreateResult> {
  const id = assertExternalBackupProject(project);
  const rid = externalBackupRunId(runId);
  const bucket = assertR2Bucket(rawBucket, "DevContainer.extBackupCreate");
  if (await host.ctx.storage.get(EXTBK_RECORD_KEY)) {
    throw new Error("Este Durable Object desechable ya tiene un respaldo externo; usa un nonce nuevo");
  }
  return await withExtBkQueue(host, async () => {
    const container = await host.ensureRunning();
    host.busy++;
    try {
      const createOut = await execExt(container, "create", {
        EXT_PHASE: "create", EXT_PROJECT: id, EXT_RUN_ID: rid,
        EXT_SOURCE_ROOT: EXTBK_SOURCE_ROOT
      });
      const report: ExtBkCreateReport | null = parseExtBkReport(createOut.stdout, "create");
      if (!report || !report.ok || createOut.exitCode !== 0 ||
          report.project !== id || report.runId !== rid) {
        throw new Error("El ensayo no pudo crear el marcador aislado (create falló o informe inválido)");
      }
      // Double anchor: the Durable Object recomputes the marker hash.
      if ((await hashText(report.markerContent)) !== report.markerSha256) {
        throw new Error("El SHA-256 del marcador difiere entre container y Durable Object");
      }
      // Archive through the proven preview /__archive path (same as saveBackup).
      const archive = await host.download(id);
      if (!archive.ok || !archive.body) throw new Error("No se pudo archivar el proyecto de prueba");
      const bytes = await readCappedBytes(
        archive.body as unknown as ReadableStream<Uint8Array>, MAX_ARCHIVE_BYTES,
        "El archivo del proyecto de prueba");
      const archiveSha256 = await sha256Hex(bytes);
      const { manifest, manifestSha256 } = await buildExternalBackupManifest({
        report, archiveSha256, archiveBytes: bytes.length
      });
      const heads = await uploadExternalBackup(bucket, manifest, manifestSha256, bytes);
      const keys = externalBackupKeys(rid);
      const record: ExtBkRecord = {
        version: 1, project: id, runId: rid, manifestSha256,
        archiveSha256, archiveBytes: bytes.length,
        keys: { archive: keys.archive, manifest: keys.manifest },
        containerIdentitySha256: report.identitySha256,
        uploadedAt: new Date().toISOString()
      };
      await host.ctx.storage.put(EXTBK_RECORD_KEY, record);
      return {
        record, manifest, manifestSha256,
        r2: { archive: keys.archive, manifest: keys.manifest,
          archiveBytes: bytes.length,
          headsVerified: heads.archiveHead === bytes.length }
      };
    } finally {
      host.busy--;
      await touch(host);
    }
  });
}

/**
 * Phase 2 (creator DO): destroy ONLY this disposable instance. Fail-closed:
 * without OUR persisted record the method refuses to destroy anything, so
 * the personal DO (or any imported project DO) can never be destroyed here.
 */
export async function extBackupDestroyInstance(host: ExtBkHost, project: string): Promise<ExtBkDestroyResult> {
  const id = assertExternalBackupProject(project);
  return await withExtBkQueue(host, async () => {
    const record = await host.ctx.storage.get<ExtBkRecord>(EXTBK_RECORD_KEY);
    if (!record || record.project !== id) {
      throw new Error("Este Durable Object no tiene un respaldo externo confirmado; " +
        "no se destruye ninguna instancia (fail-closed)");
    }
    const container = host.ctx.container;
    const wasRunning = Boolean(container?.running);
    if (container?.running) {
      await container.destroy("opencode-extbk-drill");
      await waitUntilExt(() => !container.running, 15_000);
    }
    return {
      wasRunning, destroyedInstance: wasRunning, project: id, runId: record.runId,
      recordManifestSha256: record.manifestSha256
    };
  });
}

/**
 * Phase 3 (restorer DO): a DIFFERENT Durable Object downloads the backup
 * from R2 (never from the creator DO), re-verifies the hand-off digest,
 * manifest contract, metadata hash and archive digest, restores with the
 * preexisting RESTORE_PROJECT_SOURCE program, then re-anchors the marker
 * and in-archive manifest SHA-256 INSIDE the restored container. The R2
 * copy must equal the hand-off manifest byte-for-byte (canonical form).
 */
export async function extBackupCrossRestore(
  host: ExtBkHost, rawBucket: unknown, project: string,
  rawManifest: unknown, expectedManifestSha256: string
): Promise<ExtBkRestoreOutcome> {
  const id = assertExternalBackupProject(project);
  const bucket = assertR2Bucket(rawBucket, "DevContainer.extBackupCrossRestore");
  const handoff = parseExtBkManifest(rawManifest);
  if (!handoff) {
    throw new Error("El manifiesto recibido del ensayo no es válido (handoff alterado)");
  }
  if (handoff.project === id) {
    throw new Error("La restauración cruzada requiere un Durable Object distinto del creador");
  }
  if ((await canonicalDigest(handoff)) !== expectedManifestSha256) {
    throw new Error("El manifiesto del handoff no coincide con el digest esperado (restauración rechazada)");
  }
  return await withExtBkQueue(host, async () => {
    const outcome: ExtBkRestoreOutcome = {
      ok: false, phase: "restore-cross-do", project: id, runId: handoff.runId,
      checks: [], r2: { archiveKey: handoff.archiveKey, manifestKey: handoff.manifestKey,
        archiveSha256: handoff.archiveSha256 },
      metadataRoundTrip: "failed"
    };
    try {
      const verified = await downloadVerifiedBackup(bucket, handoff.runId, expectedManifestSha256);
      if (canonicalJson(verified.manifest) !== canonicalJson(handoff)) {
        throw new Error("La copia R2 del manifiesto difiere del handoff del ensayo");
      }
      const container = await host.ensureRunning();
      host.busy++;
      try {
        const stdin = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(verified.archiveBytes); controller.close(); }
        });
        const process = await container.exec(
          ["node", "--input-type=module", "-e", RESTORE_PROJECT_SOURCE,
            verified.manifest.project, id], { stdin });
        const output = await process.output();
        if (output.exitCode !== 0) {
          throw new Error("Restauración rechazada: " +
            new TextDecoder().decode(output.stderr).slice(-350));
        }
        const receipt = JSON.parse(new TextDecoder().decode(output.stdout)) as {
          source: string; target: string; files: number; sha256: string; bytes: number;
        };
        if (receipt.source !== verified.manifest.project || receipt.target !== id ||
            !Number.isSafeInteger(receipt.files) || receipt.files < 2 ||
            !/^[a-f0-9]{64}$/.test(receipt.sha256)) {
          throw new Error("Recibo de restauración inválido");
        }
        const verifyOut = await execExt(container, "verify", {
          EXT_PHASE: "verify", EXT_PROJECT: id, EXT_RUN_ID: verified.manifest.runId,
          EXT_SOURCE_PROJECT: verified.manifest.project, EXT_SOURCE_ROOT: EXTBK_SOURCE_ROOT,
          EXT_EXPECT_MARKER_SHA256: verified.manifest.markerSha256,
          EXT_EXPECT_MANIFEST_SHA256: verified.manifest.extManifestSha256
        });
        const report = parseExtBkReport(verifyOut.stdout, "verify");
        if (!report || !report.ok || verifyOut.exitCode !== 0 ||
            report.markerSha256 !== verified.manifest.markerSha256 || !report.extManifestOk) {
          throw new Error("Los anclajes SHA-256 del contenido restaurado no coinciden");
        }
        if (!evaluateExtChecks(report.checks)) {
          throw new Error("Checks del ensayo incompletos o fallidos");
        }
        outcome.checks = report.checks;
        outcome.restoredReceipt = receipt;
        outcome.metadataRoundTrip = "verified";
        outcome.ok = true;
      } finally {
        host.busy--;
        await touch(host);
      }
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : "restauración externa desconocida";
    }
    await host.ctx.storage.put(EXTBK_RESULT_KEY, outcome);
    return outcome;
  });
}

/**
 * Negative control (restorer DO): altered bytes stored under the run's
 * throwaway key must be rejected by the digest check, and the original
 * object must stay intact. The full verified-download path is exercised
 * against the tampered copy as well: it must throw before any restore.
 */
export async function extBackupTamperProbe(
  host: ExtBkHost, rawBucket: unknown, project: string,
  runId: string, manifest: unknown
): Promise<ExtBkProbeOutcome> {
  const id = assertExternalBackupProject(project);
  const bucket = assertR2Bucket(rawBucket, "DevContainer.extBackupTamperProbe");
  const rid = externalBackupRunId(runId);
  const parsed = parseExtBkManifest(manifest);
  if (!parsed || parsed.runId !== rid) {
    throw new Error("El manifiesto del ensayo no es válido para la sonda de alteración");
  }
  const outcome: ExtBkProbeOutcome = { rejectedAsExpected: false, reason: "not-run" };
  try {
    const probe = await createTamperedProbe(bucket, rid);
    outcome.alteredSha256 = probe.alteredSha256;
    const rejection = await assertTamperRejected(bucket, rid, parsed);
    outcome.rejectedAsExpected = rejection.rejectedAsExpected;
    outcome.reason = rejection.reason + " (clave " + probe.key + ")";
    outcome.originalIntact = rejection.originalIntact;
    // The verified path must ALSO refuse the tampered copy before any restore.
    let refused = false;
    try {
      const tamperedManifest: ExtBkManifest = { ...parsed, archiveKey: probe.key };
      await assertArchiveIntegrity(await downloadArchiveOf(bucket, probe.key), tamperedManifest);
    } catch (error) {
      refused = /SHA-256|gzip válido|manifiesto/.test(error instanceof Error ? error.message : "");
      if (!refused) throw error;
    }
    if (!refused) throw new Error("El camino verificado aceptó la copia alterada");
    outcome.reason = "digest-mismatch (clave " + probe.key + "; camino verificado también la rechazó)";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : "sonda de alteración desconocida";
    outcome.rejectedAsExpected = false;
  }
  return outcome;
}

async function downloadArchiveOf(bucket: R2LikeBucket, key: string): Promise<Uint8Array> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error("Respaldo externo AUSENTE: la clave " + key + " no existe en R2");
  return new Uint8Array(await obj.arrayBuffer());
}

/** Negative control: a key that was never written must fail closed. */
export async function extBackupMissingProbe(
  host: ExtBkHost, rawBucket: unknown, project: string, runId: string
): Promise<ExtBkProbeOutcome> {
  assertExternalBackupProject(project);
  const bucket = assertR2Bucket(rawBucket, "DevContainer.extBackupMissingProbe");
  const rid = externalBackupRunId(runId);
  const outcome = await assertMissingRejected(bucket, rid);
  return { rejectedAsExpected: outcome.rejectedAsExpected, reason: outcome.reason };
}

/** Cleanup (every DO, always, also on error): destroy the disposable
 * Container and drop the drill evidence keys. lastActivity is KEPT so
 * assertRecoverableContainer refuses any future start of this disposable
 * DO (no silent blank rebind). */
export async function extBackupCleanup(host: ExtBkHost, project: string): Promise<ExtBkCleanupResult> {
  const id = assertExternalBackupProject(project);
  return await withExtBkQueue(host, async () => {
    const container = host.ctx.container;
    let containerDestroyed = false;
    if (container?.running) {
      try {
        await container.destroy("opencode-extbk-cleanup");
        containerDestroyed = true;
      } catch { containerDestroyed = false; }
    }
    const recordsDeleted = await host.ctx.storage.delete([EXTBK_RECORD_KEY, EXTBK_RESULT_KEY]);
    await host.ctx.storage.put("lastActivity", Date.now());
    return { project: id, containerDestroyed, recordsDeleted };
  });
}

/** The drill API surface a DevContainer exposes after importing this module
 * (declared as explicit RPC methods on the class, no prototype mutation). */
export type ExtBkDev = {
  extBackupCreate(project: string, runId: string): Promise<ExtBkCreateResult>;
  extBackupDestroyInstance(project: string): Promise<ExtBkDestroyResult>;
  extBackupCrossRestore(project: string, manifest: unknown, expectedManifestSha256: string): Promise<ExtBkRestoreOutcome>;
  extBackupTamperProbe(project: string, runId: string, manifest: unknown): Promise<ExtBkProbeOutcome>;
  extBackupMissingProbe(project: string, runId: string): Promise<ExtBkProbeOutcome>;
  extBackupCleanup(project: string): Promise<ExtBkCleanupResult>;
};

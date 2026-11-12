/**
 * Prototype augmentation that adds the snapshot recovery drill to DevContainer
 * WITHOUT touching src/dev-container.ts. The drill lives in
 * src/container-recovery.ts (pure guards, parsers and the in-container
 * program); this file binds it to the Durable Object lifecycle:
 *
 *   drillCreateSnapshot   - unique marker double-anchored by SHA-256, real
 *                           snapshotContainer(), handle persisted in the DO,
 *                           then a deliberate post-snapshot mutation.
 *   drillRestoreSameDo    - destroy ONLY this disposable instance, restore
 *                           with ctx.container.start({containerSnapshot}),
 *                           verify SHA-256 + mutation absence + image
 *                           compatibility + DO metadata before/after.
 *   drillCrossRestore     - a DIFFERENT DO attempts the creator's snapshot id;
 *                           a platform rejection is captured as pending
 *                           evidence, never attributed to application code.
 *   drillCleanup          - destroy the container, drop the handle; lastActivity
 *                           is kept so the disposable DO fails closed if reused.
 *
 * Safety: every method refuses projects whose slug does not start with
 * "snaprec-" (assertDrillProject); a missing or expired snapshot handle aborts
 * before anything is destroyed; a blank image is never used as a substitute.
 */
import {
  DRILL_ROOT_PATH, DRILL_SOURCE,
  assertCompatibleImage, assertDrillProject, assertDrillRecordProject,
  assertMarkerIntegrity, assertSnapshotHandle, evaluateDrillChecks, hashText,
  parseDrillRecord, parseDrillReport,
  type DrillCheck, type DrillRecord, type DrillReport, type DrillRestoreOutcome
} from "./container-recovery";
import { normalizeImageRef } from "./container-verify";

// Mirrors the module-private lifecycle constants of src/dev-container.ts so
// the drill integrates with the existing idle/checkpoint behavior unchanged.
const DRILL_INACTIVITY_MS = 15 * 60_000;
const DRILL_CHECK_MS = 60_000;

type DrillContainer = NonNullable<DurableObjectState["container"]>;

/** Structural view of the DevContainer the drill binds to. */
export type DrillHost = {
  ctx: DurableObjectState;
  ensureRunning(): Promise<DrillContainer>;
  busy: number;
  commandQueue: Promise<void>;
};

export type DrillCreateResult = {
  record: DrillRecord;
  snapshotId: string;
  image: string | null;
  doHashVerified: boolean;
};

/** The drill API surface a DevContainer exposes after this module is imported. */
export type DrillDev = {
  drillCreateSnapshot(project: string): Promise<DrillCreateResult>;
  drillRestoreSameDo(project: string): Promise<DrillRestoreOutcome>;
  drillCrossRestore(
    project: string, sourceSnapshotId: string, sourceRecord: unknown
  ): Promise<DrillRestoreOutcome>;
  drillCleanup(project: string): Promise<{
    project: string; containerDestroyed: boolean; handleDeleted: number;
  }>;
};

function sleepDrill(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilDrill(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Tiempo de espera agotado en el ensayo de recuperación de snapshot");
    }
    await sleepDrill(250);
  }
}

async function execDrill(
  container: DrillContainer,
  phase: DrillReport["phase"],
  env: Record<string, string>
): Promise<{ stdout: string; exitCode: number | null }> {
  const handle = await container.exec(
    ["node", "--input-type=module", "-e", DRILL_SOURCE],
    {
      env: { DRILL_ROOT: DRILL_ROOT_PATH, DRILL_PHASE: phase, ...env },
      signal: AbortSignal.timeout(120_000)
    }
  );
  const output = await handle.output();
  return { stdout: new TextDecoder().decode(output.stdout), exitCode: output.exitCode };
}

/** Same serialization as run(): shell writes and drill phases never overlap. */
async function withDrillQueue<T>(host: DrillHost, body: () => Promise<T>): Promise<T> {
  const queued = host as DrillHost & { busy: number; commandQueue: Promise<void> };
  const previous = queued.commandQueue;
  let release = () => {};
  queued.commandQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await body(); } finally { release(); }
}

/**
 * Phase 1 (creator DO): unique marker double-anchored by SHA-256 (container
 * and Durable Object must agree), a real snapshotContainer(), the snapshot
 * handle persisted in THIS DO, and a deliberate post-snapshot mutation of
 * the live disk that a valid restore must NOT surface (control negativo).
 */
export async function drillCreateSnapshot(host: DrillHost, project: string): Promise<DrillCreateResult> {
  const id = assertDrillProject(project);
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return await withDrillQueue(host, async () => {
    const container = await host.ensureRunning();
    host.busy++;
    await host.ctx.storage.put("lastActivity", Date.now());
    try {
      const createOut = await execDrill(container, "create", {
        DRILL_PROJECT: id, DRILL_RUN_ID: runId
      });
      const create = parseDrillReport(createOut.stdout, "create");
      if (!create || !create.ok || createOut.exitCode !== 0 ||
          create.runId !== runId || create.project !== id) {
        throw new Error("El ensayo no pudo crear el marcador aislado (create falló o informe inválido)");
      }
      // Cross-check the anchor in the Durable Object, not only in the container.
      if ((await hashText(create.markerContent)) !== create.markerSha256) {
        throw new Error("El SHA-256 del marcador difiere entre container y Durable Object");
      }
      const info = await container.inspect().catch(() => null);
      const image = normalizeImageRef(info?.image);
      const snapshot = await container.snapshotContainer({ name: "opencode-drill-" + runId });
      if (!snapshot || typeof snapshot.id !== "string" || !snapshot.id) {
        throw new Error("snapshotContainer() no devolvió un identificador usable");
      }
      // The negative mutation MUST happen after the snapshot; otherwise the
      // restored filesystem would correctly contain the mutation and the
      // recovery drill could never pass.
      const mutateOut = await execDrill(container, "mutate", {
        DRILL_PROJECT: id, DRILL_RUN_ID: runId
      });
      const mutate = parseDrillReport(mutateOut.stdout, "mutate");
      if (!mutate || !mutate.ok || mutateOut.exitCode !== 0 ||
          mutate.mutatedSha256 === create.markerSha256) {
        throw new Error("El control negativo posterior al snapshot no pudo aplicarse");
      }
      const savedAt = Date.now();
      const record: DrillRecord = {
        version: 1, project: id, runId,
        markerPath: create.markerRelPath,
        markerContent: create.markerContent,
        markerSha256: create.markerSha256,
        mutatedSha256: mutate.mutatedSha256,
        mutationFileSha256: mutate.mutationFileSha256,
        manifestSha256: create.manifestSha256,
        snapshotId: snapshot.id, snapshotSavedAt: savedAt,
        image, identitySha256: create.identitySha256,
        createdAt: new Date(savedAt).toISOString()
      };
      // The handle lives in the SAME keys the existing lifecycle already uses
      // (snapshotId/savedAt), plus a dedicated drill record.
      await host.ctx.storage.put({
        snapshotId: snapshot.id, savedAt, "recovery-drill-record-v1": record
      });
      return { record, snapshotId: snapshot.id, image, doHashVerified: true };
    } finally {
      host.busy--;
      await host.ctx.storage.put("lastActivity", Date.now());
      await host.ctx.storage.setAlarm(Date.now() + DRILL_CHECK_MS);
    }
  });
}

/**
 * Phase 2 (creator DO): read the persisted handle, DESTROY only this
 * disposable instance, restore with ctx.container.start({containerSnapshot})
 * and verify the SHA-256 anchor, the ABSENCE of the post-snapshot mutation,
 * image compatibility, and DO metadata persistence before/after. A missing
 * or expired handle aborts before anything is destroyed (fail-closed).
 */
export async function drillRestoreSameDo(host: DrillHost, project: string): Promise<DrillRestoreOutcome> {
  const id = assertDrillProject(project);
  return await withDrillQueue(host, async () => {
    const container = host.ctx.container;
    if (!container) throw new Error("Linux Container binding is not deployed");
    const recordRaw = await host.ctx.storage.get<DrillRecord>("recovery-drill-record-v1");
    const record = assertDrillRecordProject(parseDrillRecord(recordRaw), id);
    assertSnapshotHandle(record.snapshotId, record.snapshotSavedAt, Date.now());
    const snapshotKey = (await host.ctx.storage.get<string>("snapshotId")) ?? null;
    const metadataBefore = {
      recordPresent: recordRaw !== undefined,
      snapshotId: snapshotKey,
      savedAt: (await host.ctx.storage.get<number>("savedAt")) ?? null,
      handleMatchesRecord: snapshotKey === record.snapshotId
    };
    if (!metadataBefore.handleMatchesRecord ||
        metadataBefore.savedAt !== record.snapshotSavedAt) {
      throw new Error("El handle del snapshot no coincide con el estado persistido; no se destruirá el Container");
    }
    const outcome: DrillRestoreOutcome = {
      ok: false, phase: "restore-same-do", project: id, runId: record.runId,
      checks: [], destroyedInstance: false,
      imageBefore: record.image, imageAfter: null,
      metadataBefore
    };
    try {
      if (container.running) {
        // Destroy ONLY this disposable drill instance, never a shared one.
        await container.destroy("opencode-drill-recovery");
        await waitUntilDrill(() => !container.running, 15_000);
        outcome.destroyedInstance = true;
      }
      // Same restore shape as startOrRecover: snapshot only, never an image
      // (the typings enforce the mutual exclusion).
      container.start({
        containerSnapshot: { id: record.snapshotId },
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
        instance: "basic"
      });
      await waitUntilDrill(() => container.running, 120_000);
      await container.setInactivityTimeout(DRILL_INACTIVITY_MS);
      const info = await container.inspect().catch(() => null);
      outcome.imageAfter = normalizeImageRef(info?.image);
      assertCompatibleImage(record.image, outcome.imageAfter);
      const verifyOut = await execDrill(container, "verify", {
        DRILL_PROJECT: id, DRILL_RUN_ID: record.runId,
        DRILL_EXPECT_SHA256: record.markerSha256,
        DRILL_EXPECT_MANIFEST_SHA: record.manifestSha256,
        DRILL_MUTATION_ABSENT: "1"
      });
      const verify = parseDrillReport(verifyOut.stdout, "verify");
      if (!verify) {
        throw new Error("El informe de verificación del ensayo no es analizable");
      }
      outcome.checks = verify.checks;
      assertMarkerIntegrity(record.markerSha256, verify.markerSha256, verify.mutationPresent);
      if (!evaluateDrillChecks(verify.checks)) {
        throw new Error("Checks del ensayo incompletos o fallidos");
      }
      const metadataAfter = {
        recordPresent: (await host.ctx.storage.get("recovery-drill-record-v1")) !== undefined,
        snapshotId: (await host.ctx.storage.get<string>("snapshotId")) ?? null,
        savedAt: (await host.ctx.storage.get<number>("savedAt")) ?? null,
        handleMatchesRecord:
          (await host.ctx.storage.get<string>("snapshotId")) === record.snapshotId
      };
      outcome.metadataAfter = metadataAfter;
      if (!metadataAfter.recordPresent || !metadataAfter.handleMatchesRecord) {
        throw new Error("La metadata del Durable Object no persistió tras la restauración");
      }
      outcome.ok = true;
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : "restauración desconocida";
    }
    await host.ctx.storage.put("recovery-drill-result-v1", outcome);
    await host.ctx.storage.put("lastActivity", Date.now());
    await host.ctx.storage.setAlarm(Date.now() + DRILL_CHECK_MS);
    return outcome;
  });
}

/**
 * Phase 3 (restorer DO): a DIFFERENT Durable Object attempts to restore the
 * creator's snapshot id. If the platform rejects restoring another
 * instance's snapshot, the captured error is reported as
 * crossDoRestore:"start-rejected" (pending evidence, never attributed to
 * application code); if the container boots but verification fails, it is
 * "verification-failed".
 */
export async function drillCrossRestore(
  host: DrillHost, project: string, sourceSnapshotId: string, sourceRecord: unknown
): Promise<DrillRestoreOutcome> {
  const id = assertDrillProject(project);
  const record = parseDrillRecord(sourceRecord);
  if (!record) {
    throw new Error("El registro de origen del ensayo no es válido (restauración cruzada rechazada)");
  }
  if (record.project === id) {
    throw new Error("La restauración cruzada requiere un Durable Object distinto del creador");
  }
  if (sourceSnapshotId !== record.snapshotId) {
    throw new Error("El handle recibido no coincide con el registro de origen");
  }
  assertSnapshotHandle(sourceSnapshotId, record.snapshotSavedAt, Date.now());
  const outcome: DrillRestoreOutcome = {
    ok: false, phase: "restore-cross-do", project: id, runId: record.runId,
    checks: [], destroyedInstance: false,
    imageBefore: record.image, imageAfter: null, crossDoRestore: "start-rejected",
    metadataBefore: {
      recordPresent: false, snapshotId: sourceSnapshotId,
      savedAt: record.snapshotSavedAt, handleMatchesRecord: true
    }
  };
  try {
    // A fresh drill DO bootstraps its own blank instance first; destroy it so
    // the foreign snapshot restore is exercised from zero.
    const container = await host.ensureRunning();
    if (container.running) {
      await container.destroy("opencode-drill-cross");
      await waitUntilDrill(() => !container.running, 15_000);
      outcome.destroyedInstance = true;
    }
    container.start({
      containerSnapshot: { id: sourceSnapshotId },
      entrypoint: ["sleep", "infinity"],
      enableInternet: true,
      instance: "basic"
    });
    await waitUntilDrill(() => container.running, 120_000);
    await container.setInactivityTimeout(DRILL_INACTIVITY_MS);
    const info = await container.inspect().catch(() => null);
    outcome.imageAfter = normalizeImageRef(info?.image);
    assertCompatibleImage(record.image, outcome.imageAfter);
    const verifyOut = await execDrill(container, "verify", {
      DRILL_PROJECT: record.project, DRILL_RUN_ID: record.runId,
      DRILL_EXPECT_SHA256: record.markerSha256,
      DRILL_EXPECT_MANIFEST_SHA: record.manifestSha256,
      DRILL_MUTATION_ABSENT: "1"
    });
    const verify = parseDrillReport(verifyOut.stdout, "verify");
    if (!verify) throw new Error("El informe de verificación cruzada no es analizable");
    outcome.checks = verify.checks;
    assertMarkerIntegrity(record.markerSha256, verify.markerSha256, verify.mutationPresent);
    if (!evaluateDrillChecks(verify.checks)) {
      throw new Error("Checks de la restauración cruzada incompletos o fallidos");
    }
    outcome.ok = true;
    outcome.crossDoRestore = "verified";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : "restauración cruzada desconocida";
    if (outcome.imageAfter !== null) outcome.crossDoRestore = "verification-failed";
  }
  await host.ctx.storage.put("recovery-drill-result-v1", outcome);
  await host.ctx.storage.put("lastActivity", Date.now());
  return outcome;
}

/**
 * Destroy the drill container and drop its snapshot handle. lastActivity is
 * deliberately KEPT: assertRecoverableContainer then refuses any future start
 * of this disposable DO (fail-closed reuse guard, no blank rebind).
 */
export async function drillCleanup(host: DrillHost, project: string): Promise<{
  project: string; containerDestroyed: boolean; handleDeleted: number;
}> {
  const id = assertDrillProject(project);
  const container = host.ctx.container;
  let containerDestroyed = false;
  if (container?.running) {
    try {
      await container.destroy("opencode-drill-cleanup");
      containerDestroyed = true;
    } catch { containerDestroyed = false; }
  }
  const handleDeleted = await host.ctx.storage.delete(
    ["snapshotId", "savedAt", "recovery-drill-record-v1"]
  );
  await host.ctx.storage.put("lastActivity", Date.now());
  return { project: id, containerDestroyed, handleDeleted };
}


/**
 * DO-side implementation of the joint Worker+Container+DO rollback drill for
 * disposable DevContainer instances. Explicit RPC methods are declared on the
 * DevContainer class (same pattern as the drill* methods); this module holds
 * the guarded, queued implementations. No prototype mutation. Only the fixed
 * snaprec-a-<nonce> / snaprec-b-<nonce> scope of one 12-hex nonce is touched.
 */
import {
  DRILL_ROOT_PATH,
  assertDrillProject, assertManagedSnapshotImage, assertMarkerIntegrity,
  drillProjectNames, evaluateDrillChecks, hashText, parseDrillReport
} from "./container-recovery";
import { normalizeImageRef } from "./container-verify";
import {
  JOINT_LIVE_KEYS, JOINT_RECEIPT_KEY, JOINT_RECORD_KEY, JOINT_SCHEMA,
  JOINT_PREPARE_TTL_MS, JOINT_VERIFY_LEASE_MS, assertJointHandleMatch, assertJointNonce,
  assertJointRecordIdentity, assertJointVerifyState, jointEmergencyAllowed,
  jointReceipt, jointScope, parseJointRecord,
  type JointEmergencyResult, type JointPrepareResult, type JointRecord,
  type JointVerifyOutcome
} from "./joint-rollback";
import { execDrill, waitUntilDrill, withDrillQueue, type DrillHost } from "./container-recovery-do";

// Mirrors the module-private lifecycle constants of src/dev-container.ts and
// src/container-recovery-do.ts so the joint drill integrates with the existing
// idle/checkpoint behavior unchanged.
const JOINT_INACTIVITY_MS = 15 * 60_000;
const JOINT_CHECK_MS = 60_000;

/** The joint drill API surface a DevContainer exposes for one nonce. */
export type JointDev = {
  jointPrepare(nonce: string): Promise<JointPrepareResult>;
  jointVerifyCleanup(nonce: string): Promise<JointVerifyOutcome>;
  jointEmergencyCleanup(nonce: string, reason: string): Promise<JointEmergencyResult>;
};

function jointProjectOf(nonce: unknown): { project: string; scope: { creator: string; restorer: string } } {
  const scope = jointScope(nonce);
  return { project: assertDrillProject(scope.creator), scope };
}

function jointReason(reason: unknown): string {
  if (reason === undefined || reason === null || reason === "") return "sin motivo declarado";
  if (typeof reason !== "string" || reason.length > 300) {
    throw new Error("Motivo de emergencia inválido (texto de 1 a 300 caracteres)");
  }
  return reason;
}

/** Destroy only this disposable instance; never throw while disposing. */
async function jointDestroyContainer(host: DrillHost, why: string): Promise<boolean> {
  const container = host.ctx.container;
  if (!container?.running) return false;
  try {
    await container.destroy(why);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminal disposal shared by verify and emergency paths: destroy the
 * disposable container, delete EXACTLY JOINT_LIVE_KEYS (never lastActivity,
 * never foreign lifecycle keys), and keep an audit tombstone receipt.
 */
async function jointDispose(
  host: DrillHost, scope: { creator: string; restorer: string }, nonce: string,
  record: JointRecord | null, outcome: "verified" | "failed" | "emergency",
  detail?: { reason?: string; error?: string }
): Promise<{ containerDestroyed: boolean; handleDeleted: number; receipt: ReturnType<typeof jointReceipt> }> {
  const containerDestroyed = await jointDestroyContainer(host, "opencode-joint-cleanup");
  const handleDeleted = await host.ctx.storage.delete([...JOINT_LIVE_KEYS]);
  const receipt = jointReceipt({
    outcome, nonce, scope, record,
    ...(detail?.reason !== undefined ? { reason: detail.reason } : {}),
    ...(detail?.error !== undefined ? { error: detail.error } : {})
  });
  await host.ctx.storage.put(JOINT_RECEIPT_KEY, receipt);
  await host.ctx.storage.put("lastActivity", Date.now());
  await host.ctx.storage.setAlarm(Date.now() + JOINT_CHECK_MS);
  return { containerDestroyed, handleDeleted, receipt };
}

/**
 * joint_prepare (creator DO): creates the isolated synthetic test and its
 * DO metadata, takes ONE real snapshotContainer() and leaves the test
 * Container RUNNING and pristine, ready for the external supervisor's
 * controlled Worker rollback. No mutation is applied here: the negative
 * control belongs to the verify phase, AFTER the rollback window.
 *
 * Idempotent: a fresh "prepared" record for the SAME nonce is returned
 * unchanged (replayed:true) without a second snapshot. A foreign record
 * (other nonce), an expired one, or a "verifying" one abort fail-closed.
 */
export async function jointPrepareDrill(host: DrillHost, nonce: string): Promise<JointPrepareResult> {
  const { project, scope } = jointProjectOf(nonce);
  assertJointNonce(nonce);
  return await withDrillQueue(host, async () => {
    const existing = parseJointRecord(await host.ctx.storage.get(JOINT_RECORD_KEY));
    if (existing) {
      // Any record on this scope must belong to this exact nonce: a reused or
      // colliding scope is refused instead of silently replaced.
      assertJointRecordIdentity(existing, nonce);
      const now = Date.now();
      if (now - existing.snapshotSavedAt >= JOINT_PREPARE_TTL_MS) {
        throw new Error("JOINT_EXPIRED: registro joint vencido en este scope; ejecute joint_cleanup y repita joint_prepare");
      }
      if (existing.state !== "prepared") {
        throw new Error("JOINT_STATE_INVALID: el scope tiene una verificación en curso o terminada (estado " + existing.state + ")");
      }
      return {
        project, scope, record: existing, snapshotId: existing.snapshotId,
        image: existing.image, doHashVerified: true, replayed: true
      };
    }
    const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const container = await host.ensureRunning();
    host.busy++;
    await host.ctx.storage.put("lastActivity", Date.now());
    try {
      const createOut = await execDrill(container, "create", {
        DRILL_PROJECT: project, DRILL_RUN_ID: runId
      });
      const create = parseDrillReport(createOut.stdout, "create");
      if (!create || !create.ok || createOut.exitCode !== 0 ||
          create.runId !== runId || create.project !== project) {
        throw new Error("El ensayo conjunto no pudo crear la prueba sintética aislada (create falló o informe inválido)");
      }
      // The anchor is computed twice (container + DO) and must agree.
      if ((await hashText(create.markerContent)) !== create.markerSha256) {
        throw new Error("El SHA-256 del marcador difiere entre container y Durable Object");
      }
      const info = await container.inspect().catch(() => null);
      const image = normalizeImageRef(info?.image);
      const snapshot = await container.snapshotContainer({ name: "opencode-joint-" + runId });
      if (!snapshot || typeof snapshot.id !== "string" || !snapshot.id) {
        throw new Error("snapshotContainer() no devolvió un identificador usable");
      }
      const savedAt = Date.now();
      const record: JointRecord = {
        version: 1, kind: "joint-rollback-record-v1",
        project, scope: { creator: scope.creator, restorer: scope.restorer },
        nonce, runId,
        markerPath: create.markerRelPath,
        markerContent: create.markerContent,
        markerSha256: create.markerSha256,
        manifestSha256: create.manifestSha256,
        snapshotId: snapshot.id, snapshotSavedAt: savedAt,
        image, identitySha256: create.identitySha256,
        state: "prepared", stateSince: savedAt,
        createdAt: new Date(savedAt).toISOString()
      };
      // The live handle uses the SAME keys the existing lifecycle already
      // reads (snapshotId/savedAt), plus the dedicated joint record.
      await host.ctx.storage.put("snapshotId", snapshot.id);
      await host.ctx.storage.put("savedAt", savedAt);
      await host.ctx.storage.put(JOINT_RECORD_KEY, record);
      return {
        project, scope, record, snapshotId: snapshot.id, image,
        doHashVerified: true, replayed: false
      };
    } finally {
      host.busy--;
      await host.ctx.storage.put("lastActivity", Date.now());
      await host.ctx.storage.setAlarm(Date.now() + JOINT_CHECK_MS);
    }
  });
}

/**
 * joint_verify_cleanup (creator DO), runs AFTER the external supervisor has
 * rolled the Worker back to another Stage version and restored the original
 * candidate version. Sequence, in one queued pass:
 *   1. metadata survival: the joint record + live handle must still be
 *      present, correlated (nonce/scope/handle) and unexpired; anything else
 *      aborts BEFORE destroying anything.
 *   2. negative control on the live disk AFTER the rollback window: mutate
 *      the marker + drop a post-snapshot file (when the live disk is still
 *      pristine; if the platform already rebuilt the disk this is reported
 *      as evidence, never faked).
 *   3. destroy ONLY this disposable instance and restore from the recorded
 *      snapshot handle (never a blank image).
 *   4. verify: marker SHA-256 equals the pre-rollback anchor, manifest bytes
 *      identical, post-snapshot mutation ABSENT, image identity compatible.
 *   5. receipt + terminal cleanup, EVEN ON FAILURE (dispose in the flow).
 */
export async function jointVerifyCleanupDrill(host: DrillHost, nonce: string): Promise<JointVerifyOutcome> {
  const { project, scope } = jointProjectOf(nonce);
  assertJointNonce(nonce);
  return await withDrillQueue(host, async () => {
    const now = Date.now();
    const recordRaw = await host.ctx.storage.get(JOINT_RECORD_KEY);
    const record = parseJointRecord(recordRaw);
    if (!record) {
      throw new Error("JOINT_METADATA_MISSING: este DO no tiene un registro joint válido (handle ausente o metadata borrada); no se tocará ningún Container");
    }
    assertJointRecordIdentity(record, nonce);
    const liveSnapshotId = (await host.ctx.storage.get<string>("snapshotId")) ?? null;
    const liveSavedAt = (await host.ctx.storage.get<number>("savedAt")) ?? null;
    assertJointHandleMatch(record, liveSnapshotId, liveSavedAt);
    assertJointVerifyState(record, now);
    const metadataSurvived = {
      recordPresent: true,
      snapshotId: liveSnapshotId,
      savedAt: liveSavedAt,
      nonceMatches: true,
      handleMatchesRecord: true
    };
    // Lease: mark the verification in flight before anything destructive.
    await host.ctx.storage.put(JOINT_RECORD_KEY, { ...record, state: "verifying", stateSince: now });

    const outcome: JointVerifyOutcome = {
      ok: false, schema: JOINT_SCHEMA, phase: "joint-verify",
      project, nonce, runId: record.runId, metadataSurvived,
      metadataAfter: { recordPresent: false, snapshotIdMatches: false },
      liveContainer: {
        wasRunning: false, platformAutoRecovered: false,
        markerIntactOnLiveDisk: null, mutatedSha256: null, mutationFileSha256: null
      },
      mutationApplied: false, destroyedInstance: false,
      imageBefore: record.image, imageAfter: null,
      checks: [], containerDestroyed: false, handleDeleted: 0, receipt: null
    };
    try {
      const container = host.ctx.container;
      if (!container) throw new Error("Linux Container binding is not deployed");
      host.busy++;
      try {
        // Evidence first: did the Container survive the Worker rollback window?
        outcome.liveContainer.wasRunning = container.running;
        if (!container.running) {
          // Normal lifecycle recovery path (snapshot-only, never blank).
          await host.ensureRunning();
          outcome.liveContainer.platformAutoRecovered = true;
        }
        let mutateExecError: string | null = null;
        const mutateOut = await execDrill(container, "mutate", {
          DRILL_PROJECT: project, DRILL_RUN_ID: record.runId
        }).catch((e: unknown) => {
          mutateExecError = e instanceof Error ? e.message : "mutate exec error";
          return { stdout: "", exitCode: null as number | null };
        });
        const mutate = mutateExecError ? null : parseDrillReport(mutateOut.stdout, "mutate");
        if (mutate?.ok && mutateOut.exitCode === 0) {
          // Live disk was pristine after the rollback window: the negative
          // control is now applied and MUST NOT survive the restore.
          outcome.liveContainer.markerIntactOnLiveDisk = true;
          outcome.mutationApplied = true;
          outcome.liveContainer.mutatedSha256 = mutate.mutatedSha256;
          outcome.liveContainer.mutationFileSha256 = mutate.mutationFileSha256;
        } else if (mutateExecError) {
          // The mutation probe could not run at all: integrity on the live
          // disk stays UNKNOWN (null); never reported as intact or mutated.
          outcome.liveContainer.markerIntactOnLiveDisk = null;
        } else {
          // The drill program ran and refused: the live disk no longer holds
          // the pristine marker (instance rebuilt or externally mutated).
          // Evidence, then continue: the restore-from-handle check below
          // still proves the recovery from the snapshot.
          outcome.liveContainer.markerIntactOnLiveDisk = false;
        }
        if (container.running) {
          // Destroy ONLY this disposable drill instance.
          await container.destroy("opencode-joint-verify");
          await waitUntilDrill(() => !container.running, 15_000);
          outcome.destroyedInstance = true;
        }
        container.start({
          containerSnapshot: { id: record.snapshotId },
          entrypoint: ["sleep", "infinity"],
          enableInternet: true,
          instance: "basic"
        });
        await waitUntilDrill(() => container.running, 120_000);
        await container.setInactivityTimeout(JOINT_INACTIVITY_MS);
        const info = await container.inspect().catch(() => null);
        outcome.imageAfter = normalizeImageRef(info?.image);
        outcome.imageIdentityProof = assertManagedSnapshotImage(record.image, outcome.imageAfter);
        const verifyOut = await execDrill(container, "verify", {
          DRILL_PROJECT: project, DRILL_RUN_ID: record.runId,
          DRILL_EXPECT_SHA256: record.markerSha256,
          DRILL_EXPECT_MANIFEST_SHA: record.manifestSha256,
          DRILL_MUTATION_ABSENT: outcome.mutationApplied ? "1" : "0"
        });
        const verify = parseDrillReport(verifyOut.stdout, "verify");
        if (!verify) throw new Error("El informe de verificación joint no es analizable");
        outcome.checks = verify.checks;
        assertMarkerIntegrity(record.markerSha256, verify.markerSha256, verify.mutationPresent);
        if (!evaluateDrillChecks(verify.checks)) {
          throw new Error("Checks del ensayo joint incompletos o fallidos");
        }
        const afterRecord = parseJointRecord(await host.ctx.storage.get(JOINT_RECORD_KEY));
        outcome.metadataAfter = {
          recordPresent: Boolean(afterRecord),
          snapshotIdMatches: Boolean(afterRecord && afterRecord.snapshotId === record.snapshotId)
        };
        if (!outcome.metadataAfter.recordPresent || !outcome.metadataAfter.snapshotIdMatches) {
          throw new Error("La metadata del Durable Object no sobrevivió la ventana del ensayo joint");
        }
        outcome.ok = true;
      } finally {
        host.busy--;
      }
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : "verificación joint desconocida";
    }
    // Terminal disposal runs on success AND on failure, always.
    const disposed = await jointDispose(host, scope, nonce, record,
      outcome.ok ? "verified" : "failed",
      outcome.ok ? undefined : { error: outcome.error?.slice(0, 300) });
    outcome.containerDestroyed = disposed.containerDestroyed;
    outcome.handleDeleted = disposed.handleDeleted;
    outcome.receipt = disposed.receipt;
    return outcome;
  });
}

/**
 * joint_cleanup de emergencia (creator DO): break-glass disposal that ALWAYS
 * leaves the scope dead. Idempotent: running it on an already-clean scope is
 * a no-op that reports alreadyClean. It refuses ONLY while a verification is
 * provably in flight inside the lease window (the verify disposes itself in
 * its own terminal path; after JOINT_VERIFY_LEASE_MS a stuck lease is broken
 * anyway so no instance is ever left alive indefinitely).
 */
export async function jointEmergencyCleanupDrill(
  host: DrillHost, nonce: string, reason: string
): Promise<JointEmergencyResult> {
  const { project, scope } = jointProjectOf(nonce);
  assertJointNonce(nonce);
  const motive = jointReason(reason);
  return await withDrillQueue(host, async () => {
    const now = Date.now();
    const record = parseJointRecord(await host.ctx.storage.get(JOINT_RECORD_KEY));
    if (record) {
      // A foreign record on this scope is never silently destroyed.
      assertJointRecordIdentity(record, nonce);
      if (!jointEmergencyAllowed(record, now)) {
        throw new Error("JOINT_VERIFY_IN_FLIGHT: hay una verificación joint en curso dentro de la ventana de lease; reintente joint_cleanup después de " +
          Math.ceil((JOINT_VERIFY_LEASE_MS - (now - record.stateSince)) / 1000) + " s");
      }
    }
    const containerWasRunning = Boolean(host.ctx.container?.running);
    const containerDestroyed = await jointDestroyContainer(host, "opencode-joint-emergency");
    const handleDeleted = await host.ctx.storage.delete([...JOINT_LIVE_KEYS]);
    const receipt = jointReceipt({
      outcome: "emergency", nonce, scope, record, reason: motive,
      ...(record && !containerDestroyed && containerWasRunning
        ? { error: "la instancia del Container seguía viva y su destrucción falló (verificar plataforma)" }
        : {})
    });
    await host.ctx.storage.put(JOINT_RECEIPT_KEY, receipt);
    await host.ctx.storage.put("lastActivity", Date.now());
    await host.ctx.storage.setAlarm(Date.now() + JOINT_CHECK_MS);
    return {
      project, containerDestroyed, handleDeleted,
      alreadyClean: !record && !containerWasRunning, receipt
    };
  });
}

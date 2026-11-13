/**
 * Ensayo de ROLLBACK CONJUNTO Worker + Container + Durable Object
 * (solo staging, scope desechable, sin datos reales).
 *
 * Dos acciones PRIVADAS de Cloudflare Workflow (`joint_prepare` y
 * `joint_verify_cleanup`, más `joint_cleanup` de emergencia) retienen una
 * prueba sintética y metadata del DO DURANTE un rollback de Worker controlado
 * a otra versión Stage, ejecutado por el SUPERVISOR EXTERNO autorizado
 * (nunca por un agente), y luego verifican que:
 *   1. la metadata del Durable Object (registro, nonce, handle) sobrevivió,
 *   2. el Container desechable puede destruirse y restaurarse desde el
 *      snapshot guardado ANTES del rollback (nunca desde imagen vacía),
 *   3. los hashes SHA-256 del marcador coinciden con el ancla previa,
 *   4. NO sobrevive ninguna mutación posterior al snapshot (control negativo),
 *   5. el recibo queda como lápida de auditoría aunque todo lo demás falle.
 *
 * Safety invariants (fail-closed):
 *   - Solo se toca el scope fijo snaprec-a-<nonce> / snaprec-b-<nonce> con
 *     nonce de 12 hex; todo lo demás es rechazado (nunca personal, nunca
 *     proyectos importados ni datos reales).
 *   - Sin endpoints públicos: solo la API de Workflow de Cloudflare
 *     autenticada puede invocar estas acciones (igual que recovery_drill).
 *   - Ancla PRIVADA del ensayo: joint_prepare guarda, junto al registro, un
 *     handle privado (JOINT_HANDLE_KEY) con el snapshot del ensayo; la
 *     verificación correlaciona ESE handle con el registro. Las claves
 *     compartidas snapshotId/savedAt del ciclo de vida son SOLO evidencia:
 *     el checkpoint normal del DO las rota legítimamente durante la ventana
 *     (incidente oc_v1_joint_verify_20261113_01, nonce 871ea5456848).
 *   - Idempotencia: joint_prepare repetido devuelve el MISMO registro sin
 *     crear un segundo snapshot (replayed). Un registro ajeno al nonce, o
 *     vencido, o en estado distinto de "prepared", aborta.
 *   - Caducidad: el registro vence a JOINT_PREPARE_TTL_MS; verificación
 *     rehusada tras vencimiento exige joint_cleanup explícito (no deja
 *     instancias vivas indefinidamente).
 *   - Lease de verificación: mientras joint_verify_cleanup está en vuelo el
 *     registro queda en estado "verifying" y joint_cleanup de emergencia se
 *     niega a destruir nada durante JOINT_VERIFY_LEASE_MS.
 *   - El nonce es un token de CORRELACIÓN, no un secreto (ya está incrustado
 *     en el nombre del DO); la seguridad viene de que estas acciones solo son
 *     alcanzables por la API de Workflow, no de credenciales públicas.
 */

import { drillProjectNames, NONCE } from "./container-recovery";

/** Workflow schema marker of every receipt returned by these actions. */
export const JOINT_SCHEMA = "opencode.joint-rollback.v1";
/** DO storage key of the live joint record (deleted by every cleanup). */
export const JOINT_RECORD_KEY = "joint-rollback-record-v1";
/** DO storage key of the audit tombstone (KEPT after cleanup, keeps nothing alive). */
export const JOINT_RECEIPT_KEY = "joint-rollback-receipt-v1";
/**
 * DO storage key of the joint trial's PRIVATE snapshot handle. Written only
 * by joint_prepare (and by its replay repair) and read only by the joint
 * verify; the normal lifecycle (alarm checkpoint, startOrRecover) never
 * touches it, so it is the stable, rotation-independent anchor of the trial.
 */
export const JOINT_HANDLE_KEY = "joint-rollback-handle-v1";
/**
 * Window granted to the external supervisor to perform the reversible Worker
 * rollback and return to the candidate version. After it, verification is
 * refused (fail-closed) and only joint_cleanup is allowed.
 */
export const JOINT_PREPARE_TTL_MS = 6 * 60 * 60_000;
/** How long an in-flight verification blocks the emergency cleanup. */
export const JOINT_VERIFY_LEASE_MS = 15 * 60_000;
/**
 * The EXACT live keys every cleanup deletes: the two shared lifecycle handle
 * keys, the joint record and the joint private handle. Nothing else, ever.
 */
export const JOINT_LIVE_KEYS = ["snapshotId", "savedAt", JOINT_RECORD_KEY, JOINT_HANDLE_KEY] as const;

export type JointRecordState = "prepared" | "verifying";

/** Durable, fail-closed record of one joint drill run (lives in the creator DO). */
export type JointRecord = {
  version: 1;
  kind: "joint-rollback-record-v1";
  project: string; // always scope.creator
  scope: { creator: string; restorer: string };
  nonce: string;
  runId: string;
  markerPath: string;
  markerContent: string;
  markerSha256: string;
  manifestSha256: string;
  snapshotId: string;
  snapshotSavedAt: number;
  image: string | null;
  identitySha256: string | null;
  state: JointRecordState;
  stateSince: number;
  createdAt: string;
};

/**
 * Private, stable snapshot anchor of one joint trial. Unlike the SHARED
 * snapshotId/savedAt keys (owned by the normal lifecycle, which rotates them
 * with fresh checkpoints), this handle is only written by the joint drill, so
 * verify can correlate it against the record without mistaking a routine
 * lifecycle checkpoint for tampering.
 */
export type JointHandle = {
  version: 1;
  kind: "joint-rollback-handle-v1";
  nonce: string;
  snapshotId: string;
  savedAt: number;
};

/** Audit tombstone: written by every terminal path, deleted by nothing. */
export type JointReceipt = {
  version: 1;
  kind: "joint-rollback-receipt-v1";
  outcome: "verified" | "failed" | "emergency";
  project: string;
  nonce: string;
  scope: { creator: string; restorer: string };
  runId: string | null;
  markerSha256: string | null;
  manifestSha256: string | null;
  snapshotId: string | null;
  finishedAt: string;
  reason?: string;
  error?: string;
};

export type JointPrepareResult = {
  project: string;
  scope: { creator: string; restorer: string };
  record: JointRecord;
  snapshotId: string;
  image: string | null;
  doHashVerified: boolean;
  /** true when a fresh prepared record already existed: nothing new is created. */
  replayed: boolean;
};

export type JointVerifyOutcome = {
  ok: boolean;
  schema: typeof JOINT_SCHEMA;
  phase: "joint-verify";
  project: string;
  nonce: string;
  runId: string;
  metadataSurvived: {
    recordPresent: boolean;
    /** SHARED lifecycle key, reported as EVIDENCE (may be legitimately rotated). */
    snapshotId: string | null;
    /** SHARED lifecycle key, reported as EVIDENCE (may be legitimately rotated). */
    savedAt: number | null;
    nonceMatches: boolean;
    /** The joint-PRIVATE handle matches the record: the actual fail-closed gate. */
    handleMatchesRecord: boolean;
    /** The private handle key was present and record-consistent. */
    privateHandleVerified: boolean;
    /** Evidence about the SHARED lifecycle keys after the rollback window. */
    sharedHandleState: SharedHandleState;
  };
  metadataAfter: { recordPresent: boolean; snapshotIdMatches: boolean };
  liveContainer: {
    wasRunning: boolean;
    platformAutoRecovered: boolean;
    markerIntactOnLiveDisk: boolean | null;
    mutatedSha256: string | null;
    mutationFileSha256: string | null;
  };
  mutationApplied: boolean;
  destroyedInstance: boolean;
  imageBefore: string | null;
  imageAfter: string | null;
  imageIdentityProof?: "exact-reference" | "cloudflare-managed-alias";
  checks: Array<{ step: string; status: "pass" | "fail"; detail?: string }>;
  containerDestroyed: boolean;
  handleDeleted: number;
  receipt: JointReceipt | null;
  error?: string;
};

export type JointEmergencyResult = {
  project: string;
  containerDestroyed: boolean;
  handleDeleted: number;
  alreadyClean: boolean;
  receipt: JointReceipt;
};

const HEX64 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{8,32}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const REL_PATH_OK = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 256 &&
  !value.includes("..") && !value.startsWith("/");

/** Nonces are 12-hex correlation tokens shared by prepare and verify. */
export function assertJointNonce(nonce: unknown): string {
  if (typeof nonce !== "string" || !NONCE.test(nonce)) {
    throw new Error("Nonce de ensayo conjunto inválido: se requieren 12 caracteres hexadecimales");
  }
  return nonce;
}

/** The one disposable scope a joint run may ever touch, derived from the nonce. */
export function jointScope(nonce: unknown): { creator: string; restorer: string } {
  return drillProjectNames(assertJointNonce(nonce));
}

/** Strict parser: anything malformed becomes null so callers fail closed. */
export function parseJointRecord(raw: unknown): JointRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || r.kind !== "joint-rollback-record-v1") return null;
  if (typeof r.project !== "string" || !r.project.startsWith("snaprec-")) return null;
  if (typeof r.nonce !== "string" || !NONCE.test(r.nonce)) return null;
  if (!r.scope || typeof r.scope !== "object") return null;
  const scope = r.scope as Record<string, unknown>;
  if (scope.creator !== "snaprec-a-" + r.nonce || scope.restorer !== "snaprec-b-" + r.nonce ||
      r.project !== scope.creator) return null;
  if (typeof r.runId !== "string" || !RUN_ID.test(r.runId)) return null;
  if (!REL_PATH_OK(r.markerPath)) return null;
  if (typeof r.markerContent !== "string" || !r.markerContent || r.markerContent.length > 1024) return null;
  if (typeof r.markerSha256 !== "string" || !HEX64.test(r.markerSha256) ||
      typeof r.manifestSha256 !== "string" || !HEX64.test(r.manifestSha256)) return null;
  if (typeof r.snapshotId !== "string" || !SNAPSHOT_ID.test(r.snapshotId)) return null;
  if (typeof r.snapshotSavedAt !== "number" || !Number.isFinite(r.snapshotSavedAt)) return null;
  let image: string | null = null;
  if (r.image !== null) {
    if (typeof r.image !== "string" || !r.image) return null;
    image = r.image;
  }
  let identitySha256: string | null = null;
  if (r.identitySha256 !== null) {
    if (typeof r.identitySha256 !== "string" || !HEX64.test(r.identitySha256)) return null;
    identitySha256 = r.identitySha256;
  }
  if ((r.state !== "prepared" && r.state !== "verifying") ||
      typeof r.stateSince !== "number" || !Number.isFinite(r.stateSince)) return null;
  if (typeof r.createdAt !== "string" || !r.createdAt || !Number.isFinite(Date.parse(r.createdAt))) return null;
  return {
    version: 1, kind: "joint-rollback-record-v1",
    project: r.project, scope: { creator: scope.creator, restorer: scope.restorer },
    nonce: r.nonce, runId: r.runId, markerPath: r.markerPath,
    markerContent: r.markerContent, markerSha256: r.markerSha256,
    manifestSha256: r.manifestSha256, snapshotId: r.snapshotId,
    snapshotSavedAt: r.snapshotSavedAt, image,
    identitySha256, state: r.state,
    stateSince: r.stateSince, createdAt: r.createdAt
  };
}

/** The private handle is derived from the record: both must always agree. */
export function jointHandleFrom(record: JointRecord): JointHandle {
  return {
    version: 1, kind: "joint-rollback-handle-v1",
    nonce: record.nonce, snapshotId: record.snapshotId, savedAt: record.snapshotSavedAt
  };
}

/** Strict parser for the private handle; nonce mismatch (when given) is null. */
export function parseJointHandle(raw: unknown, nonce?: string): JointHandle | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  if (h.version !== 1 || h.kind !== "joint-rollback-handle-v1") return null;
  if (typeof h.nonce !== "string" || !NONCE.test(h.nonce)) return null;
  if (typeof h.snapshotId !== "string" || !SNAPSHOT_ID.test(h.snapshotId)) return null;
  if (typeof h.savedAt !== "number" || !Number.isFinite(h.savedAt)) return null;
  if (nonce !== undefined && h.nonce !== nonce) return null;
  return {
    version: 1, kind: "joint-rollback-handle-v1",
    nonce: h.nonce, snapshotId: h.snapshotId, savedAt: h.savedAt
  };
}

/**
 * Lifecycle state of the SHARED snapshotId/savedAt keys relative to the
 * record, used as EVIDENCE in the verify outcome (never as a gate):
 *   - "match": untouched, still the trial's snapshot.
 *   - "rotated": the normal checkpoint wrote a NEWER snapshot (savedAt moved
 *     forward). Expected during the rollback window: alarm() runs in the DO
 *     regardless of the Worker version. Never a failure.
 *   - "missing": both shared keys are gone.
 *   - "diverged": anything else (older savedAt, rewritten savedAt with a
 *     different id, partial deletion). Reported for the audit trail.
 */
export type SharedHandleState = "match" | "rotated" | "missing" | "diverged";

export function classifyJointLiveHandle(
  record: JointRecord, liveSnapshotId: unknown, liveSavedAt: unknown
): SharedHandleState {
  if (liveSnapshotId === null && liveSavedAt === null) return "missing";
  if (liveSnapshotId === record.snapshotId && liveSavedAt === record.snapshotSavedAt) return "match";
  if (typeof liveSavedAt === "number" && Number.isFinite(liveSavedAt) &&
      liveSavedAt > record.snapshotSavedAt) return "rotated";
  return "diverged";
}

/**
 * Metadata correlation: the record must belong to THIS nonce and scope, and
 * the live handle must still match the record exactly. Any divergence (nonce
 * distinto, handle borrado, savedAt reescrito) aborts the verify before
 * anything is destroyed. The "live handle" compared here is the trial's
 * PRIVATE handle (JOINT_HANDLE_KEY): the shared lifecycle keys rotate
 * legitimately and are evidence, never a gate.
 */
export function assertJointRecordIdentity(record: JointRecord, nonce: string): void {
  assertJointNonce(nonce);
  const scope = jointScope(nonce);
  if (record.nonce !== nonce || record.project !== scope.creator ||
      record.scope.creator !== scope.creator || record.scope.restorer !== scope.restorer) {
    throw new Error("JOINT_METADATA_MISMATCH: el registro no corresponde a este nonce/scope (operación fuera del proyecto)");
  }
}

export function assertJointHandleMatch(
  record: JointRecord, liveSnapshotId: unknown, liveSavedAt: unknown
): void {
  if (liveSnapshotId !== record.snapshotId || liveSavedAt !== record.snapshotSavedAt) {
    throw new Error("JOINT_HANDLE_MISMATCH: el handle del ensayo difiere del registro (borrado indebido o divergencia del ancla); no se destruirá el Container");
  }
}

/** Verification only proceeds on a fresh "prepared" record. */
export function assertJointVerifyState(record: JointRecord, now: number): void {
  if (record.state !== "prepared") {
    throw new Error("JOINT_STATE_INVALID: el registro no está en estado prepared (estado " + record.state + ")");
  }
  if (now - record.snapshotSavedAt >= JOINT_PREPARE_TTL_MS) {
    throw new Error("JOINT_EXPIRED: la ventana del ensayo conjunto venció; ejecute joint_cleanup y repita joint_prepare");
  }
}

/**
 * Emergency cleanup is blocked ONLY while a verification is provably in
 * flight (state "verifying" inside the lease window); every other state,
 * including expired leases, may be cleaned.
 */
export function jointEmergencyAllowed(
  record: JointRecord | null | undefined, now: number
): boolean {
  if (!record) return true;
  return record.state !== "verifying" || now - record.stateSince >= JOINT_VERIFY_LEASE_MS;
}

export function jointReceipt(input: {
  outcome: JointReceipt["outcome"];
  nonce: string;
  scope: { creator: string; restorer: string };
  record?: JointRecord | null;
  reason?: string;
  error?: string;
  finishedAt?: number;
}): JointReceipt {
  const record = input.record ?? null;
  return {
    version: 1, kind: "joint-rollback-receipt-v1",
    outcome: input.outcome,
    project: input.scope.creator,
    nonce: input.nonce,
    scope: { creator: input.scope.creator, restorer: input.scope.restorer },
    runId: record?.runId ?? null,
    markerSha256: record?.markerSha256 ?? null,
    manifestSha256: record?.manifestSha256 ?? null,
    snapshotId: record?.snapshotId ?? null,
    finishedAt: new Date(input.finishedAt ?? Date.now()).toISOString(),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.error !== undefined ? { error: input.error } : {})
  };
}

/** Strict parser for the persisted tombstone. */
export function parseJointReceipt(raw: unknown): JointReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || r.kind !== "joint-rollback-receipt-v1") return null;
  if (r.outcome !== "verified" && r.outcome !== "failed" && r.outcome !== "emergency") return null;
  if (typeof r.project !== "string" || !r.project.startsWith("snaprec-")) return null;
  if (typeof r.nonce !== "string" || !NONCE.test(r.nonce)) return null;
  if (!r.scope || typeof r.scope !== "object") return null;
  const scope = r.scope as Record<string, unknown>;
  if (scope.creator !== "snaprec-a-" + r.nonce || scope.restorer !== "snaprec-b-" + r.nonce) return null;
  const optField = (value: unknown, test: (x: string) => boolean): string | null | undefined => {
    if (value === null) return null;
    return typeof value === "string" && test(value) ? value : undefined;
  };
  const runId = optField(r.runId, (x) => RUN_ID.test(x));
  const markerSha256 = optField(r.markerSha256, (x) => HEX64.test(x));
  const manifestSha256 = optField(r.manifestSha256, (x) => HEX64.test(x));
  const snapshotId = optField(r.snapshotId, (x) => SNAPSHOT_ID.test(x));
  if (runId === undefined || markerSha256 === undefined ||
      manifestSha256 === undefined || snapshotId === undefined) return null;
  if (typeof r.finishedAt !== "string" || !Number.isFinite(Date.parse(r.finishedAt))) return null;
  return {
    version: 1, kind: "joint-rollback-receipt-v1", outcome: r.outcome,
    project: r.project, nonce: r.nonce,
    scope: { creator: scope.creator, restorer: scope.restorer },
    runId, markerSha256, manifestSha256, snapshotId,
    finishedAt: r.finishedAt,
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    ...(typeof r.error === "string" ? { error: r.error } : {})
  };
}

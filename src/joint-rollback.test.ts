import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRILL_SOURCE, assertDrillProject, hashText, parseDrillReport } from "./container-recovery";
import { projectContainerName } from "./project-container";
import {
  JOINT_HANDLE_KEY, JOINT_PREPARE_TTL_MS, JOINT_RECEIPT_KEY, JOINT_RECORD_KEY, JOINT_VERIFY_LEASE_MS,
  assertJointHandleMatch, assertJointNonce, assertJointRecordIdentity, assertJointVerifyState,
  classifyJointLiveHandle, jointEmergencyAllowed, jointHandleFrom, jointReceipt, jointScope,
  parseJointHandle, parseJointReceipt, parseJointRecord,
  type JointHandle, type JointRecord
} from "./joint-rollback";
import {
  jointEmergencyCleanupDrill, jointPrepareDrill, jointVerifyCleanupDrill
} from "./joint-rollback-do";
import type { DrillHost } from "./container-recovery-do";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hexNonce = () => randomUUID().replace(/-/g, "").slice(0, 12);

/** Realistic, fully-valid joint record (parseable). */
function jointRecordFixture(overrides: Partial<JointRecord> = {}): JointRecord {
  const nonce = overrides.nonce ?? hexNonce();
  const now = Date.now();
  const markerContent = "opencode-joint-drill-v1|" + nonce + "|" + "a".repeat(48);
  return {
    version: 1, kind: "joint-rollback-record-v1",
    project: "snaprec-a-" + nonce,
    scope: { creator: "snaprec-a-" + nonce, restorer: "snaprec-b-" + nonce },
    nonce, runId: randomUUID().replace(/-/g, "").slice(0, 16),
    markerPath: "__drill-snaprec-a-" + nonce + "/marker.txt",
    markerContent,
    markerSha256: sha(markerContent),
    manifestSha256: "b".repeat(64),
    snapshotId: "snapshot-joint-" + nonce,
    snapshotSavedAt: now, image: null, identitySha256: null,
    state: "prepared", stateSince: now, createdAt: new Date(now).toISOString(),
    ...overrides
  };
}

/**
 * Fixture with the metadata of the REAL failed run oc_v1_joint_prepare_
 * staging_20261113_01 / oc_v1_joint_verify_20261113_01 (nonce 871ea5456848,
 * snapshotId 56a36205-4bee-4b07-b5f8-95ba55634d90). ONLY a data fixture for
 * regression tests: the real nonce was already cleaned and is never invoked
 * against any Workflow here.
 */
function incidentRecord(overrides: Partial<JointRecord> = {}): JointRecord {
  return jointRecordFixture({
    nonce: "871ea5456848",
    snapshotId: "56a36205-4bee-4b07-b5f8-95ba55634d90",
    ...overrides
  });
}

/**
 * Consistent post-prepare seed: record + PRIVATE handle + SHARED lifecycle
 * keys, all in sync (what joint_prepare writes on success).
 */
function seedScope(rec: JointRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [JOINT_RECORD_KEY]: rec,
    [JOINT_HANDLE_KEY]: jointHandleFrom(rec),
    snapshotId: rec.snapshotId,
    savedAt: rec.snapshotSavedAt,
    ...extra
  };
}

/** Minimal DrillHost fake: storage in memory, NO container (unit level). */
function fakeHost(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const calls = { ensureRunning: 0 };
  const host = {
    ctx: {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value); },
        delete: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          let n = 0;
          for (const k of list) if (store.delete(k)) n++;
          return n;
        },
        setAlarm: async () => {}
      },
      container: undefined
    },
    busy: 0,
    commandQueue: Promise.resolve() as Promise<void>,
    ensureRunning: async () => {
      calls.ensureRunning++;
      throw new Error("unit fake: no container available");
    }
  };
  return { host: host as unknown as DrillHost, store, calls };
}

describe("nonce y scope correlacionados", () => {
  test("nonce inválido es rechazado (firma de correlación falla)", () => {
    for (const bad of ["", "abcdef", "0123456789a", "0123456789abc",
      "zzzzzzzzzzzz", "0123456789aB", 123, null, undefined]) {
      expect(() => assertJointNonce(bad)).toThrow();
      expect(() => jointScope(bad)).toThrow();
    }
  });

  test("nonce válido deriva el scope fijo snaprec-a/b-<nonce>", () => {
    const scope = jointScope("0123456789ab");
    expect(scope.creator).toBe("snaprec-a-0123456789ab");
    expect(scope.restorer).toBe("snaprec-b-0123456789ab");
    expect(projectContainerName(scope.creator)).toBe("project-v1:snaprec-a-0123456789ab");
    expect(assertDrillProject(scope.creator)).toBe(scope.creator);
  });

  test("nonces distintos producen scopes desechables disjuntos (sin colisión entre corridas)", () => {
    const a = jointScope(hexNonce());
    const b = jointScope(hexNonce());
    expect(a.creator).not.toBe(b.creator);
    expect(a.restorer).not.toBe(b.restorer);
  });
});

describe("registro joint: parse estricto (fail-closed)", () => {
  test("registro válido se parsea y correlaciona", () => {
    const rec = jointRecordFixture();
    const parsed = parseJointRecord(rec);
    expect(parsed).not.toBeNull();
    expect(parsed!.nonce).toBe(rec.nonce);
    expect(parsed!.project).toBe("snaprec-a-" + rec.nonce);
    expect(parsed!.state).toBe("prepared");
  });

  test("rechaza registros malformados o de otro scope", () => {
    const rec = jointRecordFixture();
    const cases: Array<[string, unknown]> = [
      ["version", { ...rec, version: 2 }],
      ["kind", { ...rec, kind: "otro" }],
      ["project personal", { ...rec, project: "personal", scope: { ...rec.scope, creator: "personal" } }],
      ["project = restorer", { ...rec, project: rec.scope.restorer }],
      ["scope.creator", { ...rec, scope: { ...rec.scope, creator: "snaprec-a-zzzzzzzzzzzz" } }],
      ["scope.restorer", { ...rec, scope: { ...rec.scope, restorer: "snaprec-c-" + rec.nonce } }],
      ["nonce formato", { ...rec, nonce: "NOPE" }],
      ["runId corto", { ...rec, runId: "abc" }],
      ["markerPath", { ...rec, markerPath: "/abs/path.txt" }],
      ["markerPath traversal", { ...rec, markerPath: "../escape.txt" }],
      ["markerContent vacío", { ...rec, markerContent: "" }],
      ["markerSha256", { ...rec, markerSha256: "x".repeat(64) }],
      ["manifestSha256", { ...rec, manifestSha256: 42 }],
      ["snapshotId", { ...rec, snapshotId: "" }],
      ["snapshotSavedAt", { ...rec, snapshotSavedAt: "ayer" }],
      ["image", { ...rec, image: 7 }],
      ["identitySha256", { ...rec, identitySha256: "z".repeat(64) }],
      ["state", { ...rec, state: "released" }],
      ["stateSince", { ...rec, stateSince: "x" }],
      ["createdAt", { ...rec, createdAt: "no-es-fecha" }],
      ["null", null], ["string", "hola"], ["array", []]
    ];
    for (const [name, value] of cases) {
      expect(parseJointRecord(value)).toBeNull();
    }
  });
});

describe("handle privado: ancla estable e independiente del checkpoint normal", () => {
  test("jointHandleFrom/parseJointHandle: ida y vuelta estricta", () => {
    const rec = jointRecordFixture();
    const handle = jointHandleFrom(rec);
    const expected: JointHandle = {
      version: 1, kind: "joint-rollback-handle-v1",
      nonce: rec.nonce, snapshotId: rec.snapshotId, savedAt: rec.snapshotSavedAt
    };
    expect(handle).toEqual(expected);
    expect(parseJointHandle(handle)).toEqual(expected);
    expect(parseJointHandle(handle, rec.nonce)).toEqual(expected);
    const bad: Array<[string, unknown]> = [
      ["null", null],
      ["string", "hola"],
      ["version", { ...expected, version: 2 }],
      ["kind", { ...expected, kind: "otro" }],
      ["nonce formato", { ...expected, nonce: "NOPE" }],
      ["snapshotId vacío", { ...expected, snapshotId: "" }],
      ["snapshotId traversal", { ...expected, snapshotId: "../escape" }],
      ["savedAt", { ...expected, savedAt: "ayer" }],
      ["savedAt infinito", { ...expected, savedAt: Number.POSITIVE_INFINITY }]
    ];
    for (const [name, value] of bad) {
      expect(parseJointHandle(value)).toBeNull();
    }
    // Nonce ajeno en la correlación: null (fail-closed).
    expect(parseJointHandle(handle, "ffffffffffff")).toBeNull();
  });

  test("classifyJointLiveHandle: match, rotated, missing, diverged", () => {
    const rec = jointRecordFixture();
    expect(classifyJointLiveHandle(rec, rec.snapshotId, rec.snapshotSavedAt)).toBe("match");
    // El checkpoint normal del DO rota las claves compartidas hacia ADELANTE.
    expect(classifyJointLiveHandle(rec, "chk-opencode-workspace-nuevo", rec.snapshotSavedAt + 120_000))
      .toBe("rotated");
    expect(classifyJointLiveHandle(rec, null, null)).toBe("missing");
    expect(classifyJointLiveHandle(rec, "otro-id", rec.snapshotSavedAt)).toBe("diverged");
    expect(classifyJointLiveHandle(rec, rec.snapshotId, rec.snapshotSavedAt - 1)).toBe("diverged");
  });
});

describe("correlación de metadata y caducidad", () => {
  test("metadata mismatch: registro de otro nonce/scope es rechazado", () => {
    const rec = jointRecordFixture();
    const otherNonce = hexNonce();
    expect(() => assertJointRecordIdentity(rec, otherNonce)).toThrow(/JOINT_METADATA_MISMATCH/);
    expect(() => assertJointRecordIdentity(rec, rec.nonce)).not.toThrow();
  });

  test("handle ausente o borrado indebido aborta antes de destruir nada", () => {
    const rec = jointRecordFixture();
    expect(() => assertJointHandleMatch(rec, rec.snapshotId, rec.snapshotSavedAt)).not.toThrow();
    expect(() => assertJointHandleMatch(rec, null, rec.snapshotSavedAt))
      .toThrow(/JOINT_HANDLE_MISMATCH/);
    expect(() => assertJointHandleMatch(rec, "snapshot-otro", rec.snapshotSavedAt))
      .toThrow(/JOINT_HANDLE_MISMATCH/);
    expect(() => assertJointHandleMatch(rec, rec.snapshotId, rec.snapshotSavedAt + 1))
      .toThrow(/JOINT_HANDLE_MISMATCH/);
  });

  test("registro vencido: verify es rehusado (joint_cleanup requerido)", () => {
    const rec = jointRecordFixture({ snapshotSavedAt: Date.now() - JOINT_PREPARE_TTL_MS - 1 });
    expect(() => assertJointVerifyState(rec, Date.now())).toThrow(/JOINT_EXPIRED/);
  });

  test("estado distinto de prepared no se verifica", () => {
    const rec = jointRecordFixture({ state: "verifying" });
    expect(() => assertJointVerifyState(rec, Date.now())).toThrow(/JOINT_STATE_INVALID/);
    const fresh = jointRecordFixture();
    expect(() => assertJointVerifyState(fresh, Date.now())).not.toThrow();
  });
});

describe("verify fail-closed con host falso: nada se destruye ante metadata inválida", () => {
  test("handle ausente: sin registro, verify rechaza y NO toca nada", async () => {
    const { host, store, calls } = fakeHost();
    await expect(jointVerifyCleanupDrill(host, hexNonce()))
      .rejects.toThrow(/JOINT_METADATA_MISSING/);
    expect(calls.ensureRunning).toBe(0);
    expect(store.size).toBe(0);
  });

  test("borrado indebido: registro vivo pero handle PRIVADO eliminado (solo claves compartidas NO bastan)", async () => {
    const rec = jointRecordFixture();
    const { host, store, calls } = fakeHost({
      [JOINT_RECORD_KEY]: rec, snapshotId: rec.snapshotId, savedAt: rec.snapshotSavedAt
    });
    await expect(jointVerifyCleanupDrill(host, rec.nonce))
      .rejects.toThrow(/JOINT_HANDLE_MISMATCH/);
    expect(calls.ensureRunning).toBe(0);
    expect(store.get(JOINT_RECORD_KEY)).toEqual(rec);
  });

  test("divergencia del handle privado vs registro: rechazo antes de tocar nada", async () => {
    const rec = jointRecordFixture();
    const tampered: JointHandle = { ...jointHandleFrom(rec), snapshotId: "tampered-snapshot-id" };
    const { host, store, calls } = fakeHost({
      [JOINT_RECORD_KEY]: rec, [JOINT_HANDLE_KEY]: tampered,
      snapshotId: rec.snapshotId, savedAt: rec.snapshotSavedAt
    });
    await expect(jointVerifyCleanupDrill(host, rec.nonce))
      .rejects.toThrow(/JOINT_HANDLE_MISMATCH/);
    expect(calls.ensureRunning).toBe(0);
    expect(store.get(JOINT_RECORD_KEY)).toEqual(rec);
  });

  test("INCIDENTE REAL 20261113 (nonce 871ea5456848): claves compartidas rotadas y sin handle privado => JOINT_HANDLE_MISMATCH, sin efectos", async () => {
    // Replica EXACTA del estado que produjo passed:false en
    // oc_v1_joint_verify_20261113_01: el registro quedó anclado al snapshot
    // 56a36205-4bee-4b07-b5f8-95ba55634d90 (savedAt 1794535902230) mientras el
    // checkpoint normal del DO sobrescribía las claves compartidas. Con el
    // handle privado ausente (estado pre-fix) el verify sigue fail-closed.
    const rec = incidentRecord({ snapshotSavedAt: 1794535902230 });
    const { host, store, calls } = fakeHost({
      [JOINT_RECORD_KEY]: rec,
      snapshotId: "chk-opencode-workspace-rotado",
      savedAt: rec.snapshotSavedAt + 123_000
    });
    await expect(jointVerifyCleanupDrill(host, rec.nonce))
      .rejects.toThrow(/JOINT_HANDLE_MISMATCH/);
    expect(calls.ensureRunning).toBe(0);
    expect(store.get(JOINT_RECORD_KEY)).toEqual(rec);
    expect(store.has(JOINT_RECEIPT_KEY)).toBeUndefined();
  });

  test("rotación del checkpoint normal durante la ventana: el verify PROSIGUE (gate en el handle privado)", async () => {
    const rec = jointRecordFixture();
    const { host, store, calls } = fakeHost(seedScope(rec, {
      snapshotId: "chk-opencode-workspace-rotado",
      savedAt: rec.snapshotSavedAt + 120_000
    }));
    // Sin Container en el fake: el gate de metadata PASA (ya no hay
    // JOINT_HANDLE_MISMATCH por rotación) y la fase de Container falla de
    // forma controlada; el dispose terminal limpia y deja recibo.
    const outcome = await jointVerifyCleanupDrill(host, rec.nonce);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/Linux Container binding/);
    expect(outcome.metadataSurvived.handleMatchesRecord).toBe(true);
    expect(outcome.metadataSurvived.privateHandleVerified).toBe(true);
    expect(outcome.metadataSurvived.sharedHandleState).toBe("rotated");
    expect(outcome.handleDeleted).toBe(4);
    expect(outcome.receipt?.outcome).toBe("failed");
    expect(calls.ensureRunning).toBe(0);
    // Terminal disposal: el scope joint queda muerto (4 claves vivas).
    expect(store.has(JOINT_RECORD_KEY)).toBe(false);
    expect(store.has(JOINT_HANDLE_KEY)).toBe(false);
    expect(store.has("snapshotId")).toBe(false);
    expect(store.has("savedAt")).toBe(false);
    expect(store.has(JOINT_RECEIPT_KEY)).toBe(true);
  });

  test("handle privado íntegro con claves compartidas borradas: evidencia 'missing', verify prosigue", async () => {
    const rec = jointRecordFixture();
    const { host } = fakeHost({
      [JOINT_RECORD_KEY]: rec, [JOINT_HANDLE_KEY]: jointHandleFrom(rec)
    });
    const outcome = await jointVerifyCleanupDrill(host, rec.nonce);
    expect(outcome.metadataSurvived.sharedHandleState).toBe("missing");
    expect(outcome.metadataSurvived.snapshotId).toBeNull();
    expect(outcome.error).toMatch(/Linux Container binding/);
  });

  test("nonce incorrecto en la invocación: mismatch, sin efectos", async () => {
    const rec = jointRecordFixture();
    const { host, store, calls } = fakeHost(seedScope(rec));
    await expect(jointVerifyCleanupDrill(host, hexNonce()))
      .rejects.toThrow(/JOINT_METADATA_MISMATCH/);
    expect(calls.ensureRunning).toBe(0);
    expect(store.get(JOINT_RECORD_KEY)).toEqual(rec);
  });

  test("registro vencido: verify rechaza y exige joint_cleanup", async () => {
    const rec = jointRecordFixture({ snapshotSavedAt: Date.now() - JOINT_PREPARE_TTL_MS - 1 });
    const { host, store, calls } = fakeHost(seedScope(rec));
    await expect(jointVerifyCleanupDrill(host, rec.nonce)).rejects.toThrow(/JOINT_EXPIRED/);
    expect(calls.ensureRunning).toBe(0);
    expect(store.get(JOINT_RECORD_KEY)).toEqual(rec);
  });

  test("verificación ya en vuelo: segundo verify concurrente es rechazado", async () => {
    const rec = jointRecordFixture({ state: "verifying", stateSince: Date.now() });
    const { host, store, calls } = fakeHost(seedScope(rec));
    await expect(jointVerifyCleanupDrill(host, rec.nonce)).rejects.toThrow(/JOINT_STATE_INVALID/);
    expect(calls.ensureRunning).toBe(0);
    expect(store.get(JOINT_RECORD_KEY)).toEqual(rec);
  });
});

describe("lease de verificación y limpieza de emergencia", () => {
  test("jointEmergencyAllowed: solo el lease fresco de verifying bloquea", () => {
    const now = Date.now();
    expect(jointEmergencyAllowed(null, now)).toBe(true);
    const prepared = jointRecordFixture({ state: "prepared", stateSince: now });
    expect(jointEmergencyAllowed(prepared, now)).toBe(true);
    const inFlight = jointRecordFixture({ state: "verifying", stateSince: now });
    expect(jointEmergencyAllowed(inFlight, now)).toBe(false);
    const staleLease = jointRecordFixture({
      state: "verifying", stateSince: now - JOINT_VERIFY_LEASE_MS - 1
    });
    expect(jointEmergencyAllowed(staleLease, now)).toBe(true);
  });

  test("emergencia durante verify en vuelo: bloqueada, nada se toca", async () => {
    const rec = jointRecordFixture({ state: "verifying", stateSince: Date.now() });
    const { host, store } = fakeHost(seedScope(rec));
    await expect(jointEmergencyCleanupDrill(host, rec.nonce, "prueba"))
      .rejects.toThrow(/JOINT_VERIFY_IN_FLIGHT/);
    expect(store.get(JOINT_RECORD_KEY)).toEqual(rec);
    expect(store.get(JOINT_RECEIPT_KEY)).toBeUndefined();
  });

  test("emergencia sobre scope prepared: borra SOLO las 4 claves vivas y deja recibo", async () => {
    const rec = jointRecordFixture();
    const { host, store } = fakeHost(seedScope(rec, {
      lastActivity: 123456, "recovery-drill-record-v1": { x: 1 },
      "opencode-fake-foreign-key": "keep-me"
    }));
    const result = await jointEmergencyCleanupDrill(host, rec.nonce, "prueba de emergencia");
    expect(result.containerDestroyed).toBe(false); // no container in fake
    expect(result.handleDeleted).toBe(4);
    expect(result.alreadyClean).toBe(false);
    expect(store.has(JOINT_RECORD_KEY)).toBe(false);
    expect(store.has(JOINT_HANDLE_KEY)).toBe(false);
    expect(store.has("snapshotId")).toBe(false);
    expect(store.has("savedAt")).toBe(false);
    // lastActivity is refreshed (kept, fail-closed reuse guard) and foreign
    // lifecycle keys are NEVER deleted by the drill cleanup.
    expect(store.has("lastActivity")).toBe(true);
    expect(store.has("recovery-drill-record-v1")).toBe(true);
    expect(store.has("opencode-fake-foreign-key")).toBe(true);
    const receipt = parseJointReceipt(store.get(JOINT_RECEIPT_KEY));
    expect(receipt?.outcome).toBe("emergency");
    expect(receipt?.nonce).toBe(rec.nonce);
    expect(receipt?.snapshotId).toBe(rec.snapshotId);
    expect(receipt?.reason).toBe("prueba de emergencia");
  });

  test("emergencia es idempotente: segunda pasada reporta alreadyClean", async () => {
    const rec = jointRecordFixture();
    const { host, store } = fakeHost(seedScope(rec));
    const first = await jointEmergencyCleanupDrill(host, rec.nonce, "primera");
    expect(first.alreadyClean).toBe(false);
    expect(first.handleDeleted).toBe(4);
    const second = await jointEmergencyCleanupDrill(host, rec.nonce, "segunda");
    expect(second.alreadyClean).toBe(true);
    expect(second.handleDeleted).toBe(0);
    expect(parseJointReceipt(store.get(JOINT_RECEIPT_KEY))?.reason).toBe("segunda");
  });

  test("recibo no se deja falsificar: parseJointReceipt estricto", () => {
    const receipt = jointReceipt({
      outcome: "emergency", nonce: "0123456789ab",
      scope: jointScope("0123456789ab"), reason: "prueba"
    });
    expect(parseJointReceipt(receipt)?.nonce).toBe("0123456789ab");
    expect(parseJointReceipt({ ...receipt, kind: "otro" })).toBeNull();
    expect(parseJointReceipt({ ...receipt, outcome: "verified" })).not.toBeNull();
    expect(parseJointReceipt({ ...receipt, nonce: "ffffffffffff" })).toBeNull();
    expect(parseJointReceipt({ ...receipt, snapshotId: "../traversal" })).toBeNull();
    expect(parseJointReceipt(null)).toBeNull();
  });
});

describe("joint_prepare: idempotencia y fail-closed (host falso)", () => {
  test("replay: registro fresco del MISMO nonce devuelve el mismo handle sin nuevo snapshot", async () => {
    const rec = jointRecordFixture();
    const { host, calls } = fakeHost(seedScope(rec));
    const result = await jointPrepareDrill(host, rec.nonce);
    expect(result.replayed).toBe(true);
    expect(result.snapshotId).toBe(rec.snapshotId);
    expect(result.record.createdAt).toBe(rec.createdAt);
    expect(calls.ensureRunning).toBe(0);
  });

  test("replay REGRESIVO de rotación: NO reescribe claves compartidas rotadas por el checkpoint", async () => {
    const rec = jointRecordFixture();
    const rotated = { snapshotId: "chk-opencode-workspace-nuevo", savedAt: rec.snapshotSavedAt + 120_000 };
    const { host, store, calls } = fakeHost(seedScope(rec, rotated));
    const result = await jointPrepareDrill(host, rec.nonce);
    expect(result.replayed).toBe(true);
    expect(result.snapshotId).toBe(rec.snapshotId);
    // Las claves compartidas siguen en el checkpoint MÁS NUEVO del ciclo de
    // vida: arrastrarlas hacia atrás haría que la próxima recuperación
    // restaurara una versión anterior (restauración desde versión equivocada).
    expect(store.get("snapshotId")).toBe(rotated.snapshotId);
    expect(store.get("savedAt")).toBe(rotated.savedAt);
    expect(calls.ensureRunning).toBe(0);
  });

  test("replay repara el handle privado ausente (migración pre-fix) desde el registro verificado", async () => {
    const rec = jointRecordFixture();
    const { host, store, calls } = fakeHost({
      [JOINT_RECORD_KEY]: rec, snapshotId: rec.snapshotId, savedAt: rec.snapshotSavedAt
    });
    const result = await jointPrepareDrill(host, rec.nonce);
    expect(result.replayed).toBe(true);
    expect(store.get(JOINT_HANDLE_KEY)).toEqual(jointHandleFrom(rec));
    expect(calls.ensureRunning).toBe(0);
  });

  test("scope ocupado por OTRO nonce: rechazado (colisión)", async () => {
    const rec = jointRecordFixture();
    const { host, calls } = fakeHost({ [JOINT_RECORD_KEY]: rec });
    await expect(jointPrepareDrill(host, hexNonce())).rejects.toThrow(/JOINT_METADATA_MISMATCH/);
    expect(calls.ensureRunning).toBe(0);
  });

  test("registro vencido o en verifying: prepare rehusado", async () => {
    const expired = jointRecordFixture({ snapshotSavedAt: Date.now() - JOINT_PREPARE_TTL_MS - 1 });
    const h1 = fakeHost({ [JOINT_RECORD_KEY]: expired });
    await expect(jointPrepareDrill(h1.host, expired.nonce)).rejects.toThrow(/JOINT_EXPIRED/);
    const verifying = jointRecordFixture({ state: "verifying", stateSince: Date.now() });
    const h2 = fakeHost({ [JOINT_RECORD_KEY]: verifying });
    await expect(jointPrepareDrill(h2.host, verifying.nonce)).rejects.toThrow(/JOINT_STATE_INVALID/);
  });

  test("scope limpio sin container disponible: falla SIN dejar registro a medias", async () => {
    const nonce = hexNonce();
    const { host, store } = fakeHost();
    await expect(jointPrepareDrill(host, nonce)).rejects.toThrow(/no container available/);
    expect(store.has(JOINT_RECORD_KEY)).toBe(false);
    expect(store.has(JOINT_HANDLE_KEY)).toBe(false);
    expect(store.has("snapshotId")).toBe(false);
    expect(store.has("savedAt")).toBe(false);
  });
});

describe("sesión/Container no aislado: rechazo fuera del scope desechable", () => {
  test("slugs no desechables son rechazados por la guardia", () => {
    for (const slug of ["personal", "supervised-0123456789abcdef", "repo-opencode-harness-example"]) {
      expect(() => assertDrillProject(slug)).toThrow();
    }
    expect(() => assertDrillProject(jointScope("0123456789ab").creator)).not.toThrow();
  });
});

describe("prueba sintética retenida: integración real corta con node", () => {
  const hasNode = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;

  function runDrill(env: Record<string, string>) {
    return spawnSync("node", ["--input-type=module", "-e", DRILL_SOURCE], {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
  }

  test("el registro joint se construye desde una ejecución REAL y sobrevive el parse", async () => {
    if (!hasNode) throw new Error("node is required");
    const root = mkdtempSync(join(tmpdir(), "joint-live-"));
    const nonce = hexNonce();
    const project = jointScope(nonce).creator;
    const runId = randomUUID().replace(/-/g, "").slice(0, 16);
    try {
      const create = parseDrillReport(runDrill({
        DRILL_ROOT: root, DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_PHASE: "create"
      }).stdout ?? "", "create");
      expect(create?.ok).toBe(true);
      // Cross-check real bytes vs the DO-side anchor (same as jointPrepare).
      const markerReal = readFileSync(join(root, create!.markerRelPath));
      expect(sha(markerReal)).toBe(create!.markerSha256);
      // Build the JointRecord exactly like jointPrepareDrill does and prove
      // the strict parser accepts it; the synthetic test + metadata survive
      // the parse that the verify phase will run after the Worker rollback.
      const record: JointRecord = {
        version: 1, kind: "joint-rollback-record-v1",
        project, scope: jointScope(nonce), nonce, runId,
        markerPath: create!.markerRelPath,
        markerContent: create!.markerContent,
        markerSha256: create!.markerSha256,
        manifestSha256: create!.manifestSha256,
        snapshotId: "snapshot-joint-" + runId,
        snapshotSavedAt: Date.now(),
        image: null, identitySha256: create!.identitySha256,
        state: "prepared", stateSince: Date.now(),
        createdAt: new Date().toISOString()
      };
      expect(parseJointRecord(record)?.markerSha256).toBe(create!.markerSha256);
      // The PRIVATE handle derived from the real record parses and matches.
      expect(parseJointHandle(jointHandleFrom(record), nonce)).toEqual(jointHandleFrom(record));
      // Malformed hash (not hex64) is refused by the strict parser...
      expect(parseJointRecord({ ...record, markerSha256: "x".repeat(64) })).toBeNull();
      // ...while a well-formed but TAMPERED hash passes the format check and
      // is caught by the DO-side cross-check that jointPrepare enforces
      // (hashText(markerContent) must equal the recorded anchor).
      const tampered = { ...record, markerSha256: "f".repeat(64) };
      expect(parseJointRecord(tampered)).not.toBeNull();
      expect(await hashText(tampered.markerContent)).not.toBe(tampered.markerSha256);

      // Receipt roundtrip from the REAL record.
      const receipt = jointReceipt({
        outcome: "verified", nonce, scope: jointScope(nonce), record
      });
      expect(parseJointReceipt(receipt)?.markerSha256).toBe(create!.markerSha256);

      // Pristine disk = what a real snapshot restore must look like.
      const pristine = runDrill({
        DRILL_ROOT: root, DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_PHASE: "verify",
        DRILL_EXPECT_SHA256: record.markerSha256,
        DRILL_EXPECT_MANIFEST_SHA: record.manifestSha256,
        DRILL_MUTATION_ABSENT: "1"
      });
      expect(pristine.status).toBe(0);
      expect(parseDrillReport(pristine.stdout ?? "", "verify")?.ok).toBe(true);

      // Negative control: mutate the live disk AFTER the snapshot anchor was
      // taken; a verification demanding the pristine anchor MUST fail.
      const mutate = parseDrillReport(runDrill({
        DRILL_ROOT: root, DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_PHASE: "mutate"
      }).stdout ?? "", "mutate");
      expect(mutate?.ok).toBe(true);
      const negative = runDrill({
        DRILL_ROOT: root, DRILL_PROJECT: project, DRILL_RUN_ID: runId, DRILL_PHASE: "verify",
        DRILL_EXPECT_SHA256: record.markerSha256,
        DRILL_EXPECT_MANIFEST_SHA: record.manifestSha256,
        DRILL_MUTATION_ABSENT: "1"
      });
      expect(negative.status).not.toBe(0);
      expect(existsSync(join(root, mutate!.mutationFileRelPath))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

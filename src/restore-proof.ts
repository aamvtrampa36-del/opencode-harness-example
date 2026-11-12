/**
 * Real, isolated rehearsal of the Container snapshot recovery path:
 * snapshotContainer() -> destroy() -> start({containerSnapshot}).
 *
 * The rehearsal NEVER touches the personal Container, canonical project
 * containers or any pre-existing instance. It only accepts a freshly created
 * Durable Object whose name is reserved for tests ("restore-proof-v1:<id>")
 * and rejects any DO with prior state. Its own state machine lives in DO
 * storage under "restore-proof-*" keys, so a Workflow can resume the proof
 * after any eviction without ever reusing or destroying real instances.
 *
 * Fail-closed rules (any hit means ok:false, never a synthetic PASS):
 *   - no compatible snapshot (API missing, call failed, id unusable);
 *   - unknown image digest (container.inspect() unusable or changed);
 *   - marker/sha256 not verifiable after the restart;
 *   - DO storage datum missing or mismatched after the restart.
 *
 * The Cloudflare Containers API requires durable_object scheduling, keeps
 * snapshots for 30 days, does not restore running processes and does not
 * allow changing the image on restart: the snapshot start options below
 * deliberately contain no `image` key, and a contract test pins that.
 */

import { normalizeImageRef } from "./container-verify";

/** Test-exclusive Durable Object namespace; never used by personal or project workspaces. */
export const RESTORE_PROOF_PREFIX = "restore-proof-v1:";
export const RESTORE_PROOF_STATE_KEY = "restore-proof-state";
export const RESTORE_PROOF_DATUM_KEY = "restore-proof-datum";

const FIXTURE_ID = /^[a-f0-9]{16}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9._-]{8,256}$/;

/** Only a 16 hex character fixture id is accepted; every other string fails closed. */
export function validateRestoreProofFixtureId(raw: unknown): string {
  if (typeof raw !== "string" || !FIXTURE_ID.test(raw)) {
    throw new Error("restore-proof: se requiere un id de prueba de 16 caracteres hexadecimales");
  }
  return raw;
}

export function restoreProofFixtureName(raw: unknown): string {
  return RESTORE_PROOF_PREFIX + validateRestoreProofFixtureId(raw);
}

export type RestoreProofPhase =
  | "primed" | "snapshotted" | "destroyed" | "restored" | "verifying"
  | "verified" | "failed";

/** Durable datum written BEFORE the restart and queried again AFTER it. */
export type RestoreProofDatum = {
  version: "restore-proof-v1";
  runId: string;
  payloadSha256: string;
  nonceSha256: string;
  imageRef: string;
  at: number;
};

export type RestoreProofState = {
  id: string;
  runId: string;
  phase: RestoreProofPhase;
  createdAt: number;
  updatedAt: number;
  payloadSha256?: string;
  nonceSha256?: string;
  imageRef?: string;
  snapshotId?: string;
  snapshotName?: string;
  failures?: string[];
  error?: string;
};

export type RestoreProofFsCheck = { step: string; status: "pass" | "fail"; detail?: string };

export type RestoreProofFsReport = {
  ok: boolean;
  mode: "prime" | "verify";
  runId: string;
  payloadSha256: string | null;
  nonceSha256: string | null;
  bytes: number | null;
  checks: RestoreProofFsCheck[];
};

export type RestoreProofReport = {
  ok: boolean;
  phase: RestoreProofPhase;
  id: string;
  runId: string;
  liveProof: "restore-round-trip" | "failed" | "blocked";
  snapshotId: string | null;
  snapshotName: string | null;
  imageRef: string | null;
  payloadSha256: string | null;
  nonceSha256: string | null;
  datumVerified: boolean;
  fsReport: RestoreProofFsReport | null;
  failures: string[];
  artifactsKept: boolean;
  error?: string;
};

/**
 * Reject any DO with prior state. Must run before ANY container interaction:
 * a DO with storage history may belong to real work and is never reused.
 */
export function assertRestoreProofFresh(existingKeys: readonly string[]): void {
  if (existingKeys.length > 0) {
    throw new Error("restore-proof: solo se admite un DO recién creado; este ya tiene estado previo");
  }
}

/** Dependency-free Node program executed with: node --input-type=module -e */
export const FS_RESTORE_PROOF_SOURCE = String.raw`
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const PREFIX = "RESTORE_PROOF_REPORT:";
const HEX64 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{16}$/;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const emit = (report) => { process.stdout.write(PREFIX + JSON.stringify(report) + "\n"); };
const checks = [];
const step = (name, pass, detail) => {
  checks.push({ step: name, status: pass ? "pass" : "fail", detail: detail || "" });
  return pass;
};
const empty = () => ({ payloadSha256: null, nonceSha256: null, bytes: null });
const finish = (ok, extra) => {
  emit({ ok, mode, runId, payloadSha256: extra.payloadSha256, nonceSha256: extra.nonceSha256, bytes: extra.bytes, checks });
  process.exit(ok ? 0 : 1);
};

const mode = process.env.RESTORE_PROOF_MODE === "verify" ? "verify"
  : process.env.RESTORE_PROOF_MODE === "prime" ? "prime" : null;
const runId = String(process.env.RESTORE_PROOF_RUN_ID || "");
const root = String(process.env.RESTORE_PROOF_ROOT || "");
if (!mode || !RUN_ID.test(runId) || !root.startsWith("/") ||
    root.includes("..") || !/^[A-Za-z0-9._/-]{1,200}$/.test(root)) {
  step("preflight", false, "invalid RESTORE_PROOF_MODE, RESTORE_PROOF_RUN_ID or RESTORE_PROOF_ROOT");
  finish(false, empty());
}

const dir = root + "/__restore-proof-" + runId;
const payloadPath = dir + "/marker-payload.bin";
const noncePath = dir + "/marker-nonce.txt";
const manifestPath = dir + "/marker-manifest.json";

if (mode === "prime") {
  let ready = true;
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    ready = step("prime-dir", false, String((error && error.message) || error).slice(0, 200));
  }
  if (!ready) finish(false, empty());
  const payload = randomBytes(65536);
  const nonce = randomBytes(32).toString("hex");
  const payloadSha = sha256(payload);
  const nonceSha = sha256(nonce);
  writeFileSync(payloadPath, payload);
  writeFileSync(noncePath, nonce, "utf8");
  writeFileSync(manifestPath, JSON.stringify({
    runId, createdAt: new Date().toISOString(),
    payloadSha256: payloadSha, nonceSha256: nonceSha, bytes: payload.byteLength
  }, null, 2));
  const payloadBack = readFileSync(payloadPath);
  const nonceBack = readFileSync(noncePath, "utf8");
  let manifestOk = false;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifestOk = m.runId === runId && m.payloadSha256 === payloadSha && m.nonceSha256 === nonceSha;
  } catch { manifestOk = false; }
  const readback = sha256(payloadBack) === payloadSha && nonceBack === nonce;
  step("prime-readback", readback && manifestOk, "marker files written and read back with matching anchors");
  step("prime-anchor", HEX64.test(payloadSha) && HEX64.test(nonceSha), "payload and nonce anchored by SHA-256");
  finish(readback && manifestOk, { payloadSha256: payloadSha, nonceSha256: nonceSha, bytes: payload.byteLength });
}

const expectPayload = String(process.env.RESTORE_PROOF_EXPECT_PAYLOAD_SHA || "");
const expectNonce = String(process.env.RESTORE_PROOF_EXPECT_NONCE_SHA || "");
if (!HEX64.test(expectPayload) || !HEX64.test(expectNonce)) {
  step("preflight-anchors", false, "expected SHA-256 anchors missing or malformed");
  finish(false, empty());
}

const payloadPresent = existsSync(payloadPath);
const noncePresent = existsSync(noncePath);
const manifestPresent = existsSync(manifestPath);
step("marker-present", payloadPresent && noncePresent && manifestPresent,
  "all three marker files must survive the container restart");

let payloadSha = null, nonceSha = null, bytes = null;
if (payloadPresent) {
  const data = readFileSync(payloadPath);
  payloadSha = sha256(data);
  bytes = data.byteLength;
}
if (noncePresent) nonceSha = sha256(readFileSync(noncePath, "utf8"));

step("payload-sha256", payloadSha === expectPayload,
  "restored payload SHA-256 equals the pre-restart anchor");
step("nonce-sha256", nonceSha === expectNonce,
  "restored nonce SHA-256 equals the pre-restart anchor");

let manifestOk = false, manifestPayload = null, manifestNonce = null;
try {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifestPayload = typeof m.payloadSha256 === "string" ? m.payloadSha256 : null;
  manifestNonce = typeof m.nonceSha256 === "string" ? m.nonceSha256 : null;
  manifestOk = m.runId === runId;
} catch { manifestOk = false; }
const manifestConsistent = manifestOk && manifestPayload === payloadSha && manifestNonce === nonceSha;
step("manifest-consistency", manifestConsistent, "manifest matches restored files and run identity");

finish(payloadSha === expectPayload && nonceSha === expectNonce && manifestConsistent, {
  payloadSha256: payloadSha, nonceSha256: nonceSha, bytes
});
`;

const REPORT_PREFIX = "RESTORE_PROOF_REPORT:";

/** Strict parser: anything malformed becomes null so callers fail closed. */
export function parseRestoreProofReport(stdout: string): RestoreProofFsReport | null {
  const start = stdout.lastIndexOf(REPORT_PREFIX);
  if (start < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start + REPORT_PREFIX.length).split("\n")[0]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.ok !== true && r.ok !== false) return null;
  if (r.mode !== "prime" && r.mode !== "verify") return null;
  if (typeof r.runId !== "string" || !FIXTURE_ID.test(r.runId)) return null;
  if (!Array.isArray(r.checks) || r.checks.length === 0) return null;
  const parsedChecks: RestoreProofFsCheck[] = [];
  for (const item of r.checks) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    if (typeof c.step !== "string" || !c.step || (c.status !== "pass" && c.status !== "fail")) return null;
    parsedChecks.push({
      step: c.step,
      status: c.status,
      ...(typeof c.detail === "string" ? { detail: c.detail } : {})
    });
  }
  const hash = (value: unknown): string | null =>
    typeof value === "string" && HEX64.test(value) ? value : null;
  let bytes: number | null = null;
  if (typeof r.bytes === "number") {
    if (!Number.isSafeInteger(r.bytes) || r.bytes < 0) return null;
    bytes = r.bytes;
  } else if (r.bytes !== null && r.bytes !== undefined) {
    return null;
  }
  return {
    ok: r.ok === true,
    mode: r.mode,
    runId: r.runId,
    payloadSha256: hash(r.payloadSha256),
    nonceSha256: hash(r.nonceSha256),
    bytes,
    checks: parsedChecks
  };
}

/**
 * Fail-closed evaluation of the post-restart world. Every mismatch is a
 * failure; an absent anchor, datum or snapshot is a failure too.
 */
export function evaluateRestoreProof(observation: {
  runId: string;
  snapshotId: string | null | undefined;
  imageRefAfter: string | null;
  imageRefBefore?: string | null;
  datum: RestoreProofDatum | null | undefined;
  fs: RestoreProofFsReport | null;
}): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const { runId } = observation;
  if (typeof observation.snapshotId !== "string" || !SNAPSHOT_ID.test(observation.snapshotId)) {
    failures.push("no hay snapshot compatible: falta el identificador o no es utilizable");
  }
  const datum = observation.datum;
  if (!datum) {
    failures.push("el dato escrito en DO storage falta después del reinicio");
  } else {
    if (datum.version !== "restore-proof-v1") failures.push("el dato de DO storage tiene una versión desconocida");
    if (datum.runId !== runId) failures.push("el dato de DO storage pertenece a otro ensayo");
  }
  const fs = observation.fs;
  if (!fs) {
    failures.push("el programa de verificación no produjo un informe analizable");
  } else {
    if (fs.mode !== "verify") failures.push("el informe del filesystem no corresponde al modo verify");
    if (fs.runId !== runId) failures.push("el informe del filesystem pertenece a otro ensayo");
    if (!fs.ok) {
      const failed = fs.checks.filter(c => c.status === "fail").map(c => c.step).join(", ");
      failures.push("la verificación del filesystem falló: " + (failed || "checks incompletos"));
    }
    const payloadAnchors = [fs.payloadSha256, datum?.payloadSha256];
    if (!payloadAnchors.every(a => typeof a === "string" && HEX64.test(a)) ||
        new Set(payloadAnchors).size !== 1) {
      failures.push("el sha256 del marker no es verificable tras el reinicio");
    }
    const nonceAnchors = [fs.nonceSha256, datum?.nonceSha256];
    if (!nonceAnchors.every(a => typeof a === "string" && HEX64.test(a)) ||
        new Set(nonceAnchors).size !== 1) {
      failures.push("el sha256 del nonce no es verificable tras el reinicio");
    }
  }
  if (!observation.imageRefAfter) {
    failures.push("image digest desconocido tras el reinicio");
  } else if (datum && observation.imageRefAfter !== datum.imageRef) {
    failures.push("la imagen del Container cambió respecto del dato previo al reinicio");
  } else if (observation.imageRefBefore && observation.imageRefAfter !== observation.imageRefBefore) {
    failures.push("la imagen del Container cambió respecto del ancla previa");
  }
  return { ok: failures.length === 0, failures };
}

/** Structural subset used by the driver; the real Container satisfies it. */
export type RestoreProofExecOptions = {
  env?: Record<string, string>;
  signal?: AbortSignal;
};
export type RestoreProofExecOutput = {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
};
export type RestoreProofContainer = {
  running: boolean;
  exec(argv: readonly string[], options?: RestoreProofExecOptions): Promise<{
    output(): Promise<RestoreProofExecOutput>;
  }>;
  inspect(): Promise<{ image?: unknown } | null>;
  snapshotContainer(input: { name: string }): Promise<{ id?: unknown }>;
  destroy(reason?: string): Promise<void>;
  start(options: Record<string, unknown>): void | Promise<void>;
};

/** Narrow storage interface satisfied by DurableObjectStorage and by test fakes. */
export type RestoreProofStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
  list(options?: { limit?: number }): Promise<Map<string, unknown>>;
};

export type RestoreProofIo = {
  id: string;
  storage: RestoreProofStorage;
  container: RestoreProofContainer | null;
  /** Filesystem root for markers; "/workspace" in the real Container. */
  root?: string;
  now?: number;
};

const BASE_IMAGE = "cloudflare/debian-trixie";
const START_OPTIONS_BASE = {
  entrypoint: ["sleep", "infinity"],
  enableInternet: true,
  instance: "basic"
};
const POLL_MS = 200;
const POLL_ATTEMPTS = 300;
const EXEC_TIMEOUT_MS = 120_000;
const MAX_STEPS = 8;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function failReport(
  state: RestoreProofState,
  failures: string[],
  error?: unknown
): RestoreProofReport {
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  if (message) state.error = message;
  if (failures.length > 0) state.failures = failures;
  else if (!state.failures || state.failures.length === 0) {
    state.failures = [message || "restore-proof: el ensayo falló"];
  }
  state.updatedAt = Date.now();
  return {
    ok: false,
    phase: state.phase,
    id: state.id,
    runId: state.runId,
    liveProof: "failed",
    snapshotId: state.snapshotId ?? null,
    snapshotName: state.snapshotName ?? null,
    imageRef: state.imageRef ?? null,
    payloadSha256: state.payloadSha256 ?? null,
    nonceSha256: state.nonceSha256 ?? null,
    datumVerified: false,
    fsReport: null,
    failures: state.failures,
    artifactsKept: true,
    ...(state.error ? { error: state.error } : {})
  };
}

async function waitUntilRunning(container: RestoreProofContainer): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (container.running) return;
    await sleep(POLL_MS);
  }
  throw new Error("restore-proof: el Container de prueba no quedó en ejecución tras el arranque");
}

async function runProgram(
  container: RestoreProofContainer,
  env: Record<string, string>
): Promise<{ output: RestoreProofExecOutput; report: RestoreProofFsReport | null }> {
  const handle = await container.exec(
    ["node", "--input-type=module", "-e", FS_RESTORE_PROOF_SOURCE],
    { env, signal: AbortSignal.timeout(EXEC_TIMEOUT_MS) }
  );
  const output = await handle.output();
  const report = parseRestoreProofReport(decode(output.stdout));
  return { output, report };
}

/**
 * Resumable proof driver. Each phase persists BEFORE the next risky
 * operation so a Workflow can resume after eviction by calling again.
 * The fixture Container is destroyed and restarted only here, only from a
 * base image or from the snapshot taken inside this same rehearsal.
 */
export async function runRestoreProofFixture(io: RestoreProofIo): Promise<RestoreProofReport> {
  const storage = io.storage;
  let state = await storage.get<RestoreProofState>(RESTORE_PROOF_STATE_KEY);
  if (!state) {
    // Fail closed BEFORE anything else: a DO with prior state is never reused.
    const existing = await storage.list({ limit: 1 });
    assertRestoreProofFresh([...existing.keys()]);
    if (io.container?.running) {
      throw new Error("restore-proof: el DO de prueba ya tiene un Container en ejecución sin estado; no se tocará");
    }
    const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    state = {
      id: validateRestoreProofFixtureId(io.id),
      runId,
      phase: "primed",
      createdAt: io.now ?? Date.now(),
      updatedAt: io.now ?? Date.now()
    };
    await storage.put(RESTORE_PROOF_STATE_KEY, state);
  }
  if (state.id !== io.id) {
    state.phase = "failed";
    return failReport(state, ["restore-proof: el estado pertenece a otro ensayo de prueba"]);
  }

  const failures: string[] = [];
  try {
    for (let guard = 0; guard < MAX_STEPS; guard++) {
      if (state.phase === "verified") {
        return {
          ok: true, phase: state.phase, id: state.id, runId: state.runId,
          liveProof: "restore-round-trip",
          snapshotId: state.snapshotId ?? null, snapshotName: state.snapshotName ?? null,
          imageRef: state.imageRef ?? null,
          payloadSha256: state.payloadSha256 ?? null, nonceSha256: state.nonceSha256 ?? null,
          datumVerified: true, fsReport: null, failures: [], artifactsKept: false
        };
      }
      if (state.phase === "failed") {
        return {
          ok: false, phase: state.phase, id: state.id, runId: state.runId,
          liveProof: "failed",
          snapshotId: state.snapshotId ?? null, snapshotName: state.snapshotName ?? null,
          imageRef: state.imageRef ?? null,
          payloadSha256: state.payloadSha256 ?? null, nonceSha256: state.nonceSha256 ?? null,
          datumVerified: false, fsReport: null,
          failures: state.failures ?? [], artifactsKept: true
        };
      }
      if (state.phase === "primed") {
        const container = io.container;
        if (!container) throw new Error("restore-proof: la API de Container no está disponible en este runtime");
        if (!container.running) {
          // Fresh fixture: base managed image, same options as production boot.
          await container.start({ ...START_OPTIONS_BASE, image: BASE_IMAGE });
        }
        await waitUntilRunning(container);
        const prime = await runProgram(container, {
          RESTORE_PROOF_MODE: "prime",
          RESTORE_PROOF_ROOT: io.root ?? "/workspace",
          RESTORE_PROOF_RUN_ID: state.runId
        });
        if (prime.output.exitCode !== 0 || !prime.report || !prime.report.ok) {
          throw new Error("restore-proof: la escritura del marker falló (exitCode=" + prime.output.exitCode + ")");
        }
        const info = await container.inspect().catch(() => null);
        const imageRef = normalizeImageRef(info?.image);
        if (!imageRef) throw new Error("restore-proof: image digest desconocido antes del snapshot");
        const datum: RestoreProofDatum = {
          version: "restore-proof-v1",
          runId: state.runId,
          payloadSha256: prime.report.payloadSha256 as string,
          nonceSha256: prime.report.nonceSha256 as string,
          imageRef,
          at: Date.now()
        };
        await storage.put(RESTORE_PROOF_DATUM_KEY, datum);
        state.payloadSha256 = datum.payloadSha256;
        state.nonceSha256 = datum.nonceSha256;
        state.imageRef = imageRef;
        state.phase = "snapshotted";
        state.updatedAt = Date.now();
        await storage.put(RESTORE_PROOF_STATE_KEY, state);
        continue;
      }
      if (state.phase === "snapshotted") {
        const container = io.container;
        if (!container) throw new Error("restore-proof: la API de Container no está disponible en este runtime");
        if (typeof container.snapshotContainer !== "function") {
          throw new Error("restore-proof: container.snapshotContainer() no está disponible: no hay snapshot compatible");
        }
        const snapshotName = "restore-proof-" + state.runId;
        const snapshot = await container.snapshotContainer({ name: snapshotName });
        const snapshotId = typeof snapshot?.id === "string" ? snapshot.id : "";
        if (!SNAPSHOT_ID.test(snapshotId)) {
          throw new Error("restore-proof: el snapshot devuelto no tiene un identificador utilizable");
        }
        state.snapshotId = snapshotId;
        state.snapshotName = snapshotName;
        state.phase = "destroyed";
        state.updatedAt = Date.now();
        await storage.put(RESTORE_PROOF_STATE_KEY, state);
        continue;
      }
      if (state.phase === "destroyed") {
        const container = io.container;
        if (!container) throw new Error("restore-proof: la API de Container no está disponible en este runtime");
        if (!state.snapshotId) throw new Error("restore-proof: no hay snapshot compatible para el reinicio");
        if (container.running) await container.destroy("restore-proof-restart");
        state.phase = "restored";
        state.updatedAt = Date.now();
        await storage.put(RESTORE_PROOF_STATE_KEY, state);
        continue;
      }
      if (state.phase === "restored") {
        const container = io.container;
        if (!container) throw new Error("restore-proof: la API de Container no está disponible en este runtime");
        if (!state.snapshotId) throw new Error("restore-proof: no hay snapshot compatible para el reinicio");
        // The Containers API does not allow changing the image on restart:
        // containerSnapshot only, never an `image` key.
        await container.start({
          ...START_OPTIONS_BASE,
          containerSnapshot: { id: state.snapshotId }
        });
        await waitUntilRunning(container);
        state.phase = "verifying";
        state.updatedAt = Date.now();
        await storage.put(RESTORE_PROOF_STATE_KEY, state);
        continue;
      }
      if (state.phase === "verifying") {
        const container = io.container;
        if (!container) throw new Error("restore-proof: la API de Container no está disponible en este runtime");
        if (!state.payloadSha256 || !state.nonceSha256 || !state.imageRef || !state.snapshotId) {
          throw new Error("restore-proof: faltan anclas del estado para verificar");
        }
        const verify = await runProgram(container, {
          RESTORE_PROOF_MODE: "verify",
          RESTORE_PROOF_ROOT: io.root ?? "/workspace",
          RESTORE_PROOF_RUN_ID: state.runId,
          RESTORE_PROOF_EXPECT_PAYLOAD_SHA: state.payloadSha256,
          RESTORE_PROOF_EXPECT_NONCE_SHA: state.nonceSha256
        });
        const info = await container.inspect().catch(() => null);
        const imageRefAfter = normalizeImageRef(info?.image);
        const datum = await storage.get<RestoreProofDatum>(RESTORE_PROOF_DATUM_KEY);
        const verdict = evaluateRestoreProof({
          runId: state.runId,
          snapshotId: state.snapshotId,
          imageRefAfter,
          imageRefBefore: state.imageRef,
          datum,
          fs: verify.report
        });
        failures.push(...verdict.failures);
        if (verify.output.exitCode !== 0 && verdict.ok) {
          failures.push("el programa de verificación terminó con error pese a checks correctos");
        }
        const ok = verdict.ok && verify.output.exitCode === 0;
        state.phase = ok ? "verified" : "failed";
        state.failures = failures;
        state.updatedAt = Date.now();
        await storage.put(RESTORE_PROOF_STATE_KEY, state);
        return {
          ok, phase: state.phase, id: state.id, runId: state.runId,
          liveProof: ok ? "restore-round-trip" : "failed",
          snapshotId: state.snapshotId, snapshotName: state.snapshotName ?? null,
          imageRef: imageRefAfter ?? state.imageRef ?? null,
          payloadSha256: verify.report?.payloadSha256 ?? state.payloadSha256 ?? null,
          nonceSha256: verify.report?.nonceSha256 ?? state.nonceSha256 ?? null,
          datumVerified: ok && Boolean(datum),
          fsReport: verify.report,
          failures,
          artifactsKept: !ok
        };
      }
    }
    throw new Error("restore-proof: la máquina de estados no avanzó a un resultado terminal");
  } catch (error) {
    state.phase = "failed";
    return failReport(state, failures, error);
  }
}

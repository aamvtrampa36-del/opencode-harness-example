import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./external-backup";
import {
  applyRestorePlan, assertManifestDigest, assertR2Bucket, assertSupervisorEnabled,
  buildSessionBackupManifest, buildSqlSnapshot, captureNormalReads, captureNormalReadFingerprints, deleteSessionBackupPrefix,
  digestRestoredTables, drillExportSnapshot, drillExportSnapshotToR2, drillRestoreFromR2,
  drillVerifyFromR2, drillRestoreWipe, downloadVerifiedSessionBackup,
  isOwnedSessionBackupKey, normalReadFingerprints, parseSessionBackupManifest, parseSqlSnapshot,
  restorePlanStatements, sessionBackupDrillScope, sessionBackupKeys, uploadSessionBackup,
  validateSessionBackupDrillCommand, verifyNormalReadFingerprints, verifyRestoredContentSync,
  verifySnapshotJson, SESSION_V2_TABLE, type CatalogTable, type SqlLike
} from "./session-sql-backup";

const RUN_ID = "sqlbak-0123456789ab";
const CREATE_SESSION = 'CREATE TABLE `opencode_session_v2` (`id` text PRIMARY KEY,`title` text,`time_created` integer NOT NULL)';
const CREATE_MESSAGE = 'CREATE TABLE `opencode_session_message` (`id` text PRIMARY KEY,`session_id` text NOT NULL,`type` text,`payload` text,`time_created` integer NOT NULL, FOREIGN KEY (`session_id`) REFERENCES `opencode_session_v2`(`id`) ON DELETE CASCADE)';

type FakeTable = { createSql: string; columns: string[]; rows: Record<string, unknown>[] };

async function digestHex(text: string): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(raw).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** In-memory SqlLike stub: supports exactly the queries the module issues. */
function fakeSql(tables: Record<string, FakeTable>): SqlLike {
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (query.includes("FROM sqlite_master")) {
        return {
          columnNames: ["name", "sql"],
          toArray: () => Object.entries(tables).map(([name, t]) => ({ name, sql: t.createSql }))
        };
      }
      const selectMatch = query.match(/^SELECT \* FROM "([^"]+)"/);
      if (selectMatch) {
        const table = tables[selectMatch[1]];
        if (!table) throw new Error("no such table: " + selectMatch[1]);
        if (query.endsWith("WHERE 0")) {
          return { columnNames: table.columns, toArray: () => [] };
        }
        return {
          columnNames: table.columns,
          toArray: () => table.rows
            .filter(row => !query.includes("WHERE \"key\" <> 'models-dev:catalog'") || row.key !== "models-dev:catalog")
            .map(row => {
            const clone: Record<string, unknown> = {};
            for (const column of table.columns) clone[column] = row[column] ?? null;
            return clone;
          })
        };
      }
      const insertMatch = query.match(/^INSERT INTO "([^"]+)" \(([^)]*)\) VALUES \((.*)\)$/);
      if (insertMatch) {
        const table = tables[insertMatch[1]];
        if (!table) throw new Error("no such table: " + insertMatch[1]);
        const columns = insertMatch[2].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
        const row: Record<string, unknown> = {};
        columns.forEach((column, i) => { row[column] = bindings[i]; });
        table.rows.push(row);
        return { columnNames: [], toArray: () => [] };
      }
      const deleteMatch = query.match(/^DELETE FROM "([^"]+)"$/);
      if (deleteMatch) {
        const table = tables[deleteMatch[1]];
        if (!table) throw new Error("no such table: " + deleteMatch[1]);
        table.rows = [];
        return { columnNames: [], toArray: () => [] };
      }
      const countMatch = query.match(/^SELECT COUNT\(\*\) AS n FROM "([^"]+)"(?: WHERE "key" <> 'models-dev:catalog')?$/);
      if (countMatch) {
        const table = tables[countMatch[1]];
        if (!table) throw new Error("no such table: " + countMatch[1]);
        const actual = query.includes("WHERE \"key\" <> 'models-dev:catalog'")
          ? table.rows.filter(row => row.key !== "models-dev:catalog").length
          : table.rows.length;
        return { columnNames: ["n"], toArray: () => [{ n: actual }] };
      }
      throw new Error("unsupported fake SQL: " + query);
    }
  };
}

const baseTables = (): Record<string, FakeTable> => ({
  opencode_app_settings: {
    createSql: 'CREATE TABLE `opencode_app_settings` (`key` text PRIMARY KEY,`value` text)',
    columns: ["key", "value"], rows: [{ key: "lang", value: "es" }]
  },
  [SESSION_V2_TABLE]: {
    createSql: CREATE_SESSION,
    columns: ["id", "title", "time_created"],
    rows: [
      { id: "ses_a1", title: null, time_created: 1794420000000 },
      { id: "ses_b2", title: "Ensayo", time_created: 1794420005000 }
    ]
  },
  opencode_session_message: {
    createSql: CREATE_MESSAGE,
    columns: ["id", "session_id", "type", "payload", "time_created"],
    rows: [{ id: "msg_1", session_id: "ses_b2", type: "user", payload: "Responde exactamente con: B2_OK", time_created: 1794420001000 }]
  },
  // Internal SQLite and app tables (no `opencode_` prefix) must be excluded.
  sqlite_stat1: { createSql: "internal", columns: ["tbl", "idx", "stat"], rows: [{ tbl: "x", idx: null, stat: "1 1" }] }
});

const catalogOf = (tables: Record<string, FakeTable>): CatalogTable[] =>
  Object.entries(tables)
    .filter(([name]) => name.startsWith("opencode_"))
    .map(([name, t]) => ({
      name, createSql: t.createSql, columns: t.columns,
      rowCount: name === "opencode_kv"
        ? t.rows.filter(row => row.key !== "models-dev:catalog").length
        : t.rows.length
    }));

function harnessOf(list: Array<{ id: string }>, history: Record<string, unknown[]> = {}) {
  return {
    sessions: {
      list: async () => list,
      create: async () => ({ id: "ses_new_" + (list.length + 1) })
    },
    session: (id: string) => ({
      history: async () => history[id] ?? [],
      busy: async () => false,
      submit: async () => ({ id: "op_1" }),
      abort: async () => true
    })
  };
}

async function makeSnapshot() {
  const built = await buildSqlSnapshot(fakeSql(baseTables()), "2026-11-13T00:00:00.000Z");
  return { built, snapshot: await verifySnapshotJson(built.snapshotJson, built.snapshotSha256) };
}

describe("B2 SQL snapshot building", () => {
  test("snapshots only opencode_ tables with stable canonical digests", async () => {
    const { built } = await makeSnapshot();
    expect(built.body.tables.map(t => t.name))
      .toEqual(["opencode_app_settings", "opencode_session_message", SESSION_V2_TABLE]);
    expect(built.totalRows).toBe(4);
    expect(built.snapshotJson).not.toContain("sqlite_stat1");
    const rebuilt = await buildSqlSnapshot(fakeSql(baseTables()), "2026-11-13T00:00:00.000Z");
    expect(rebuilt.snapshotSha256).toBe(built.snapshotSha256);
    expect(rebuilt.body.tableSetFingerprint).toBe(built.body.tableSetFingerprint);
  });

  test("round-trips: parse, verify, plan, apply and re-digest restore identical rows", async () => {
    const { built, snapshot } = await makeSnapshot();
    expect(parseSqlSnapshot(JSON.parse(built.snapshotJson))).not.toBeNull();
    const plan = restorePlanStatements(snapshot, catalogOf(baseTables()));
    // Deletes run children-first (reverse order), inserts run parents-first.
    expect(plan.tableOrder.indexOf(SESSION_V2_TABLE))
      .toBeLessThan(plan.tableOrder.indexOf("opencode_session_message"));
    expect(plan.statements.filter(s => s.text.startsWith("DELETE")).length).toBe(3);
    expect(plan.statements[0].text.startsWith('DELETE FROM "opencode_session_message"')).toBe(true);
    // The target starts pre-populated (replace mode wipes it inside the plan).
    const target = fakeSql(baseTables());
    applyRestorePlan(target, plan);
    verifyRestoredContentSync(target, plan, snapshot);
    const digests = await digestRestoredTables(target, snapshot, plan.tableOrder);
    for (const entry of digests) {
      expect(entry.sha256).toBe(plan.expectedDigests[entry.name]);
    }
  });

  test("session backup excludes only regenerable model catalogue, not user KV", async () => {
    const tables = baseTables();
    tables.opencode_kv = {
      createSql: 'CREATE TABLE `opencode_kv` (`key` text PRIMARY KEY,`value` text)',
      columns: ["key", "value"],
      rows: [
        { key: "models-dev:catalog", value: "regenerable-large-cache" },
        { key: "session:important-setting", value: "must survive restore" }
      ]
    };
    const built = await buildSqlSnapshot(fakeSql(tables), "2026-11-13T00:00:00.000Z");
    const snapshot = await verifySnapshotJson(built.snapshotJson, built.snapshotSha256);
    const kv = snapshot.tables.find(t => t.name === "opencode_kv")!;
    expect(kv.rowCount).toBe(1);
    expect(kv.rows).toEqual([{ key: "session:important-setting", value: "must survive restore" }]);
    const targetTables = baseTables();
    targetTables.opencode_kv = { ...tables.opencode_kv, rows: [] };
    const plan = restorePlanStatements(snapshot, catalogOf(targetTables));
    const realTarget = fakeSql(targetTables);
    applyRestorePlan(realTarget, plan);
    verifyRestoredContentSync(realTarget, plan, snapshot);
    const digests = await digestRestoredTables(realTarget, snapshot, plan.tableOrder);
    expect(digests.find(t => t.name === "opencode_kv")?.rowCount).toBe(1);
  });

  test("SQLite foreign keys insert parent before dependent; cycles are rejected", async () => {
    const tables = baseTables();
    tables.opencode_event_sequence = {
      createSql: 'CREATE TABLE `opencode_event_sequence` (`aggregate_id` text PRIMARY KEY)',
      columns: ["aggregate_id"], rows: [{ aggregate_id: "event_root" }]
    };
    tables.opencode_event = {
      createSql: 'CREATE TABLE `opencode_event` (`id` text PRIMARY KEY,`aggregate_id` text, FOREIGN KEY (`aggregate_id`) REFERENCES `opencode_event_sequence`(`aggregate_id`))',
      columns: ["id", "aggregate_id"], rows: [{ id: "evt_a", aggregate_id: "event_root" }]
    };
    const built = await buildSqlSnapshot(fakeSql(tables), "2026-11-13T00:00:00.000Z");
    const snapshot = await verifySnapshotJson(built.snapshotJson, built.snapshotSha256);
    const plan = restorePlanStatements(snapshot, catalogOf(tables));
    expect(plan.tableOrder.indexOf("opencode_event_sequence"))
      .toBeLessThan(plan.tableOrder.indexOf("opencode_event"));
    expect(plan.tableOrder.indexOf(SESSION_V2_TABLE))
      .toBeLessThan(plan.tableOrder.indexOf("opencode_session_message"));
    const impossible = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    impossible.tables.find(t => t.name === "opencode_event_sequence")!.createSql =
      'CREATE TABLE `opencode_event_sequence` (id text, FOREIGN KEY(id) REFERENCES `opencode_event`(id))';
    const catalog = catalogOf(tables);
    const amended = catalog.map(t => t.name === "opencode_event_sequence" ?
      { ...t, createSql: impossible.tables.find(x => x.name === t.name)!.createSql } : t);
    expect(() => restorePlanStatements(impossible, amended)).toThrow("SQLBK_FK_CYCLE");
  });

  test("rejects unsupported value types, non-finite numbers and missing schema", async () => {
    const badObject = baseTables();
    badObject[SESSION_V2_TABLE].rows[0].title = { nested: true };
    await expect(buildSqlSnapshot(fakeSql(badObject), "2026-11-13T00:00:00.000Z"))
      .rejects.toThrow("SQLBK_UNSUPPORTED_VALUE_TYPE");
    const badNumber = baseTables();
    badNumber[SESSION_V2_TABLE].rows[0].time_created = Number.POSITIVE_INFINITY;
    await expect(buildSqlSnapshot(fakeSql(badNumber), "2026-11-13T00:00:00.000Z"))
      .rejects.toThrow("SQLBK_NON_FINITE_NUMBER");
    await expect(buildSqlSnapshot(fakeSql({}), "2026-11-13T00:00:00.000Z"))
      .rejects.toThrow("SQLBK_SCHEMA_MISSING");
  });

  test("refuses to export credential-like tables that contain rows", async () => {
    const secret = baseTables();
    secret.opencode_credential = {
      createSql: 'CREATE TABLE `opencode_credential` (`id` text PRIMARY KEY,`secret` text)',
      columns: ["id", "secret"],
      rows: [{ id: "c1", secret: "hunter2" }]
    };
    await expect(buildSqlSnapshot(fakeSql(secret), "2026-11-13T00:00:00.000Z"))
      .rejects.toThrow("SQLBK_SECRET_TABLE_NOT_EXPORTED");
    const empty = baseTables();
    empty.opencode_credential = {
      createSql: 'CREATE TABLE `opencode_credential` (`id` text PRIMARY KEY,`secret` text)',
      columns: ["id", "secret"], rows: []
    };
    const built = await buildSqlSnapshot(fakeSql(empty), "2026-11-13T00:00:00.000Z");
    expect(built.snapshotJson).toContain("opencode_credential");
  });

  test("verifySnapshotJson rejects tampering, non-canonical input and bad digests", async () => {
    const { built } = await makeSnapshot();
    await expect(verifySnapshotJson(built.snapshotJson, "0".repeat(64)))
      .rejects.toThrow("SQLBK_SNAPSHOT_DIGEST_MISMATCH");
    await expect(verifySnapshotJson(built.snapshotJson, "nothex"))
      .rejects.toThrow("SQLBK_SNAPSHOT_DIGEST_UNTRUSTED");
    await expect(verifySnapshotJson("{}", await digestHex("{}")))
      .rejects.toThrow("SQLBK_SNAPSHOT_MALFORMED");
    // Byte-level tampering with the original digest is refused.
    const byteTampered = built.snapshotJson.replace("ses_a1", "ses_zz");
    await expect(verifySnapshotJson(byteTampered, built.snapshotSha256))
      .rejects.toThrow("SQLBK_SNAPSHOT_DIGEST_MISMATCH");
    // A structurally valid snapshot with a wrong per-table digest is refused.
    const tableTampered = JSON.parse(built.snapshotJson) as { tables: { sha256: string }[] };
    tableTampered.tables[0].sha256 = "f".repeat(64);
    const tableTamperedJson = canonicalJson(tableTampered);
    await expect(verifySnapshotJson(tableTamperedJson, await digestHex(tableTamperedJson)))
      .rejects.toThrow("SQLBK_TABLE_DIGEST_MISMATCH");
    // A wrong table-set fingerprint is refused too.
    const setTampered = JSON.parse(built.snapshotJson) as { tableSetFingerprint: string };
    setTampered.tableSetFingerprint = "e".repeat(64);
    const setTamperedJson = canonicalJson(setTampered);
    await expect(verifySnapshotJson(setTamperedJson, await digestHex(setTamperedJson)))
      .rejects.toThrow("SQLBK_TABLESET_DIGEST_MISMATCH");
  });
});

describe("B2 restore planner rejections", () => {
  test("rejects missing table, different CREATE SQL, different columns and extra target table", async () => {
    const { snapshot } = await makeSnapshot();
    const missing = catalogOf(baseTables()).filter(t => t.name !== "opencode_app_settings");
    expect(() => restorePlanStatements(snapshot, missing)).toThrow("SQLBK_SCHEMA_MISMATCH:falta");
    const differentCreate = catalogOf(baseTables());
    differentCreate[0] = { ...differentCreate[0], createSql: differentCreate[0].createSql + " " };
    expect(() => restorePlanStatements(snapshot, differentCreate)).toThrow("SQLBK_SCHEMA_MISMATCH:create");
    const differentColumns = catalogOf(baseTables()).map(t =>
      t.name === SESSION_V2_TABLE ? { ...t, columns: [...t.columns, "extra"] } : t);
    expect(() => restorePlanStatements(snapshot, differentColumns)).toThrow("SQLBK_SCHEMA_MISMATCH:columnas");
    const extra = [...catalogOf(baseTables()), { name: "opencode_surprise", createSql: "x", columns: ["a"], rowCount: 0 }];
    expect(() => restorePlanStatements(snapshot, extra)).toThrow("SQLBK_SCHEMA_MISMATCH:adicional");
  });

  test("replace-mode deletes pre-existing rows and still yields snapshot digests", async () => {
    const { snapshot } = await makeSnapshot();
    const plan = restorePlanStatements(snapshot, catalogOf(baseTables()));
    const target = fakeSql(baseTables());
    applyRestorePlan(target, plan);
    verifyRestoredContentSync(target, plan, snapshot);
  });
});

describe("B2 normal read fingerprints", () => {
  test("sequential normal-read fingerprints match the existing digest contract", async () => {
    const source = harnessOf([{ id: "ses_1" }, { id: "ses_2" }], {
      ses_1: [{ type: "user", text: "hola" }],
      ses_2: [{ type: "assistant", text: "B2_OK" }]
    });
    const previous = await normalReadFingerprints(await captureNormalReads(source));
    const compact = await captureNormalReadFingerprints(source);
    expect(compact).toEqual(previous);
  });

  test("same ids in the same order with same content pass", async () => {
    const harness = harnessOf([{ id: "ses_1" }, { id: "ses_2" }], {
      ses_1: [], ses_2: [{ type: "user", text: "hola" }]
    });
    const expected = await normalReadFingerprints(await captureNormalReads(harness));
    const outcome = verifyNormalReadFingerprints(expected, await normalReadFingerprints(await captureNormalReads(harness)));
    expect(outcome.ok).toBe(true);
  });

  test("count, order, missing history and content mismatches fail closed", async () => {
    const expected = { sessionIds: ["ses_1", "ses_2"], historyDigests: { ses_1: "a".repeat(64), ses_2: "b".repeat(64) } };
    expect(verifyNormalReadFingerprints(expected, { sessionIds: ["ses_1"], historyDigests: {} }).reason).toBe("SQLBK_SESSION_COUNT_MISMATCH");
    expect(verifyNormalReadFingerprints(expected, { sessionIds: ["ses_2", "ses_1"], historyDigests: expected.historyDigests }).reason).toBe("SQLBK_SESSION_ORDER_MISMATCH:0");
    expect(verifyNormalReadFingerprints(expected, { sessionIds: ["ses_1", "ses_2"], historyDigests: { ses_1: "a".repeat(64) } }).reason).toBe("SQLBK_HISTORY_MISSING:ses_2");
    const altered = { sessionIds: ["ses_1", "ses_2"], historyDigests: { ses_1: "a".repeat(64), ses_2: "c".repeat(64) } };
    const content = verifyNormalReadFingerprints(expected, altered);
    expect(content.ok).toBe(false);
    expect(content.mismatchedHistory).toEqual(["ses_2"]);
  });
});

describe("B2 scope, keys and guards", () => {
  test("scope and key derivation validate their inputs", () => {
    const scope = sessionBackupDrillScope("0123456789ab");
    expect(scope).toEqual({ runId: RUN_ID, source: "opencode-sqlbak-a-0123456789ab", restore: "opencode-sqlbak-b-0123456789ab" });
    expect(() => sessionBackupDrillScope("ZZZ")).toThrow("nonce");
    const keys = sessionBackupKeys(RUN_ID);
    expect(keys.snapshot).toBe("opencode-sqlbk-v1/" + RUN_ID + "/snapshot.json");
    expect(() => sessionBackupKeys("sqlbak-short")).toThrow("runId");
    expect(isOwnedSessionBackupKey(keys.manifest)).toBe(true);
    expect(isOwnedSessionBackupKey("opencode-sqlbk-v1/other/x.json")).toBe(false);
    expect(isOwnedSessionBackupKey("opencode-extbk-v1/" + RUN_ID + "/x.json")).toBe(false);
  });

  test("supervisor flag and command shape are enforced", () => {
    expect(() => assertSupervisorEnabled({})).toThrow("SUPERVISOR_DISABLED");
    expect(() => assertSupervisorEnabled({ OPENCODE_SUPERVISOR_ENABLED: "1" })).toThrow("SUPERVISOR_DISABLED");
    expect(() => assertSupervisorEnabled({ OPENCODE_SUPERVISOR_ENABLED: "true" })).not.toThrow();
    expect(() => validateSessionBackupDrillCommand({ action: "session_backup_drill" })).not.toThrow();
    expect(() => validateSessionBackupDrillCommand({ action: "session_backup_drill", extra: 1 })).toThrow("UNKNOWN_SESSIONBK_FIELD");
    expect(() => validateSessionBackupDrillCommand({ action: "recovery_drill" })).toThrow("UNKNOWN_SESSIONBK_FIELD");
    expect(() => validateSessionBackupDrillCommand("string")).toThrow();
  });

  test("the R2 binding is never simulated when absent", () => {
    expect(() => assertR2Bucket(undefined, "test")).toThrow("R2 binding no disponible");
  });

  test("wipe fails closed without a deleteAll capability", async () => {
    await expect(drillRestoreWipe({ OPENCODE_SUPERVISOR_ENABLED: "true" }, {}))
      .rejects.toThrow("SQLBK_WIPE_UNAVAILABLE");
    let wiped = false;
    const outcome = await drillRestoreWipe({ OPENCODE_SUPERVISOR_ENABLED: "true" }, {
      deleteAll: async () => { wiped = true; }
    });
    expect(wiped).toBe(true);
    expect(outcome).toEqual({ ok: true, wiped: true });
  });
});

describe("B2 R2 transport", () => {
  function memoryBucket(initial: Array<{ key: string; body: string }> = []) {
    const store = new Map(initial.map(item => [item.key, item.body]));
    return {
      put: async (key: string, value: Uint8Array, options?: { sha256?: string }) => {
        if (options?.sha256) {
          const digest = await crypto.subtle.digest("SHA-256", value);
          const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
          if (hex !== options.sha256) return null;
        }
        store.set(key, new TextDecoder().decode(value));
        return { key, size: value.length };
      },
      get: async (key: string) => {
        const body = store.get(key);
        return body === undefined ? null : {
          key, size: new TextEncoder().encode(body).length, arrayBuffer: async () => new TextEncoder().encode(body).buffer
        };
      },
      head: async (key: string) => {
        const body = store.get(key);
        return body === undefined ? null : { key, size: new TextEncoder().encode(body).length };
      },
      list: async (options: { prefix?: string; limit?: number }) => ({
        objects: [...store.keys()].filter(k => !options.prefix || k.startsWith(options.prefix))
          .map(key => ({ key, size: new TextEncoder().encode(store.get(key) ?? "").length })),
        truncated: false
      }),
      delete: async (keysToDelete: string | readonly string[]) => {
        for (const key of Array.isArray(keysToDelete) ? keysToDelete : [keysToDelete]) store.delete(key);
      }
    };
  }

  test("isolated DO uploads and restores real-format SQL via R2, exposing receipt only", async () => {
    const env = { OPENCODE_SUPERVISOR_ENABLED: "true" };
    const bucket = memoryBucket();
    const sourceRead = harnessOf([{ id: "ses_1" }], { ses_1: [{ type: "user", text: "hola" }] });
    const result = await drillExportSnapshotToR2(env, sourceRead, fakeSql(baseTables()), bucket, { runId: RUN_ID });
    const receipt = result as { ok: boolean; uploaded: boolean; manifestSha256: string; snapshotSha256: string; snapshotBytes: number };
    expect(receipt.ok).toBe(true);
    expect(receipt.uploaded).toBe(true);
    expect(receipt.snapshotBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("snapshotJson");
    expect(JSON.stringify(result)).not.toContain("hola");
    const target = fakeSql(baseTables());
    const storage = { transaction: async (fn: () => unknown) => fn() };
    const restored = await drillRestoreFromR2(env, target, storage, bucket,
      { runId: RUN_ID, manifestSha256: receipt.manifestSha256 }) as { ok: boolean };
    expect(restored.ok).toBe(true);
    const verified = await drillVerifyFromR2(env,
      harnessOf([{ id: "ses_1" }], { ses_1: [{ type: "user", text: "hola" }] }),
      target, bucket, { runId: RUN_ID, manifestSha256: receipt.manifestSha256 }) as { ok: boolean; normalReadsMatch: boolean };
    expect(verified.ok).toBe(true);
    expect(verified.normalReadsMatch).toBe(true);
    await expect(drillRestoreFromR2(env, fakeSql(baseTables()), storage, bucket,
      { runId: RUN_ID, manifestSha256: "0".repeat(64) }))
      .rejects.toThrow("SQLBK_MANIFEST_DIGEST_MISMATCH");
    await expect(drillRestoreFromR2(env, fakeSql(baseTables()), storage, bucket,
      { runId: RUN_ID, manifestSha256: receipt.manifestSha256, extra: "forbidden" }))
      .rejects.toThrow("SQLBK_R2_RESTORE_INPUT");
    await expect(drillVerifyFromR2(env, sourceRead, target, bucket,
      { runId: RUN_ID, manifestSha256: "0".repeat(64) }))
      .rejects.toThrow("SQLBK_MANIFEST_DIGEST_MISMATCH");
    await expect(drillExportSnapshotToR2({}, sourceRead, fakeSql(baseTables()), bucket,
      { runId: RUN_ID })).rejects.toThrow("SUPERVISOR_DISABLED");
  });

  test("upload pins digests, manifest goes last, download verifies everything", async () => {
    const { built } = await makeSnapshot();
    const reads = await captureNormalReads(harnessOf([{ id: "ses_1" }], { ses_1: [{ type: "user", text: "hola" }] }));
    const fingerprints = await normalReadFingerprints(reads);
    const manifest = buildSessionBackupManifest({
      runId: RUN_ID, createdAt: built.body.createdAt,
      snapshotJson: built.snapshotJson, snapshotSha256: built.snapshotSha256,
      snapshot: built.body, normalReads: fingerprints
    });
    const bucket = memoryBucket();
    const uploaded = await uploadSessionBackup(bucket, built.snapshotJson, built.snapshotSha256, manifest);
    expect(uploaded.manifestBytes).toBeGreaterThan(0);
    expect(uploaded.manifestSha256).toBe(await digestHex(canonicalJson(manifest)));
    await assertManifestDigest(manifest, uploaded.manifestSha256);
    const downloaded = await downloadVerifiedSessionBackup(bucket, RUN_ID, uploaded.manifestSha256);
    expect(downloaded.snapshotJson).toBe(built.snapshotJson);
    expect(downloaded.manifest.normalReads.sessionIds).toEqual(["ses_1"]);
    await expect(downloadVerifiedSessionBackup(bucket, RUN_ID, "f".repeat(64)))
      .rejects.toThrow("SQLBK_MANIFEST_DIGEST_MISMATCH");
    const removed = await deleteSessionBackupPrefix(bucket, RUN_ID);
    expect(removed.deleted).toBe(2);
    const after = await downloadVerifiedSessionBackup(bucket, RUN_ID, uploaded.manifestSha256)
      .then(() => "present", error => error instanceof Error ? error.message : "unknown");
    expect(after).toContain("SQLBK_MANIFEST_AUSENTE");
  });

  test("cleanup never touches foreign keys and refuses unknown run ids", async () => {
    const bucket = memoryBucket([
      { key: "opencode-sqlbk-v1/other-run/x.json", body: "{}" },
      { key: "opencode-sqlbk-v1/" + RUN_ID + "/snapshot.json", body: "{}" },
      { key: "opencode-sqlbk-v1/" + RUN_ID + "/unexpected.txt", body: "{}" }
    ]);
    await expect(deleteSessionBackupPrefix(bucket, RUN_ID))
      .rejects.toThrow("ajenas");
    await expect(deleteSessionBackupPrefix(bucket, "sqlbak-bad")).rejects.toThrow("runId");
  });

  test("the manifest parser rejects tampered fields", () => {
    const minimal = {
      schema: "opencode.session-sql-backup.v1",
      runId: RUN_ID,
      createdAt: "2026-11-13T00:00:00.000Z",
      snapshotKey: sessionBackupKeys(RUN_ID).snapshot,
      manifestKey: sessionBackupKeys(RUN_ID).manifest,
      snapshotSha256: "a".repeat(64),
      snapshotBytes: 10,
      tableSetFingerprint: "b".repeat(64),
      tables: [{ name: SESSION_V2_TABLE, rowCount: 0, sha256: "c".repeat(64) }],
      normalReads: { sessionIds: ["ses_1"], historyDigests: { ses_1: "d".repeat(64) } }
    };
    expect(parseSessionBackupManifest(minimal)).not.toBeNull();
    for (const mutate of [
      (m: Record<string, unknown>) => { m.schema = "other"; },
      (m: Record<string, unknown>) => { m.runId = "sqlbak-ffffffffffff"; },
      (m: Record<string, unknown>) => { m.snapshotKey = "other/key.json"; },
      (m: Record<string, unknown>) => { m.snapshotSha256 = "short"; },
      (m: Record<string, unknown>) => { m.snapshotBytes = 0; },
      (m: Record<string, unknown>) => { m.tables = [{ name: "opencode_credential", rowCount: 3, sha256: "c".repeat(64) }]; },
      (m: Record<string, unknown>) => { m.normalReads = { sessionIds: [], historyDigests: {} }; },
      (m: Record<string, unknown>) => { (m.normalReads as Record<string, unknown>).historyDigests = { ghost: "d".repeat(64) }; }
    ]) {
      const copy = JSON.parse(JSON.stringify(minimal)) as Record<string, unknown>;
      mutate(copy);
      expect(parseSessionBackupManifest(copy)).toBeNull();
    }
  });

  test("export drill step builds manifest bound to the run id", async () => {
    const env = { OPENCODE_SUPERVISOR_ENABLED: "true" };
    const outcome = await drillExportSnapshot(env, harnessOf([{ id: "ses_1" }], { ses_1: [] }), fakeSql(baseTables()), { runId: RUN_ID });
    const data = outcome as { manifest: { runId: string }; manifestSha256: string; snapshotSha256: string };
    expect(data.manifest.runId).toBe(RUN_ID);
    await assertManifestDigest(data.manifest, data.manifestSha256);
    await expect(drillExportSnapshot(env, harnessOf([]), fakeSql(baseTables()), { runId: "bad" }))
      .rejects.toThrow("INVALID_SESSIONBK_RUN_ID");
    await expect(drillExportSnapshot(env, harnessOf([]), fakeSql(baseTables()), { runId: RUN_ID, extra: 1 }))
      .rejects.toThrow("UNKNOWN_SESSIONBK_FIELD");
    await expect(drillExportSnapshot({}, harnessOf([]), fakeSql(baseTables()), { runId: RUN_ID }))
      .rejects.toThrow("SUPERVISOR_DISABLED");
  });
});

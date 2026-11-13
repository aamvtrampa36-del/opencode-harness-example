/**
 * B2 — Backup/restore drill of the OpenCodeHarness PRIVATE session SQL.
 *
 * OpenCodeHarness opens OpenCode over THIS Durable Object's storage with
 * OpenCode's tables moved under the `opencode_` prefix (see
 * `OpenCodeHarnessContext.storage` in agents/harness/opencode). The session
 * state therefore lives in the object's own SQLite database, reachable only
 * through `ctx.storage.sql` inside the object. This module plans and verifies
 * a verifiable copy of that state:
 *
 *   - Export: read every `opencode_*` table (schema + rows ordered by rowid),
 *     fingerprint the table set and each table, and never export tables whose
 *     name looks credential-like while they hold rows (fail-closed).
 *   - Transport: versioned keys under "opencode-sqlbk-v1/<runId>/" in the
 *     Staging-only RECOVERY_R2 bucket; the snapshot is pinned by SHA-256 at
 *     put() and the manifest is uploaded LAST with its own digest as the
 *     hand-off value (same commit order as the external-backup drill).
 *   - Restore: the target is a NEW disposable "opencode-sqlbak-b-*" object.
 *     It wipes itself with the atomic `deleteAll()`, opens OpenCode so the
 *     current schema is created, requires the table set and CREATE SQL to be
 *     IDENTICAL to the snapshot, and then applies every row inside ONE
 *     `storage.transaction()`. Per the Cloudflare SQLite storage contract,
 *     `sql.exec()` cannot run BEGIN/SAVEPOINT, but every storage operation —
 *     including `sql.exec()` — executed inside `storage.transaction()` is part
 *     of that transaction and rolls back if the closure throws. A synchronous
 *     readback comparison inside the transaction proves the committed content
 *     before the transaction is allowed to commit.
 *   - Verify: after the commit, per-table digests are recomputed from the
 *     restored SQL and compared with the manifest, and the normal OpenCode
 *     read path (`sessions.list()` ids in order + `session(id).history()`
 *     digests) must reproduce the fingerprints captured on the source object.
 *
 * Safety invariants (fail-closed everywhere):
 *   - Only the Workflow action `session_backup_drill` (Staging, account
 *     Workflow API) drives these DO methods; every method re-checks
 *     OPENCODE_SUPERVISOR_ENABLED and no HTTP route reaches them.
 *   - Source and restore objects are fresh disposable objects created for the
 *     drill; real user workspaces (UUIDs) and the supervisor workspace are
 *     never read, exported or restored.
 *   - Values must be JSON-faithful (string, finite number or null). Anything
 *     else aborts the export instead of silently losing data.
 *   - No row content is ever logged: results carry counts, digests and ids.
 */

import { assertR2Bucket, canonicalJson, textBytes, type R2LikeBucket } from "./external-backup";
import { sha256Hex } from "./durable-backup";

export const SESSION_SQL_BACKUP_SCHEMA = "opencode.session-sql-backup.v1";
export const SESSION_SQL_DRILL_SCHEMA = "opencode.session-sql-backup.drill.v1";
export const SESSION_SQL_FIXTURE_SCHEMA = "opencode.session-sql-backup.fixture.v1";
export const SQLBK_KEY_PREFIX = "opencode-sqlbk-v1/";
export const SQLBK_SOURCE_PREFIX = "opencode-sqlbak-a-";
export const SQLBK_RESTORE_PREFIX = "opencode-sqlbak-b-";
export const SESSION_V2_TABLE = "opencode_session_v2";
/** Fixed, secret-free fixture prompt for the one real model turn. */
export const SESSION_BK_PROMPT = "Responde exactamente con: B2_OK";

const NONCE12 = /^[a-f0-9]{12}$/;
const RUN_ID = /^sqlbak-[a-f0-9]{12}$/;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SECRET_TABLE = /credential|secret|token|api[_-]?key|private[_-]?key|passphrase|password|cookie|authorization/i;

export const MAX_SQLBK_TABLES = 64;
export const MAX_SQLBK_ROWS = 5_000;
/** Memory-bounded 16 MiB envelope; larger than actual small-fixture SQLite state but still safely limited. */
export const MAX_SNAPSHOT_CHARS = 16 * 1024 * 1024;
export const MAX_FIXTURE_SESSIONS = 8;
export const TURN_TIMEOUT_MS = 240_000;
export const TURN_POLL_MS = 5_000;

export type SqlRowValue = string | number | null;
export type SqlRow = Record<string, SqlRowValue>;

/** Structural seam over `ctx.storage.sql`; the real SqlStorage satisfies it. */
export type SqlCursorLike = { columnNames: string[]; toArray(): unknown[] };
export type SqlLike = { exec(query: string, ...bindings: unknown[]): SqlCursorLike };

/** Structural seam over `ctx.storage`; the real DurableObjectStorage satisfies it. */
export type DrillStorage = {
  transaction(fn: (txn: unknown) => unknown): Promise<unknown>;
  deleteAll?(): Promise<void>;
};

/** Structural seam over the OpenCodeHarness surface the drill needs. */
export type SessionHarnessLike = {
  sessions: {
    list(): Promise<Array<{ id: string }>>;
    create(): Promise<{ id: string }>;
  };
  session(id: string): {
    history(): Promise<unknown[]>;
    busy(): Promise<boolean>;
    submit(input: string, options?: { whenBusy?: string }): Promise<unknown>;
    abort(): Promise<unknown>;
  };
};

export type CatalogTable = {
  name: string;
  createSql: string;
  columns: string[];
  rowCount: number;
};

export type SqlTableSnapshot = {
  name: string;
  createSql: string;
  columns: string[];
  rows: SqlRow[];
  rowCount: number;
  sha256: string;
};

export type SqlSnapshotBody = {
  schema: string;
  createdAt: string;
  tables: SqlTableSnapshot[];
  tableSetFingerprint: string;
};

export type SqlSnapshot = SqlSnapshotBody;

export type NormalReads = { sessionIds: string[]; historyById: Record<string, unknown[]> };
export type NormalReadFingerprints = { sessionIds: string[]; historyDigests: Record<string, string> };

export type SessionBackupManifest = {
  schema: string;
  runId: string;
  createdAt: string;
  snapshotKey: string;
  manifestKey: string;
  snapshotSha256: string;
  snapshotBytes: number;
  tableSetFingerprint: string;
  tables: { name: string; rowCount: number; sha256: string }[];
  normalReads: NormalReadFingerprints;
};

// ---------------------------------------------------------------------------
// Access guards (defense in depth; the Workflow checks the same flag first).
// ---------------------------------------------------------------------------

export function assertSupervisorEnabled(env: unknown): void {
  const flag = (env as { OPENCODE_SUPERVISOR_ENABLED?: string } | undefined)?.OPENCODE_SUPERVISOR_ENABLED;
  if (flag !== "true") throw new Error("SUPERVISOR_DISABLED");
}

export function validateSessionBackupDrillCommand(args: unknown): void {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_SUPERVISOR_COMMAND");
  const keys = Object.keys(args as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "action" ||
      (args as Record<string, unknown>).action !== "session_backup_drill") {
    throw new Error("UNKNOWN_SESSIONBK_FIELD");
  }
}

// ---------------------------------------------------------------------------
// Scope, keys and ownership.
// ---------------------------------------------------------------------------

export function sessionBackupDrillScope(nonce: unknown): { runId: string; source: string; restore: string } {
  if (typeof nonce !== "string" || !NONCE12.test(nonce)) {
    throw new Error("Invalid session backup nonce: 12 hex characters required");
  }
  return {
    runId: "sqlbak-" + nonce,
    source: SQLBK_SOURCE_PREFIX + nonce,
    restore: SQLBK_RESTORE_PREFIX + nonce
  };
}

export function sessionBackupKeys(runId: unknown): { snapshot: string; manifest: string } {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("Invalid session backup runId");
  const base = SQLBK_KEY_PREFIX + runId + "/";
  return { snapshot: base + "snapshot.json", manifest: base + "manifest.json" };
}

/** Only keys inside this drill's versioned prefix may ever be listed/deleted. */
export function isOwnedSessionBackupKey(key: unknown): key is string {
  if (typeof key !== "string" || !key.startsWith(SQLBK_KEY_PREFIX)) return false;
  const rest = key.slice(SQLBK_KEY_PREFIX.length);
  const runId = rest.split("/")[0];
  if (!RUN_ID.test(runId) || key.includes("..")) return false;
  const allowed = sessionBackupKeys(runId);
  return key === allowed.snapshot || key === allowed.manifest;
}

// ---------------------------------------------------------------------------
// SQL catalog and snapshot building.
// ---------------------------------------------------------------------------

function validTableName(name: unknown): name is string {
  return typeof name === "string" && TABLE_NAME.test(name) && name.startsWith("opencode_");
}

/** Every `opencode_*` table with its CREATE SQL, columns and row count. */
export function readOpencodeCatalog(sql: SqlLike): CatalogTable[] {
  const master = sql.exec("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").toArray();
  const tables: CatalogTable[] = [];
  for (const entry of master) {
    const row = entry as { name?: unknown; sql?: unknown } | null;
    if (!row || !validTableName(row.name)) continue;
    if (typeof row.sql !== "string" || row.sql.length === 0) continue;
    const columns = sql.exec('SELECT * FROM "' + row.name + '" WHERE 0').columnNames.slice();
    for (const column of columns) {
      if (!COLUMN_NAME.test(column)) throw new Error("SQLBK_UNSUPPORTED_COLUMN_NAME:" + row.name + ":" + column);
    }
    const counted = sql.exec('SELECT COUNT(*) AS n FROM "' + row.name + '"').toArray();
    const n = (counted[0] as { n?: unknown } | undefined)?.n;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
      throw new Error("SQLBK_ROW_COUNT_UNREADABLE:" + row.name);
    }
    tables.push({ name: row.name, createSql: row.sql, columns, rowCount: n });
  }
  if (tables.length > MAX_SQLBK_TABLES) throw new Error("SQLBK_TOO_MANY_TABLES");
  return tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function normalizeRow(table: CatalogTable, entry: unknown, index: number): SqlRow {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("SQLBK_ROW_NOT_OBJECT:" + table.name + ":" + index);
  }
  const source = entry as Record<string, unknown>;
  const out: SqlRow = {};
  for (const column of table.columns) {
    const value = source[column];
    if (value === null) { out[column] = null; continue; }
    const type = typeof value;
    if (type === "string") { out[column] = value as string; continue; }
    if (type === "number") {
      if (!Number.isFinite(value as number)) {
        throw new Error("SQLBK_NON_FINITE_NUMBER:" + table.name + ":" + index + ":" + column);
      }
      out[column] = value as number;
      continue;
    }
    throw new Error("SQLBK_UNSUPPORTED_VALUE_TYPE:" + table.name + ":" + column);
  }
  return out;
}

async function tableDigest(name: string, columns: string[], rows: SqlRow[]): Promise<string> {
  return sha256Hex(textBytes(canonicalJson({ name, columns, rows })));
}

async function tableSnapshot(sql: SqlLike, table: CatalogTable): Promise<SqlTableSnapshot> {
  if (table.rowCount > MAX_SQLBK_ROWS) throw new Error("SQLBK_TABLE_TOO_LARGE:" + table.name);
  const raw = sql.exec('SELECT * FROM "' + table.name + '" ORDER BY rowid').toArray();
  const rows = raw.map((entry, index) => normalizeRow(table, entry, index));
  return {
    name: table.name,
    createSql: table.createSql,
    columns: table.columns,
    rows,
    rowCount: rows.length,
    sha256: await tableDigest(table.name, table.columns, rows)
  };
}

/**
 * Snapshot of the whole `opencode_` SQL state. Tables whose name looks
 * credential-like abort the export while they hold rows: the drill never
 * uploads potential secrets.
 */
export async function buildSqlSnapshot(sql: SqlLike, createdAt: string): Promise<{
  body: SqlSnapshotBody;
  snapshotJson: string;
  snapshotSha256: string;
  totalRows: number;
}> {
  const catalog = readOpencodeCatalog(sql);
  if (catalog.length === 0) {
    throw new Error("SQLBK_SCHEMA_MISSING: no hay tablas opencode_ en el almacenamiento del objeto");
  }
  const tables: SqlTableSnapshot[] = [];
  for (const table of catalog) {
    if (table.rowCount > 0 && SECRET_TABLE.test(table.name)) {
      throw new Error("SQLBK_SECRET_TABLE_NOT_EXPORTED:" + table.name);
    }
    tables.push(await tableSnapshot(sql, table));
  }
  const body: SqlSnapshotBody = {
    schema: SESSION_SQL_BACKUP_SCHEMA,
    createdAt,
    tables,
    tableSetFingerprint: await tableSetFingerprintOf(tables)
  };
  const snapshotJson = canonicalJson(body);
  if (snapshotJson.length > MAX_SNAPSHOT_CHARS) throw new Error("SQLBK_SNAPSHOT_TOO_LARGE");
  const snapshotSha256 = await sha256Hex(textBytes(snapshotJson));
  const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0);
  return { body, snapshotJson, snapshotSha256, totalRows };
}

async function tableSetFingerprintOf(tables: { name: string; createSql: string }[]): Promise<string> {
  return sha256Hex(textBytes(canonicalJson(tables.map(t => ({ name: t.name, createSql: t.createSql })))));
}

function snapshotBodyOf(snapshot: SqlSnapshot): SqlSnapshotBody {
  return {
    schema: snapshot.schema,
    createdAt: snapshot.createdAt,
    tables: snapshot.tables,
    tableSetFingerprint: snapshot.tableSetFingerprint
  };
}

/** Structural, synchronous parse; digest verification happens in verifySnapshotJson. */
export function parseSqlSnapshot(raw: unknown): SqlSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (input.schema !== SESSION_SQL_BACKUP_SCHEMA) return null;
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) return null;
  if (typeof input.tableSetFingerprint !== "string" || !HEX64.test(input.tableSetFingerprint)) return null;
  if (!Array.isArray(input.tables)) return null;
  const seen = new Set<string>();
  const tables: SqlTableSnapshot[] = [];
  for (const entry of input.tables) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const t = entry as Record<string, unknown>;
    if (!validTableName(t.name) || seen.has(t.name)) return null;
    seen.add(t.name);
    if (typeof t.createSql !== "string" || t.createSql.length === 0) return null;
    if (!Array.isArray(t.columns) || t.columns.length === 0) return null;
    for (const column of t.columns) {
      if (typeof column !== "string" || !COLUMN_NAME.test(column)) return null;
    }
    if (typeof t.rowCount !== "number" || !Number.isSafeInteger(t.rowCount) || t.rowCount < 0) return null;
    if (typeof t.sha256 !== "string" || !HEX64.test(t.sha256)) return null;
    if (!Array.isArray(t.rows)) return null;
    const columns = t.columns as string[];
    if (t.rows.length > MAX_SQLBK_ROWS || t.rows.length !== t.rowCount) return null;
    const rows: SqlRow[] = [];
    for (const r of t.rows) {
      if (!r || typeof r !== "object" || Array.isArray(r)) return null;
      const source = r as Record<string, unknown>;
      if (Object.keys(source).length !== columns.length) return null;
      const out: SqlRow = {};
      for (const column of columns) {
        const value = source[column];
        if (value === null || typeof value === "string" ||
            (typeof value === "number" && Number.isFinite(value))) {
          out[column] = value as SqlRowValue;
          continue;
        }
        return null;
      }
      rows.push(out);
    }
    tables.push({
      name: t.name, createSql: t.createSql, columns,
      rows, rowCount: t.rowCount, sha256: t.sha256
    });
  }
  // Snapshot bytes deliberately contain only SqlSnapshotBody. Its digest is an
  // independent trust anchor supplied by R2/manifest, never a self-asserted field.
  return { schema: SESSION_SQL_BACKUP_SCHEMA, createdAt: input.createdAt, tables, tableSetFingerprint: input.tableSetFingerprint };
}

/**
 * Byte + structural + digest verification of a snapshot handed over a
 * transport. Any mismatch aborts before a single row is written.
 */
export async function verifySnapshotJson(snapshotJson: string, expectedSha256: string): Promise<SqlSnapshot> {
  if (typeof snapshotJson !== "string" || snapshotJson.length === 0 || snapshotJson.length > MAX_SNAPSHOT_CHARS) {
    throw new Error("SQLBK_SNAPSHOT_UNREADABLE");
  }
  if (typeof expectedSha256 !== "string" || !HEX64.test(expectedSha256)) {
    throw new Error("SQLBK_SNAPSHOT_DIGEST_UNTRUSTED");
  }
  const byteDigest = await sha256Hex(textBytes(snapshotJson));
  if (byteDigest !== expectedSha256) throw new Error("SQLBK_SNAPSHOT_DIGEST_MISMATCH");
  let parsed: unknown;
  try { parsed = JSON.parse(snapshotJson); }
  catch { throw new Error("SQLBK_SNAPSHOT_NOT_JSON"); }
  const snapshot = parseSqlSnapshot(parsed);
  if (!snapshot) throw new Error("SQLBK_SNAPSHOT_MALFORMED");
  const canonical = canonicalJson(snapshotBodyOf(snapshot));
  if (canonical !== snapshotJson) throw new Error("SQLBK_SNAPSHOT_NOT_CANONICAL");
  const recomputed = await sha256Hex(textBytes(canonical));
  if (recomputed !== expectedSha256) throw new Error("SQLBK_SNAPSHOT_DIGEST_MISMATCH");
  for (const table of snapshot.tables) {
    const digest = await tableDigest(table.name, table.columns, table.rows);
    if (digest !== table.sha256) throw new Error("SQLBK_TABLE_DIGEST_MISMATCH:" + table.name);
  }
  const fingerprint = await tableSetFingerprintOf(snapshot.tables);
  if (fingerprint !== snapshot.tableSetFingerprint) throw new Error("SQLBK_TABLESET_DIGEST_MISMATCH");
  return snapshot;
}

// ---------------------------------------------------------------------------
// Restore planning and atomic application.
// ---------------------------------------------------------------------------

export type RestoreStatement = { text: string; bindings: SqlRowValue[] };
export type RestorePlan = {
  statements: RestoreStatement[];
  tableOrder: string[];
  expectedDigests: Record<string, string>;
};

/**
 * Plan the row-by-row restore. The target catalog must be IDENTICAL (same
 * table set, same CREATE SQL, same columns). Existing rows are deleted inside
 * the same transaction (children first, parents last) so the final SQL state
 * is exactly the snapshot even if the fresh object's harness seeded rows.
 * Inserts run parents first: `opencode_session_v2` before its dependants.
 */
export function restorePlanStatements(snapshot: SqlSnapshot, target: CatalogTable[]): RestorePlan {
  const sourceByName = new Map(snapshot.tables.map(t => [t.name, t]));
  const targetByName = new Map(target.map(t => [t.name, t]));
  for (const [name, source] of sourceByName) {
    const targetTable = targetByName.get(name);
    if (!targetTable) throw new Error("SQLBK_SCHEMA_MISMATCH:falta:" + name);
    if (targetTable.createSql !== source.createSql) throw new Error("SQLBK_SCHEMA_MISMATCH:create:" + name);
    if (targetTable.columns.join(",") !== source.columns.join(",")) {
      throw new Error("SQLBK_SCHEMA_MISMATCH:columnas:" + name);
    }
  }
  for (const targetTable of target) {
    if (!sourceByName.has(targetTable.name)) {
      throw new Error("SQLBK_SCHEMA_MISMATCH:adicional:" + targetTable.name);
    }
  }
  // Respect the actual SQLite FK dependency graph. Alphabetical order inserts
  // opencode_event BEFORE its parent opencode_event_sequence, and session_v2
  // BEFORE project; both fail with real SQLITE_CONSTRAINT_FOREIGNKEY.
  const sortedByName = [...snapshot.tables].sort((a, b) => a.name.localeCompare(b.name));
  const states = new Map<string, "visiting" | "visited">();
  const ordered: SqlTableSnapshot[] = [];
  const referencesOf = (table: SqlTableSnapshot): string[] => {
    const names = new Set<string>();
    const pattern = /\bREFERENCES\s+[`"']?([a-z][a-z0-9_]*)[`"']?\s*\(/gi;
    for (const match of table.createSql.matchAll(pattern)) {
      const dependency = match[1];
      if (dependency !== table.name) names.add(dependency);
    }
    return [...names].sort();
  };
  const byName = new Map(sortedByName.map(table => [table.name, table]));
  const visit = (table: SqlTableSnapshot): void => {
    const current = states.get(table.name);
    if (current === "visited") return;
    if (current === "visiting") throw new Error("SQLBK_FK_CYCLE:" + table.name);
    states.set(table.name, "visiting");
    for (const name of referencesOf(table)) {
      const parent = byName.get(name);
      if (!parent) throw new Error("SQLBK_FK_PARENT_MISSING:" + name);
      visit(parent);
    }
    states.set(table.name, "visited");
    ordered.push(table);
  };
  for (const table of sortedByName) visit(table);
  const statements: RestoreStatement[] = [];
  for (const table of [...ordered].reverse()) {
    statements.push({ text: 'DELETE FROM "' + table.name + '"', bindings: [] });
  }
  for (const table of ordered) {
    if (table.rows.length !== table.rowCount) throw new Error("SQLBK_ROW_COUNT_MISMATCH:" + table.name);
    if (table.rows.length > MAX_SQLBK_ROWS) throw new Error("SQLBK_TABLE_TOO_LARGE:" + table.name);
    for (const row of table.rows) {
      const values: SqlRowValue[] = [];
      for (const column of table.columns) {
        if (!(column in row)) throw new Error("SQLBK_ROW_COLUMN_MISSING:" + table.name + ":" + column);
        values.push(row[column]);
      }
      const columnSql = table.columns.map(c => '"' + c + '"').join(",");
      const marks = table.columns.map(() => "?").join(",");
      statements.push({
        text: 'INSERT INTO "' + table.name + '" (' + columnSql + ") VALUES (" + marks + ")",
        bindings: values
      });
    }
  }
  return {
    statements,
    tableOrder: ordered.map(t => t.name),
    expectedDigests: Object.fromEntries(snapshot.tables.map(t => [t.name, t.sha256]))
  };
}

/** Synchronous application; callers must run it inside storage.transaction(). */
export function applyRestorePlan(sql: SqlLike, plan: RestorePlan): void {
  for (const statement of plan.statements) sql.exec(statement.text, ...statement.bindings);
}

/**
 * Synchronous full-content readback. Throws inside the transaction so any
 * divergence rolls the whole restore back instead of committing it.
 */
export function verifyRestoredContentSync(sql: SqlLike, plan: RestorePlan, snapshot: SqlSnapshot): void {
  for (const name of plan.tableOrder) {
    const table = snapshot.tables.find(t => t.name === name);
    if (!table) throw new Error("SQLBK_READBACK_TABLE_MISSING:" + name);
    const raw = sql.exec('SELECT * FROM "' + name + '" ORDER BY rowid').toArray();
    if (raw.length !== table.rows.length) throw new Error("SQLBK_READBACK_COUNT_MISMATCH:" + name);
    const normalized = raw.map((entry, index) => normalizeRow(table, entry, index));
    const live = canonicalJson({ name, columns: table.columns, rows: normalized });
    const expected = canonicalJson({ name, columns: table.columns, rows: table.rows });
    if (live !== expected) throw new Error("SQLBK_READBACK_CONTENT_MISMATCH:" + name);
  }
}

/** Post-commit SHA-256 digests of the restored tables (read back from SQL). */
export async function digestRestoredTables(sql: SqlLike, snapshot: SqlSnapshot, order: string[]): Promise<{
  name: string; rowCount: number; sha256: string;
}[]> {
  const out: { name: string; rowCount: number; sha256: string }[] = [];
  for (const name of order) {
    const table = snapshot.tables.find(t => t.name === name);
    if (!table) throw new Error("SQLBK_READBACK_TABLE_MISSING:" + name);
    const raw = sql.exec('SELECT * FROM "' + name + '" ORDER BY rowid').toArray();
    const rows = raw.map((entry, index) => normalizeRow(table, entry, index));
    out.push({ name, rowCount: rows.length, sha256: await tableDigest(name, table.columns, rows) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normal OpenCode read path (sessions.list + history) and its fingerprints.
// ---------------------------------------------------------------------------

export async function captureNormalReads(harness: SessionHarnessLike): Promise<NormalReads> {
  const listed = await harness.sessions.list();
  if (listed.length > MAX_FIXTURE_SESSIONS) throw new Error("SQLBK_TOO_MANY_FIXTURE_SESSIONS");
  const sessionIds = listed.map(item => {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error("SQLBK_SESSION_LIST_MALFORMED");
    }
    return item.id;
  });
  const historyById: Record<string, unknown[]> = {};
  for (const id of sessionIds) {
    const history = await harness.session(id).history();
    if (!Array.isArray(history)) throw new Error("SQLBK_HISTORY_NOT_ARRAY:" + id);
    historyById[id] = history;
  }
  return { sessionIds, historyById };
}

export async function normalReadFingerprints(reads: NormalReads): Promise<NormalReadFingerprints> {
  const historyDigests: Record<string, string> = {};
  for (const id of reads.sessionIds) {
    const history = reads.historyById[id];
    if (!Array.isArray(history)) throw new Error("SQLBK_HISTORY_MISSING:" + id);
    historyDigests[id] = await sha256Hex(textBytes(canonicalJson(history)));
  }
  return { sessionIds: reads.sessionIds, historyDigests };
}

/**
 * Fingerprint each normal session read SEQUENTIALLY and discard its messages
 * before reading the next. A real OpenCode turn can hold >8 MB of instruction
 * and event blobs; accumulating all histories can reset 128 MB DO isolates.
 */
export async function captureNormalReadFingerprints(harness: SessionHarnessLike): Promise<NormalReadFingerprints> {
  const listed = await harness.sessions.list();
  if (listed.length > MAX_FIXTURE_SESSIONS) throw new Error("SQLBK_TOO_MANY_FIXTURE_SESSIONS");
  const ids: string[] = [];
  const digests: Record<string, string> = {};
  for (const session of listed) {
    const id = session?.id;
    if (typeof id !== "string" || !id || ids.includes(id)) throw new Error("SQLBK_SESSION_LIST_MALFORMED");
    ids.push(id);
    const history = await harness.session(id).history();
    if (!Array.isArray(history)) throw new Error("SQLBK_HISTORY_NOT_ARRAY:" + id);
    digests[id] = await sha256Hex(textBytes(canonicalJson(history)));
  }
  return { sessionIds: ids, historyDigests: digests };
}

/** Pure comparison of fingerprints; content is never included in the result. */
export function verifyNormalReadFingerprints(
  expected: NormalReadFingerprints,
  actual: NormalReadFingerprints
): { ok: boolean; mismatchedHistory: string[]; reason?: string } {
  if (actual.sessionIds.length !== expected.sessionIds.length) {
    return { ok: false, mismatchedHistory: [], reason: "SQLBK_SESSION_COUNT_MISMATCH" };
  }
  for (let i = 0; i < expected.sessionIds.length; i++) {
    if (actual.sessionIds[i] !== expected.sessionIds[i]) {
      return { ok: false, mismatchedHistory: [], reason: "SQLBK_SESSION_ORDER_MISMATCH:" + i };
    }
  }
  for (const id of expected.sessionIds) {
    if (!actual.historyDigests[id]) {
      return { ok: false, mismatchedHistory: [id], reason: "SQLBK_HISTORY_MISSING:" + id };
    }
  }
  const mismatchedHistory: string[] = [];
  for (const id of expected.sessionIds) {
    if (actual.historyDigests[id] !== expected.historyDigests[id]) mismatchedHistory.push(id);
  }
  if (mismatchedHistory.length > 0) {
    return { ok: false, mismatchedHistory, reason: "SQLBK_HISTORY_CONTENT_MISMATCH" };
  }
  return { ok: true, mismatchedHistory: [] };
}

// ---------------------------------------------------------------------------
// Manifest.
// ---------------------------------------------------------------------------

export function buildSessionBackupManifest(input: {
  runId: string;
  createdAt: string;
  snapshotJson: string;
  snapshotSha256: string;
  snapshot: SqlSnapshotBody;
  normalReads: NormalReadFingerprints;
}): SessionBackupManifest {
  const keys = sessionBackupKeys(input.runId);
  return {
    schema: SESSION_SQL_BACKUP_SCHEMA,
    runId: input.runId,
    createdAt: input.createdAt,
    snapshotKey: keys.snapshot,
    manifestKey: keys.manifest,
    snapshotSha256: input.snapshotSha256,
    snapshotBytes: textBytes(input.snapshotJson).length,
    tableSetFingerprint: input.snapshot.tableSetFingerprint,
    tables: input.snapshot.tables.map(t => ({ name: t.name, rowCount: t.rowCount, sha256: t.sha256 })),
    normalReads: input.normalReads
  };
}

export function parseSessionBackupManifest(raw: unknown): SessionBackupManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (input.schema !== SESSION_SQL_BACKUP_SCHEMA) return null;
  if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) return null;
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) return null;
  const keys = sessionBackupKeys(input.runId);
  if (input.snapshotKey !== keys.snapshot || input.manifestKey !== keys.manifest) return null;
  if (typeof input.snapshotSha256 !== "string" || !HEX64.test(input.snapshotSha256)) return null;
  if (typeof input.snapshotBytes !== "number" || !Number.isSafeInteger(input.snapshotBytes) ||
      input.snapshotBytes <= 0 || input.snapshotBytes > MAX_SNAPSHOT_CHARS) return null;
  if (typeof input.tableSetFingerprint !== "string" || !HEX64.test(input.tableSetFingerprint)) return null;
  if (!Array.isArray(input.tables)) return null;
  const tables: { name: string; rowCount: number; sha256: string }[] = [];
  const tableNames = new Set<string>();
  for (const entry of input.tables) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const t = entry as Record<string, unknown>;
    if (!validTableName(t.name) || tableNames.has(t.name)) return null;
    if (typeof t.rowCount !== "number" || !Number.isSafeInteger(t.rowCount) || t.rowCount < 0) return null;
    if (t.rowCount > 0 && SECRET_TABLE.test(t.name)) return null;
    if (typeof t.sha256 !== "string" || !HEX64.test(t.sha256)) return null;
    tableNames.add(t.name);
    tables.push({ name: t.name, rowCount: t.rowCount, sha256: t.sha256 });
  }
  const reads = input.normalReads;
  if (!reads || typeof reads !== "object" || Array.isArray(reads)) return null;
  const normalReads = reads as Record<string, unknown>;
  if (!Array.isArray(normalReads.sessionIds) || normalReads.sessionIds.length === 0 ||
      normalReads.sessionIds.some(id => typeof id !== "string" || id.length === 0) ||
      new Set(normalReads.sessionIds).size !== normalReads.sessionIds.length) return null;
  if (!normalReads.historyDigests || typeof normalReads.historyDigests !== "object" ||
      Array.isArray(normalReads.historyDigests)) return null;
  if (Object.keys(normalReads.historyDigests).length !== normalReads.sessionIds.length) return null;
  for (const [id, digest] of Object.entries(normalReads.historyDigests as Record<string, unknown>)) {
    if (typeof digest !== "string" || !HEX64.test(digest)) return null;
    if (!(normalReads.sessionIds as string[]).includes(id)) return null;
  }
  return {
    schema: SESSION_SQL_BACKUP_SCHEMA,
    runId: input.runId,
    createdAt: input.createdAt,
    snapshotKey: keys.snapshot,
    manifestKey: keys.manifest,
    snapshotSha256: input.snapshotSha256,
    snapshotBytes: input.snapshotBytes,
    tableSetFingerprint: input.tableSetFingerprint,
    tables,
    normalReads: {
      sessionIds: normalReads.sessionIds as string[],
      historyDigests: normalReads.historyDigests as Record<string, string>
    }
  };
}

/** The manifest digest is the hand-off value between export and restore. */
export async function assertManifestDigest(manifest: SessionBackupManifest, manifestSha256: string): Promise<void> {
  const digest = await sha256Hex(textBytes(canonicalJson(manifest)));
  if (digest !== manifestSha256) throw new Error("SQLBK_MANIFEST_DIGEST_MISMATCH");
}

// ---------------------------------------------------------------------------
// R2 transport (versioned keys, digest-pinned puts, strict downloads).
// ---------------------------------------------------------------------------

export async function uploadSessionBackup(
  bucket: R2LikeBucket,
  snapshotJson: string,
  snapshotSha256: string,
  manifest: SessionBackupManifest
): Promise<{ snapshotBytes: number; manifestBytes: number; manifestSha256: string }> {
  const keys = sessionBackupKeys(manifest.runId);
  if (keys.snapshot !== manifest.snapshotKey || keys.manifest !== manifest.manifestKey) {
    throw new Error("SQLBK_MANIFEST_KEYS_MISMATCH");
  }
  const snapshotBytes = textBytes(snapshotJson);
  if (await sha256Hex(snapshotBytes) !== snapshotSha256) throw new Error("SQLBK_SNAPSHOT_DIGEST_MISMATCH");
  const manifestBytes = textBytes(canonicalJson(manifest));
  const manifestSha256 = await sha256Hex(manifestBytes);
  const stored = await bucket.put(keys.snapshot, snapshotBytes, { sha256: snapshotSha256 });
  if (!stored) throw new Error("R2 rechazó la subida del snapshot de sesiones (sha256 no coincide)");
  const snapshotHead = await bucket.head(keys.snapshot);
  if (!snapshotHead || snapshotHead.size !== snapshotBytes.length) {
    throw new Error("R2 no confirma el snapshot de sesiones subido");
  }
  const storedManifest = await bucket.put(keys.manifest, manifestBytes, { sha256: manifestSha256 });
  if (!storedManifest) throw new Error("R2 rechazó la subida del manifiesto de sesiones");
  const manifestHead = await bucket.head(keys.manifest);
  if (!manifestHead || manifestHead.size !== manifestBytes.length) {
    throw new Error("R2 no confirma el manifiesto de sesiones subido");
  }
  return { snapshotBytes: snapshotBytes.length, manifestBytes: manifestBytes.length, manifestSha256 };
}

export async function downloadVerifiedSessionBackup(
  bucket: R2LikeBucket,
  runId: string,
  manifestSha256: string
): Promise<{ manifest: SessionBackupManifest; snapshotJson: string }> {
  const keys = sessionBackupKeys(runId);
  const manifestObject = await bucket.get(keys.manifest);
  if (!manifestObject) throw new Error("SQLBK_MANIFEST_AUSENTE (fail-closed; no se restaura nada)");
  const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  if (await sha256Hex(manifestBytes) !== manifestSha256) throw new Error("SQLBK_MANIFEST_DIGEST_MISMATCH");
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch { throw new Error("SQLBK_MANIFEST_NOT_JSON"); }
  const manifest = parseSessionBackupManifest(parsedManifest);
  if (!manifest) throw new Error("SQLBK_MANIFEST_MALFORMED");
  const snapshotObject = await bucket.get(keys.snapshot);
  if (!snapshotObject) throw new Error("SQLBK_SNAPSHOT_AUSENTE (fail-closed; no se restaura nada)");
  const snapshotBytes = new Uint8Array(await snapshotObject.arrayBuffer());
  if (snapshotBytes.byteLength !== manifest.snapshotBytes) {
    throw new Error("SQLBK_SNAPSHOT_SIZE_MISMATCH");
  }
  const snapshotJson = new TextDecoder().decode(snapshotBytes);
  await verifySnapshotJson(snapshotJson, manifest.snapshotSha256);
  return { manifest, snapshotJson };
}

export async function deleteSessionBackupPrefix(
  bucket: R2LikeBucket,
  runId: string
): Promise<{ deleted: number; keys: string[] }> {
  const keys = sessionBackupKeys(runId);
  const prefix = keys.snapshot.slice(0, keys.snapshot.lastIndexOf("/") + 1);
  const listed = await bucket.list({ prefix, limit: 1000 });
  const foreign = listed.objects.filter(o => !isOwnedSessionBackupKey(o.key));
  if (foreign.length > 0) {
    throw new Error("Se encontraron claves ajenas bajo el prefijo del ensayo; no se borra nada");
  }
  const owned = listed.objects.map(o => o.key);
  if (owned.length > 0) await bucket.delete(owned);
  const after = await bucket.list({ prefix, limit: 1000 });
  if (after.objects.length > 0) throw new Error("El prefijo del ensayo no quedó vacío tras la limpieza");
  return { deleted: owned.length, keys: owned };
}

// ---------------------------------------------------------------------------
// Durable Object drill steps (invoked ONLY by the Staging Workflow action).
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function drillCreateFixture(
  env: unknown,
  harness: SessionHarnessLike,
  input: unknown
): Promise<unknown> {
  assertSupervisorEnabled(env);
  const options = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as { turn?: unknown };
  const turn = options.turn === true;
  // First fixture session stays metadata-only (no messages).
  await harness.sessions.create();
  const b = await harness.sessions.create();
  let turnRan = false;
  if (turn) {
    const handle = harness.session(b.id);
    await handle.submit(SESSION_BK_PROMPT, { whenBusy: "followUp" });
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (await handle.busy()) {
      if (Date.now() > deadline) {
        try { await handle.abort(); } catch { /* keep quiescing below */ }
        break;
      }
      await sleep(TURN_POLL_MS);
    }
    const stopAt = Date.now() + 30_000;
    while (await handle.busy()) {
      if (Date.now() > stopAt) throw new Error("SQLBK_FIXTURE_NOT_QUIESCENT");
      await sleep(TURN_POLL_MS);
    }
    turnRan = true;
  }
  const reads = await captureNormalReads(harness);
  const sessions = reads.sessionIds.map(id => ({
    id, historyLength: (reads.historyById[id] ?? []).length
  }));
  if (turn && (reads.historyById[b.id] ?? []).length < 1) {
    throw new Error("SQLBK_FIXTURE_NO_MESSAGES");
  }
  return {
    schema: SESSION_SQL_FIXTURE_SCHEMA, ok: true, turnRan,
    sessions, listIds: reads.sessionIds
  };
}

export async function drillExportSnapshot(
  env: unknown,
  harness: SessionHarnessLike,
  sql: SqlLike,
  input: unknown
): Promise<unknown> {
  assertSupervisorEnabled(env);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_SESSIONBK_EXPORT_INPUT");
  const args = input as Record<string, unknown>;
  if (Object.keys(args).some(k => k !== "runId")) throw new Error("UNKNOWN_SESSIONBK_FIELD");
  const runId = args.runId;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("INVALID_SESSIONBK_RUN_ID");
  const createdAt = new Date().toISOString();
  // SQL first, then the normal reads: the snapshot must reflect the state
  // before any read-path side effect.
  const built = await buildSqlSnapshot(sql, createdAt);
  const fingerprints = await captureNormalReadFingerprints(harness);
  const manifest = buildSessionBackupManifest({
    runId, createdAt,
    snapshotJson: built.snapshotJson,
    snapshotSha256: built.snapshotSha256,
    snapshot: built.body,
    normalReads: fingerprints
  });
  const manifestSha256 = await sha256Hex(textBytes(canonicalJson(manifest)));
  return {
    ok: true, runId, createdAt,
    snapshotJson: built.snapshotJson,
    snapshotSha256: built.snapshotSha256,
    totalRows: built.totalRows,
    tableCount: built.body.tables.length,
    tableSetFingerprint: built.body.tableSetFingerprint,
    tables: built.body.tables.map(t => ({ name: t.name, rowCount: t.rowCount, sha256: t.sha256 })),
    listIds: fingerprints.sessionIds,
    historyDigests: fingerprints.historyDigests,
    manifest, manifestSha256
  };
}

/**
 * Export and upload INSIDE the isolated Durable Object. The Workflow step
 * receives only a compact receipt; session SQL bytes never enter Workflow
 * event payloads, step outputs, or their diagnostic logs.
 */
export async function drillExportSnapshotToR2(
  env: unknown, harness: SessionHarnessLike, sql: SqlLike, bucket: R2LikeBucket, input: unknown
): Promise<unknown> {
  assertSupervisorEnabled(env);
  const result = await drillExportSnapshot(env, harness, sql, input) as {
    runId: string; createdAt: string; snapshotJson: string; snapshotSha256: string;
    totalRows: number; tableCount: number; tableSetFingerprint: string;
    listIds: string[]; manifest: SessionBackupManifest;
  };
  const uploaded = await uploadSessionBackup(bucket, result.snapshotJson, result.snapshotSha256, result.manifest);
  return {
    ok: true, uploaded: true, runId: result.runId, createdAt: result.createdAt,
    snapshotSha256: result.snapshotSha256,
    totalRows: result.totalRows, tableCount: result.tableCount,
    tableSetFingerprint: result.tableSetFingerprint, listIds: result.listIds,
    ...uploaded
  };
}

/** Load verified data directly from private R2 inside the target DO. */
export async function drillRestoreFromR2(
  env: unknown, sql: SqlLike, storage: DrillStorage, bucket: R2LikeBucket, input: unknown
): Promise<unknown> {
  assertSupervisorEnabled(env);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("SQLBK_R2_RESTORE_INPUT");
  const args = input as Record<string, unknown>;
  if (Object.keys(args).some(k => k !== "runId" && k !== "manifestSha256") ||
      typeof args.runId !== "string" || typeof args.manifestSha256 !== "string" ||
      !HEX64.test(args.manifestSha256)) throw new Error("SQLBK_R2_RESTORE_INPUT");
  const { manifest, snapshotJson } = await downloadVerifiedSessionBackup(bucket, args.runId, args.manifestSha256);
  return drillRestoreCommit(env, sql, storage, {
    snapshotJson, snapshotSha256: manifest.snapshotSha256
  });
}

/** Verify SQL and the normal OpenCode history path without returning session bytes. */
export async function drillVerifyFromR2(
  env: unknown, harness: SessionHarnessLike, sql: SqlLike, bucket: R2LikeBucket, input: unknown
): Promise<unknown> {
  assertSupervisorEnabled(env);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("SQLBK_R2_VERIFY_INPUT");
  const args = input as Record<string, unknown>;
  if (Object.keys(args).some(k => k !== "runId" && k !== "manifestSha256") ||
      typeof args.runId !== "string" || typeof args.manifestSha256 !== "string" ||
      !HEX64.test(args.manifestSha256)) throw new Error("SQLBK_R2_VERIFY_INPUT");
  const { manifest } = await downloadVerifiedSessionBackup(bucket, args.runId, args.manifestSha256);
  return drillRestoreVerify(env, harness, sql, {
    manifest, manifestSha256: args.manifestSha256,
    snapshotSha256: manifest.snapshotSha256
  });
}

export async function drillRestoreWipe(env: unknown, storage: DrillStorage): Promise<unknown> {
  assertSupervisorEnabled(env);
  if (typeof storage.deleteAll !== "function") throw new Error("SQLBK_WIPE_UNAVAILABLE");
  await storage.deleteAll();
  return { ok: true, wiped: true };
}

export async function drillRestorePrepare(env: unknown, harness: SessionHarnessLike, sql: SqlLike): Promise<unknown> {
  assertSupervisorEnabled(env);
  // Force OpenCode open on the wiped object so the current Worker's schema is
  // created by the harness itself.
  await harness.sessions.list();
  const catalog = readOpencodeCatalog(sql);
  if (catalog.length === 0) throw new Error("SQLBK_SCHEMA_MISSING_AFTER_WIPE");
  const tableSetFingerprint = await tableSetFingerprintOf(catalog);
  return {
    ok: true, tableSetFingerprint,
    tables: catalog.map(t => ({
      name: t.name, columns: t.columns, rowCount: t.rowCount, createSql: t.createSql
    }))
  };
}

export async function drillRestoreCommit(
  env: unknown,
  sql: SqlLike,
  storage: DrillStorage,
  input: unknown
): Promise<unknown> {
  assertSupervisorEnabled(env);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("SQLBK_RESTORE_INPUT_INVALID");
  const args = input as Record<string, unknown>;
  if (typeof args.snapshotJson !== "string" || typeof args.snapshotSha256 !== "string") {
    throw new Error("SQLBK_RESTORE_INPUT_INVALID");
  }
  const snapshot = await verifySnapshotJson(args.snapshotJson, args.snapshotSha256);
  const catalog = readOpencodeCatalog(sql);
  const plan = restorePlanStatements(snapshot, catalog);
  // One transaction: DELETE + INSERT + synchronous readback comparison. Per
  // the SQLite-backed storage contract every sql.exec inside the closure is
  // part of the transaction and everything rolls back if this throws.
  await storage.transaction(() => {
    applyRestorePlan(sql, plan);
    verifyRestoredContentSync(sql, plan, snapshot);
  });
  // Post-commit digest proof against the snapshot's per-table digests.
  const digests = await digestRestoredTables(sql, snapshot, plan.tableOrder);
  for (const entry of digests) {
    if (plan.expectedDigests[entry.name] !== entry.sha256) {
      throw new Error("SQLBK_POST_COMMIT_DIGEST_MISMATCH:" + entry.name);
    }
  }
  return {
    ok: true,
    statementCount: plan.statements.length,
    tableOrder: plan.tableOrder,
    tables: digests
  };
}

export async function drillRestoreVerify(
  env: unknown,
  harness: SessionHarnessLike,
  sql: SqlLike,
  input: unknown
): Promise<unknown> {
  assertSupervisorEnabled(env);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("SQLBK_VERIFY_INPUT_INVALID");
  const args = input as Record<string, unknown>;
  if (typeof args.manifestSha256 !== "string" || typeof args.snapshotSha256 !== "string") {
    throw new Error("SQLBK_VERIFY_INPUT_INVALID");
  }
  const manifest = parseSessionBackupManifest(args.manifest);
  if (!manifest) throw new Error("SQLBK_MANIFEST_MALFORMED");
  await assertManifestDigest(manifest, args.manifestSha256);
  if (manifest.snapshotSha256 !== args.snapshotSha256) throw new Error("SQLBK_SNAPSHOT_BINDING_MISMATCH");
  // 1) SQL digests FIRST: no harness read happens before them, so any
  // read-path side effect cannot mask a divergence.
  const catalog = readOpencodeCatalog(sql);
  const fingerprint = await tableSetFingerprintOf(catalog);
  if (fingerprint !== manifest.tableSetFingerprint) throw new Error("SQLBK_TABLESET_DIGEST_MISMATCH");
  const liveByName = new Map(catalog.map(t => [t.name, t]));
  let allDigestsMatch = true;
  // Process large tables one at a time; Promise.all() keeps ALL snapshot rows
  // and serialization buffers in memory at once, exceeding the DO isolate cap.
  for (const expected of manifest.tables) {
    const live = liveByName.get(expected.name);
    if (!live || live.rowCount !== expected.rowCount) {
      allDigestsMatch = false;
      break;
    }
    const rows = sql.exec('SELECT * FROM "' + expected.name + '" ORDER BY rowid')
      .toArray().map((entry, index) => normalizeRow(live, entry, index));
    if ((await tableDigest(expected.name, live.columns, rows)) !== expected.sha256) {
      allDigestsMatch = false;
      break;
    }
  }
  if (!allDigestsMatch) throw new Error("SQLBK_POST_COMMIT_DIGEST_MISMATCH");
  // 2) Normal read path.
  const actualFingerprints = await captureNormalReadFingerprints(harness);
  const outcome = verifyNormalReadFingerprints(manifest.normalReads, actualFingerprints);
  return {
    ok: allDigestsMatch && outcome.ok,
    sqlDigestsMatch: allDigestsMatch,
    sessionCount: actualFingerprints.sessionIds.length,
    normalReadsMatch: outcome.ok,
    reason: outcome.reason ?? null,
    mismatchedHistory: outcome.mismatchedHistory
  };
}

export async function drillCleanupStorage(env: unknown, storage: DrillStorage): Promise<unknown> {
  assertSupervisorEnabled(env);
  if (typeof storage.deleteAll !== "function") throw new Error("SQLBK_WIPE_UNAVAILABLE");
  await storage.deleteAll();
  return { ok: true, wiped: true };
}

// Re-export so the Workflow imports one module for the bucket guard.
export { assertR2Bucket };

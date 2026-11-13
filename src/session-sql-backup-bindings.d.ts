/**
 * Staging-only addition to the committed baseline Wrangler-generated types
 * (same pattern as src/dev-bindings.d.ts and src/personal-bindings.d.ts).
 * SESSION_BK is declared ONLY in wrangler.g1.jsonc and points at the
 * disposable drill class. It is never present in wrangler.jsonc (production).
 */
interface Env {
  SESSION_BK: DurableObjectNamespace<import("./session-sql-backup-do").SessionBackupDrillAgent>;
}

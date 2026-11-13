/**
 * Staging-only Worker entrypoint (referenced only by wrangler.g1.jsonc "main").
 *
 * Production keeps `main: "src/server.ts"` in wrangler.jsonc and is untouched
 * by B2. This entrypoint re-exports the production Worker unchanged and adds
 * the ONE export workerd needs for the SESSION_BK drill namespace: the
 * disposable SessionBackupDrillAgent class. Nothing else changes, so the
 * staging build is the production Worker plus the drill class.
 */

export {
  default, PersonalSettings, DevContainer, OpenCodeAgent, OpenCodeSupervisorWorkflow
} from "./server";
export { SessionBackupDrillAgent } from "./session-sql-backup-do";

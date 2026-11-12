/**
 * Real, reproducible filesystem backup/restore verification inside the
 * current Linux container. It runs the exact FS_VERIFY_SOURCE the Worker
 * executes in the project Container (single source of truth).
 *
 *   bun scripts/verify-backup-restore.mjs                # must PASS (ok:true)
 *   bun scripts/verify-backup-restore.mjs --expect-fail  # injects archive
 *       corruption and must FAIL (ok:false) — proves the harness detects
 *       damage instead of reporting synthetic PASSes.
 *
 * Exit codes: 0 = expected verdict observed; 1 = unexpected verdict or
 * unparsable report. A FAIL is reported as FAIL, never swallowed.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FS_VERIFY_SOURCE, parseVerifyReport } from "../src/container-verify.ts";

const negative = process.argv.includes("--expect-fail");
const project = process.env.VERIFY_PROJECT || "opencode-fs-verify";
const root = process.env.VERIFY_ROOT || "/workspace/projects";
const runId = randomUUID().replace(/-/g, "").slice(0, 16);
const result = spawnSync("node", ["--input-type=module", "-e", FS_VERIFY_SOURCE], {
  env: {
    ...process.env,
    VERIFY_ROOT: root,
    VERIFY_PROJECT: project,
    VERIFY_RUN_ID: runId,
    VERIFY_NEGATIVE: negative ? "1" : "0"
  },
  encoding: "utf8",
  timeout: 120_000
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
const report = parseVerifyReport(result.stdout ?? "");
if (!report) {
  console.error("verify-backup-restore: FAIL - no parsable VERIFY_REPORT (exit " + result.status + ")");
  process.exit(1);
}
const expectedOk = !negative;
const expectedExit = expectedOk ? 0 : 1;
const verdictOk = report.ok === expectedOk && result.status === expectedExit;
console.log("verify-backup-restore: " + (verdictOk ? "EXPECTED-VERDICT" : "UNEXPECTED-VERDICT") +
  " mode=" + report.mode + " ok=" + report.ok + " exit=" + result.status +
  " payloadSha256=" + report.payloadSha256 + " archiveBytes=" + report.archiveBytes);
// Expected-verdict runs leave no forensic residue; failures keep their
// artifacts on purpose for inspection.
if (verdictOk) {
  rmSync(join(root, "__verify-" + project + "-" + report.runId), { recursive: true, force: true });
  rmSync(join(tmpdir(), "verify-backup-" + report.runId + ".tgz"), { force: true });
}
process.exit(verdictOk ? 0 : 1);

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { SUPERVISOR_WORKSPACE, supervisorTaskKey, type SupervisorStart } from "./supervisor-control";
import { drillProjectNames } from "./container-recovery";
import {
  assertR2Bucket, createTamperedProbe, deleteRunPrefix, externalBackupProjectNames
} from "./external-backup";
import { projectContainerName } from "./project-container";
import type { DrillDev } from "./container-recovery-do";
import type { ExtBkDev } from "./external-backup-do";

type SupervisorWorkflowCommand =
  | { action: "start"; requestId: string; repository: string; prompt: string }
  | { action: "status" | "cancel" | "review"; id: string }
  | { action: "recovery_drill" }
  | { action: "external_backup_drill" };

/**
 * Private supervisory control plane: the Cloudflare account's Workflow API
 * is the authenticated caller, not a public URL or a model-accessible tool.
 *
 * Only deployed by wrangler.g1.jsonc. No production Workflow binding exists.
 */
export class OpenCodeSupervisorWorkflow extends WorkflowEntrypoint<Env, SupervisorWorkflowCommand> {
  async run(event: WorkflowEvent<SupervisorWorkflowCommand>, step: WorkflowStep) {
    const raw: unknown = event.payload;
    if (typeof raw === "string" && raw.length > 6_000) throw new Error("SUPERVISOR_PAYLOAD_TOO_LARGE");
    let command: unknown = raw;
    if (typeof raw === "string") {
      try { command = JSON.parse(raw); }
      catch { throw new Error("INVALID_SUPERVISOR_COMMAND_JSON"); }
    }
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error("INVALID_SUPERVISOR_COMMAND");
    }
    const args = command as Record<string, unknown>;
    if (args.action === "recovery_drill") {
      // Staging-only private Cloudflare Workflow. Neither a public API route
      // nor an agent tool can invoke this destructive, disposable test.
      if ((this.env as Env & { OPENCODE_SUPERVISOR_ENABLED?: string })
        .OPENCODE_SUPERVISOR_ENABLED !== "true") throw new Error("SUPERVISOR_DISABLED");
      if (Object.keys(args).some(k => k !== "action")) throw new Error("UNKNOWN_DRILL_FIELD");

      const opts = { retries: { limit: 0, delay: "1 second" as const } };
      const scope = await step.do("allocate-disposable-drill-scope", opts, async () =>
        drillProjectNames(crypto.randomUUID().replace(/-/g, "").slice(0, 12))
      );
      const a = this.env.DEV.getByName(projectContainerName(scope.creator)) as unknown as DrillDev;
      const b = this.env.DEV.getByName(projectContainerName(scope.restorer)) as unknown as DrillDev;
      let create: Awaited<ReturnType<DrillDev["drillCreateSnapshot"]>> | null = null;
      let same: Awaited<ReturnType<DrillDev["drillRestoreSameDo"]>> | null = null;
      let cross: Awaited<ReturnType<DrillDev["drillCrossRestore"]>> | null = null;
      let error: string | null = null;
      let cleanup: Array<{ project: string; containerDestroyed: boolean; handleDeleted: number } | { project: string; cleanupError: string }> = [];
      try {
        create = await step.do("create-real-container-snapshot", opts,
          async () => a.drillCreateSnapshot(scope.creator));
        same = await step.do("destroy-and-restore-same-container", opts,
          async () => a.drillRestoreSameDo(scope.creator));
        if (!same.ok || !same.destroyedInstance) {
          throw new Error("Same-DO restoration did not pass; skip cross-DO test");
        }
        cross = await step.do("restore-new-disposable-container", opts,
          async () => b.drillCrossRestore(scope.restorer, create!.snapshotId, create!.record));
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 800) : "Unknown drill failure";
      } finally {
        cleanup = await step.do("cleanup-disposable-drill-containers", opts, async () => {
          const results: typeof cleanup = [];
          for (const [host, project] of [[a, scope.creator], [b, scope.restorer]] as const) {
            try { results.push(await host.drillCleanup(project)); }
            catch (e) {
              results.push({ project, cleanupError: e instanceof Error ? e.message : "failed" });
            }
          }
          return results;
        });
      }
      const cleanupOk = cleanup.length === 2 && cleanup.every(x =>
        x !== null && typeof x === "object" && !("cleanupError" in x));
      return {
        schema: "opencode.container-recovery.drill.v1",
        scope, passed: Boolean(create?.doHashVerified && same?.ok &&
          same?.destroyedInstance && cross?.ok && cleanupOk),
        sameDoPassed: Boolean(same?.ok && same?.destroyedInstance),
        crossDoPassed: Boolean(cross?.ok),
        error, create, same, cross, cleanup, cleanupOk
      };
    }
    if (args.action === "external_backup_drill") {
      // Staging-only private Cloudflare Workflow, same access shape as
      // recovery_drill: the account Workflow API is the caller; no public
      // route and no agent tool can invoke this destructive disposable test.
      if ((this.env as Env & { OPENCODE_SUPERVISOR_ENABLED?: string })
        .OPENCODE_SUPERVISOR_ENABLED !== "true") throw new Error("SUPERVISOR_DISABLED");
      if (Object.keys(args).some(k => k !== "action")) throw new Error("UNKNOWN_EXTBK_FIELD");

      const opts = { retries: { limit: 0, delay: "1 second" as const } };
      const scope = await step.do("allocate-disposable-extbk-scope", opts, async () =>
        externalBackupProjectNames(crypto.randomUUID().replace(/-/g, "").slice(0, 12)));
      const a = this.env.DEV.getByName(projectContainerName(scope.creator)) as unknown as ExtBkDev;
      const b = this.env.DEV.getByName(projectContainerName(scope.restorer)) as unknown as ExtBkDev;
      const bucketOf = () => assertR2Bucket(
        (this.env as Env & { RECOVERY_R2?: unknown }).RECOVERY_R2,
        "workflow.opencode-supervisor-stage");
      let create: Awaited<ReturnType<ExtBkDev["extBackupCreate"]>> | null = null;
      let destroyed: Awaited<ReturnType<ExtBkDev["extBackupDestroyInstance"]>> | null = null;
      let restore: Awaited<ReturnType<ExtBkDev["extBackupCrossRestore"]>> | null = null;
      let tamper: {
        probe: Awaited<ReturnType<typeof createTamperedProbe>>;
        result: Awaited<ReturnType<ExtBkDev["extBackupTamperProbe"]>>;
      } | null = null;
      let missing: Awaited<ReturnType<ExtBkDev["extBackupMissingProbe"]>> | null = null;
      let error: string | null = null;
      let r2Cleanup: { deleted: number; keys: string[] } | { error: string } = { deleted: 0, keys: [] };
      let cleanup: Array<{ project: string; containerDestroyed: boolean; recordsDeleted: number } | { project: string; cleanupError: string }> = [];
      try {
        create = await step.do("create-extbk-backup-upload-r2", opts,
          async () => a.extBackupCreate(scope.creator, scope.runId));
        destroyed = await step.do("destroy-creator-instance", opts,
          async () => a.extBackupDestroyInstance(scope.creator));
        if (!destroyed.destroyedInstance) {
          throw new Error("La instancia creadora no llegó a destruirse; se omite la restauración cruzada");
        }
        restore = await step.do("restore-cross-do-from-r2", opts,
          async () => b.extBackupCrossRestore(scope.restorer, create!.manifest, create!.manifestSha256));
        if (!restore.ok) {
          throw new Error("La restauración cruzada desde R2 no pasó; se omiten las sondas");
        }
        tamper = await step.do("probe-tampered-backup", opts, async () => {
          const probe = await createTamperedProbe(bucketOf(), scope.runId);
          const result = await b.extBackupTamperProbe(scope.restorer, scope.runId, create!.manifest);
          return { probe, result };
        });
        missing = await step.do("probe-missing-backup", opts,
          async () => b.extBackupMissingProbe(scope.restorer, scope.runId));
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 800) : "Unknown external backup drill failure";
      } finally {
        const outcome = await step.do("cleanup-extbk-drill", opts, async () => {
          let r2: { deleted: number; keys: string[] } | { error: string } = { deleted: 0, keys: [] };
          if (create) {
            try { r2 = await deleteRunPrefix(bucketOf(), scope.runId); }
            catch (e) { r2 = { error: e instanceof Error ? e.message : "R2 cleanup failed" }; }
          }
          const dos: typeof cleanup = [];
          for (const [host, project] of [[a, scope.creator], [b, scope.restorer]] as const) {
            try { dos.push(await host.extBackupCleanup(project)); }
            catch (e) { dos.push({ project, cleanupError: e instanceof Error ? e.message : "failed" }); }
          }
          return { r2, dos };
        });
        r2Cleanup = outcome.r2;
        cleanup = outcome.dos;
      }
      const r2Clean = !("error" in r2Cleanup) && r2Cleanup.deleted >= 2;
      const cleanupOk = cleanup.length === 2 &&
        cleanup.every(x => x !== null && typeof x === "object" && !("cleanupError" in x)) && r2Clean;
      return {
        schema: "opencode.external-backup.drill.v1",
        scope,
        passed: Boolean(create && destroyed?.destroyedInstance && restore?.ok &&
          tamper?.result?.rejectedAsExpected && tamper?.result?.originalIntact &&
          missing?.rejectedAsExpected && cleanupOk),
        createPassed: Boolean(create),
        destroyPassed: Boolean(destroyed?.destroyedInstance),
        crossRestorePassed: Boolean(restore?.ok),
        tamperRejected: Boolean(tamper?.result?.rejectedAsExpected),
        missingRejected: Boolean(missing?.rejectedAsExpected),
        r2Cleanup, cleanup, cleanupOk, error,
        create, destroyed, restore, tamper, missing
      };
    }
    return step.do("supervised-opencode-operation", {
      retries: { limit: 0, delay: "1 second" }
    }, async () => {
      if ((this.env as Env & { OPENCODE_SUPERVISOR_ENABLED?: string })
        .OPENCODE_SUPERVISOR_ENABLED !== "true") {
        throw new Error("SUPERVISOR_DISABLED");
      }
      // The Cloudflare Workflow REST API accepts JSON-encoded params; depending
      // on the entrypoint these can reach run() as a string or parsed object.
      const payload: unknown = event.payload;
      if (typeof payload === "string" && payload.length > 6_000)
        throw new Error("SUPERVISOR_PAYLOAD_TOO_LARGE");
      let command: unknown = payload;
      if (typeof payload === "string") {
        try { command = JSON.parse(payload); }
        catch { throw new Error("INVALID_SUPERVISOR_COMMAND_JSON"); }
      }
      if (!command || typeof command !== "object" || Array.isArray(command))
        throw new Error("INVALID_SUPERVISOR_COMMAND");
      const args = command as Record<string, unknown>;
      const host = this.env.OpenCodeAgent.getByName(SUPERVISOR_WORKSPACE);
      if (args.action === "start") {
        if (Object.keys(args).some(k => !["action", "requestId", "repository", "prompt"].includes(k)))
          throw new Error("UNKNOWN_SUPERVISOR_FIELD");
        return host.startSupervisedTask({
          requestId: args.requestId, repository: args.repository, prompt: args.prompt
        } as SupervisorStart);
      }
      if (args.action === "status" || args.action === "cancel" || args.action === "review") {
        if (Object.keys(args).some(k => !["action", "id"].includes(k)))
          throw new Error("UNKNOWN_SUPERVISOR_FIELD");
        if (typeof args.id !== "string") throw new Error("INVALID_SUPERVISOR_TASK_ID");
        supervisorTaskKey(args.id);
        if (args.action === "status") return host.supervisedTaskStatus(args.id);
        if (args.action === "cancel") return host.cancelSupervisedTask(args.id);
        return host.supervisedTaskReview(args.id);
      }
      throw new Error("UNKNOWN_SUPERVISOR_ACTION");
    });
  }
}

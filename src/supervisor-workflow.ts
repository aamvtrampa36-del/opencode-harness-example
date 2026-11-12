import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { SUPERVISOR_WORKSPACE, supervisorTaskKey, type SupervisorStart } from "./supervisor-control";
import { drillProjectNames } from "./container-recovery";
import { projectContainerName } from "./project-container";
import type { DrillDev } from "./container-recovery-do";

type SupervisorWorkflowCommand =
  | { action: "start"; requestId: string; repository: string; prompt: string }
  | { action: "status" | "cancel" | "review"; id: string }
  | { action: "recovery_drill" };

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
      let cleanup: unknown[] = [];
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
          const results: unknown[] = [];
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

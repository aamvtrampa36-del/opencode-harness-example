import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { SUPERVISOR_WORKSPACE, supervisorTaskKey, type SupervisorStart } from "./supervisor-control";
import { restoreProofFixtureName, validateRestoreProofFixtureId } from "./restore-proof";

type SupervisorWorkflowCommand =
  | { action: "start"; requestId: string; repository: string; prompt: string }
  | { action: "status" | "cancel" | "review"; id: string }
  | { action: "restore-proof"; fixtureId: string };

/**
 * Private supervisory control plane: the Cloudflare account's Workflow API
 * is the authenticated caller, not a public URL or a model-accessible tool.
 *
 * Only deployed by wrangler.g1.jsonc. No production Workflow binding exists.
 */
export class OpenCodeSupervisorWorkflow extends WorkflowEntrypoint<Env, SupervisorWorkflowCommand> {
  async run(event: WorkflowEvent<SupervisorWorkflowCommand>, step: WorkflowStep) {
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
      if (args.action === "restore-proof") {
        if (Object.keys(args).some(k => !["action", "fixtureId"].includes(k)))
          throw new Error("UNKNOWN_SUPERVISOR_FIELD");
        // Fail closed: only a freshly created, test-exclusive fixture DO is
        // accepted (restore-proof-v1:<16 hex>); any prior state is rejected
        // by the fixture itself before touching a Container. The proof is
        // resumable: re-creating an instance with the same fixtureId
        // continues from the last persisted phase in the fixture storage.
        const fixtureId = validateRestoreProofFixtureId(args.fixtureId);
        return this.env.DEV.getByName(restoreProofFixtureName(fixtureId)).proveRestoreFixture(fixtureId);
      }
      throw new Error("UNKNOWN_SUPERVISOR_ACTION");
    });
  }
}

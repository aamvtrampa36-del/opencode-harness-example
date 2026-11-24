/** Boundary validation only: the backend must verify the commit/tree relationship,
 * authorization, admission and immutable requestId fingerprint before any effect. */
export type ReadOnlyStartFields =
  | { mode?: never; sourceCommit?: never; sourceTree?: never }
  | { mode: "read_only"; sourceCommit: string; sourceTree: string };

const SHA = /^[a-f0-9]{40}$/;

export function readOnlyStartFields(input: {
  mode?: unknown; sourceCommit?: unknown; sourceTree?: unknown;
  workspace?: unknown; sourceSession?: unknown;
}): ReadOnlyStartFields {
  const { mode, sourceCommit, sourceTree, workspace, sourceSession } = input;
  if (mode !== undefined && mode !== "read_only") throw new Error("INVALID_SUPERVISOR_MODE");
  if (mode === undefined) {
    if (sourceCommit !== undefined || sourceTree !== undefined)
      throw new Error("SUPERVISOR_PINS_REQUIRE_READ_ONLY");
    return {};
  }
  if (workspace !== undefined || sourceSession !== undefined)
    throw new Error("SUPERVISOR_READ_ONLY_FORK_UNSUPPORTED");
  if (sourceCommit === undefined || sourceTree === undefined)
    throw new Error("SUPERVISOR_SOURCE_PINS_REQUIRED");
  if (typeof sourceCommit !== "string" || !SHA.test(sourceCommit) ||
      typeof sourceTree !== "string" || !SHA.test(sourceTree))
    throw new Error("INVALID_SUPERVISOR_SOURCE_PINS");
  return { mode, sourceCommit, sourceTree };
}

/** Workflow has always used the fixed supervisor, not custom workspace/fork/model selection. */
export function workflowStartInput(args: Record<string, unknown>) {
  if (Object.keys(args).some(k => !["action", "requestId", "repository", "prompt",
    "mode", "sourceCommit", "sourceTree"].includes(k)))
    throw new Error("UNKNOWN_SUPERVISOR_FIELD");
  return { requestId: args.requestId, repository: args.repository, prompt: args.prompt,
    ...readOnlyStartFields(args) };
}

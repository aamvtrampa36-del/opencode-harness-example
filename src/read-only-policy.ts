/** Immutable server-side authority for a certified supervisor source. Never deserialize this from a client. */
export type ReadOnlyAuthority = Readonly<{
  mode: "read_only"; object: string; session: string; task: string;
  project: string; repository: string; sourceCommit: string; sourceTree: string;
}>;
export type ReadOnlyScope = { project: string; repository?: string; readOnly?: ReadOnlyAuthority };
export type ReadOnlyAction =
  | { kind: "github"; repo: string; operation?: string; branch?: string; ref?: string }
  | { kind: "linux"; project: string; operation?: string }
  | { kind: "workspace-write" | "delegate" | "fork" | "websocket-submit" | "model-select" | "mcp" | "image" | "connector" | "publication" | "other" };
const SHA = /^[a-f0-9]{40}$/;
const SESSION = /^ses[A-Za-z0-9_]{1,64}$/;
const PROJECT = /^[a-z][a-z0-9-]{0,39}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const METADATA = new Set(["repo", "pr_search", "pr_info", "issue_info", "pr_files", "pr_reviews", "pr_checks"]);
function denied(reason: string): never { throw new Error("READ_ONLY_DENIED: " + reason); }
function equal(a: ReadOnlyAuthority, b: ReadOnlyAuthority): boolean {
  return a.mode === b.mode && a.object === b.object && a.session === b.session && a.task === b.task &&
    a.project === b.project && a.repository.toLowerCase() === b.repository.toLowerCase() &&
    a.sourceCommit === b.sourceCommit && a.sourceTree === b.sourceTree;
}
/** Input must be reconstructed from a fenced durable task, not request/tool metadata. */
export function createReadOnlyAuthority(input: ReadOnlyAuthority): ReadOnlyAuthority {
  if (!input || input.mode !== "read_only" || typeof input.object !== "string" || !input.object ||
      typeof input.session !== "string" || !SESSION.test(input.session) ||
      typeof input.task !== "string" || !/^[a-f0-9]{16}$/.test(input.task) ||
      typeof input.project !== "string" || !PROJECT.test(input.project) ||
      typeof input.repository !== "string" || !REPO.test(input.repository) ||
      typeof input.sourceCommit !== "string" || !SHA.test(input.sourceCommit) ||
      typeof input.sourceTree !== "string" || !SHA.test(input.sourceTree)) denied("invalid authority");
  const { mode, object, session, task, project, repository, sourceCommit, sourceTree } = input;
  return Object.freeze({ mode, object, session, task, project, repository, sourceCommit, sourceTree });
}
/** Bind once in the same storage transaction as admission/session identity; never upgrade an existing ordinary scope. */
export function bindReadOnlyScope(existing: ReadOnlyScope | undefined, expected: ReadOnlyAuthority): ReadOnlyScope {
  const authority = createReadOnlyAuthority(expected);
  if (existing) { requireReadOnlyAuthority(existing, authority); return existing; }
  return { project: authority.project, repository: authority.repository, readOnly: authority };
}
/** Expected identity comes independently from current durable task + actual DO/session, not stored scope alone. */
export function requireReadOnlyAuthority(scope: ReadOnlyScope | undefined, expected: ReadOnlyAuthority): ReadOnlyAuthority {
  const trusted = createReadOnlyAuthority(expected);
  if (!scope?.readOnly) denied("missing durable scope");
  const stored = createReadOnlyAuthority(scope.readOnly);
  if (scope.project !== stored.project || scope.repository?.toLowerCase() !== stored.repository.toLowerCase() ||
      !equal(stored, trusted)) denied("authority mismatch");
  return stored;
}
/** Strict allowlist. Mutable GitHub metadata is not certified source evidence; file reads require exact commit. */
export function assertReadOnlyAction(authority: ReadOnlyAuthority, action: ReadOnlyAction): void {
  const bound = createReadOnlyAuthority(authority);
  if (!action || typeof action !== "object") denied("unknown action");
  if (action.kind === "github") {
    if (typeof action.repo !== "string" || action.repo.toLowerCase() !== bound.repository.toLowerCase()) denied("repository mismatch");
    if (action.branch !== undefined) denied("branch operation");
    if (action.operation === "read" && action.ref === bound.sourceCommit) return;
    if (METADATA.has(action.operation ?? "") && action.ref === undefined) return;
    denied("GitHub action or source ref");
  }
  if (action.kind === "linux" && action.project === bound.project && action.operation === "inspect") return;
  // Shell is not a sandbox: deny arbitrary execution until isolation/egress/credentials are independently proven.
  // No child may be created: reject before fork, model selection, submission or any other effect.
  denied("effect or unknown route");
}
/** Use immediately before the real executor, even if tool visibility or an earlier guard already passed. */
export function enforceReadOnlyRoute(scope: ReadOnlyScope | undefined, expected: ReadOnlyAuthority, action: ReadOnlyAction): void {
  assertReadOnlyAction(requireReadOnlyAuthority(scope, expected), action);
}

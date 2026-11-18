# Dynamic execution: scoped catalogue and capability boundaries

Status: development candidate (PR #76). This file does not certify production deployment.

## Existing execution paths
- `exec` with `dynamic-mcp` runs short JavaScript through `@cloudflare/computer` with outbound networking disabled. It can call only host-approved **read-only** MCP tools. Direct MCP integrations retain their own authorization for mutations.
- `exec` with `codemode` retains the existing shared Workspace behavior for unscoped conversations.
- `dynamic_tool` uses a dedicated `pure-tools` CodemodeBackend. It has no MCP modules, network egress or filesystem access, and has strict code/input/result/CPU/time limits. This path must never perform canonical CDF operations.
- Linux and dependency-heavy operations continue to run in their existing isolated Containers.

## Catalogue lifecycle
`dynamic_tool` accepts:
- `list`, `inspect` (also allowed in Plan/Review).
- `propose` with `id`, `source` (an ES module default-exported function), two to eight different `{input, expected}` synthetic tests, and optional documentation URLs.
- `verify`: executes **all provided test inputs** in the capability-free backend and compares structured JSON results.
- `activate`: only after a successful verification; `run`: only active tools.
- `deactivate`: marks an entry deprecated; there is no automatic source deletion.

Example candidate:
```json
{
  "action": "propose",
  "id": "count-items",
  "source": "export default (input) => ({ count: input.items.length })",
  "tests": [
    {"input":{"items":[1,2]},"expected":{"count":2}},
    {"input":{"items":[]},"expected":{"count":0}}
  ],
  "documentation": ["https://developers.cloudflare.com/dynamic-workers/"]
}
```

Then call `verify`, `activate`, `run` with `value: {"items":[1]}`.

Catalog entries are stored in the current OpenCodeAgent Durable Object under `dynamic-tools:v1:<trusted-project>:<id>`. The project scope comes from the server-side session binding, **never** from an agent-provided field. Entries do not automatically propagate between separate Durable Objects, WorkBench or production/staging. The catalogue reuses validated **source**, not necessarily the underlying Worker isolate; `@cloudflare/computer` controls dynamic isolate creation. Do not infer that `WorkerLoader.get()` caching is active in this feature.

## Security
- The lexical source validator is defence in depth, **not a parser or security sandbox**.
- The `pure-tools` backend is the actual egress/capability boundary. Verify this in live Cloudflare before production use.
- Generated tests are **not an independent security audit**. A successful `verify` means those tests passed, not a blanket production approval.
- Project Code Mode rejects mixed/mutating MCP tool names; unknown MCP tools require both an explicit owner allowlist and an MCP read-only annotation. The host rechecks permission on every call.
- No automatic editorial authority, credential access, GitHub merge, Cloudflare deploy, or canonical CDF writes are granted.
- Outputs and source are bounded; never feed secrets or private narrative documents into synthetic test tools.
- The limit of 24 catalogue entries applies per project **within each Durable Object**.

## Acceptance and rollback
Local CI: `bun test`, `bun run typecheck`, `bun run build`, `bun scripts/check-invariants.mjs`, and full preview tests.

Before deployment: validate the candidate against the existing OpenCode staging Worker with a real `pure-tools` invocation, intentionally blocked egress, two runs, and fail-closed MCP permission tests. Then prove rollback to the prior Worker version. Do not merge into main or promote production solely on CI.

Safe rollback: deploy the previous Worker version; the new catalogue records remain in DO storage but are ignored by the old code. Do not restore or delete session SQL merely to roll back code.

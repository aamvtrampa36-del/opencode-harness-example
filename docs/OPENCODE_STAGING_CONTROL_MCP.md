# OpenCode Staging Control MCP

This repository contains a remote MCP endpoint and a separate deterministic Playwright E2E suite for `opencode-g1-staging`. The remote MCP does not need Playwright to run, and Playwright does not require an AI agent to control browser clicks.

## Fixed scope

- The only Service Binding is `STAGING_HEALTH -> opencode-g1-staging`.
- The only Durable Object binding is `STAGING_SUPERVISOR -> OpenCodeAgent` in `opencode-g1-staging`.
- New tasks use the fixed `opencode-supervisor-v1` Durable Object by default. An exact UUID workspace and exact OpenCode session ID are required to fork an existing Staging session.
- The connector has no Production URL or Production Worker binding. Production's supervisor flag is disabled and its Durable Object namespaces are separate.
- Task work is isolated to a new session, task-specific Container project, pinned GitHub source commit, and review branch. OpenCode Staging self-development branches use the GitHub branch observed by Workers Builds, currently `staging/opencode-g1-rpc-safe-20261120`. Keep this aligned when the deployed Staging base changes. A task may prepare a draft PR but cannot merge or deploy.
- Cloudflare Access OAuth protects the exact MCP workers.dev hostname. GitHub Actions uses the existing Staging Access service-token secrets for non-interactive CI.

## Endpoint and tool contracts

The Streamable HTTP endpoint is `https://opencode-staging-control-mcp.cdf-cloud-mvp-20261019.workers.dev/mcp`.

The MCP exposes status, model/repository/session discovery, sanitized session inspection, configured MCP server/tool discovery and calls, diagnostics, isolated agent checks, OpenRouter checks, task start/status/progress/continue/model selection/cancel/transcript/review. The complete parameters, model inheritance rules, idempotency, recovery steps, diagnostic fallbacks, and rollback procedure are in [OPENCODE_REMOTE_CONTROL_RUNBOOK.md](OPENCODE_REMOTE_CONTROL_RUNBOOK.md).

The default task model is Cloudflare `economy`. OpenRouter remains optional and is selected only when configured. MCP calls to other enabled servers reuse existing host-held credentials and tool allowlists; tokens are not returned to ChatGPT. An OpenRouter check or agent task can consume inference and Container resources.

## Reproducible checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:staging:control:unit
bunx wrangler deploy --dry-run --config wrangler.mcp-staging.jsonc
```

`.github/workflows/opencode-staging-control-e2e.yml` runs unit/build checks, an isolated mobile Playwright job, and a remote MCP job. The MCP job installs production dependencies only and verifies Playwright is absent. Its default smoke checks Access OAuth discovery, the full MCP tool catalog, fixed Staging identity, model/repository/session/diagnostics/MCP discovery, rejection of invalid workspaces, and rejection of an unknown task. It does not consume model quota.

Manual workflow dispatch can separately enable real OpenRouter + Bun/Linux inference, isolated red-to-green repair, a delegated engineering task, and client disconnect/reconnect recovery. Results are uploaded as JSON evidence; task transcripts are not uploaded. Required CI secrets are `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. The Playwright job uses the fixed Staging origin and runs independently of the agent.

## Operational boundary

`staging_diagnostics` reads the persisted incident ledger as a bounded projection: optional `limit` (1-64, default 20), a whole-ledger `summary`, explicit `hasMore`/`omitted`, and a `taskId` on every incident (`null` when uncorrelated). Each `taskId` equals the `requestId` from `staging_start_task`: it is taken from the ledger record when present and otherwise derived from the deterministic supervised project name `supervised-<requestId>`. Follow it with `staging_task_status`, `staging_task_transcript`, or `staging_task_progress` using that exact id. The projection is a bound, not pagination, so there is no cursor to advance. If the MCP is down, use Cloudflare Worker logs and deployment history or GitHub Actions logs as independent paths. Never change the Service Binding or Durable Object namespace to Production. Do not merge or deploy task-created branches as part of MCP E2E.

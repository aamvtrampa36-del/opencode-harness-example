# OpenCode Staging Control MCP

This repository contains a remote, stateless MCP endpoint and a separate deterministic UI/E2E check for the Cloudflare Worker `opencode-g1-staging`.

## Fixed scope

- The only service binding is `STAGING_HEALTH -> opencode-g1-staging`.
- The only Durable Object binding is `STAGING_SUPERVISOR -> OpenCodeAgent` in `opencode-g1-staging`.
- The only supervisor Durable Object name is `opencode-supervisor-v1`.
- New tasks are fixed to `aamvtrampa36-del/opencode-harness-example`; callers cannot provide a Worker URL, Durable Object name, or repository.
- The connector has no production binding, production URL, production script name, or production credentials.
- Cloudflare Access Managed OAuth protects the exact MCP workers.dev hostname. OAuth sign-in uses the Access application's existing identity policy; compatible MCP clients discover the authorization flow from the unauthenticated `401` challenge. The staging service-token policy remains enabled for CI and other non-interactive clients.

The MCP Worker is independent of Playwright. It uses the existing OpenCode supervisor RPC methods and does not create a second agent runtime, Linux container, model connection, or GitHub integration.

The managed Linux container starts with Node 24. When a shell command explicitly invokes `bun` or `bunx`, its isolated container installs and verifies the repository-pinned Bun `1.4.4` version on demand. The installation is kept by the existing container snapshot and does not edit repository files.

## MCP endpoint and tools

The endpoint is Streamable HTTP at `https://opencode-staging-control-mcp.cdf-cloud-mvp-20261019.workers.dev/mcp`.

- `staging_status`: read the fixed Staging `/api/health` endpoint.
- `staging_openrouter_check` / `staging_openrouter_check_status`: start and inspect an explicit OpenRouter (`z-ai/glm-5.3-flash`) plus Bun 1.4.4 and Linux proof check. OpenCode activates its credential plugin when the first prompt is submitted; the diagnostic pins the OpenRouter model, has no Workers AI fallback, and verifies the model, the exact `bun --version` output, a real Linux tool call, and the isolated proof file. It does not edit the supervised repository or GitHub. It consumes model inference and Linux CPU.
- `staging_start_task`: start an idempotent supervised task with a fixed repository, 16-character lowercase hexadecimal request ID, and bounded prompt. This creates a Staging branch and can consume model/CPU resources.
- `staging_task_status`: inspect an existing task.
- `staging_cancel_task`: request cancellation.
- `staging_review_task`: run the existing GitHub review for the task's locked branch. It does not approve, merge, or promote changes.
- `staging_task_transcript`: return the latest 20 messages with internal reasoning omitted and recognized credentials redacted.

All task identifiers are validated before the Staging Durable Object is called. MCP output is capped and redacted. The handler only serves `/mcp` and remains disabled unless `MCP_ENABLED=true`.

## Reproducible checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test:staging:control:unit
bunx wrangler deploy --dry-run --config wrangler.mcp-staging.jsonc
```

`.github/workflows/opencode-staging-control-e2e.yml` runs unit/build validation, UI E2E, and MCP E2E as independent jobs. The UI job runs the existing Playwright mobile suite with all model/task inputs unset. The MCP job installs production dependencies only, verifies Playwright is absent, then connects through an MCP client to enumerate tools, read Staging health, and make a read-only RPC query for a random nonexistent task ID. That final probe verifies the fixed Staging Durable Object binding without creating a task. Each remote job uploads its own evidence artifact. No AI agent drives the browser.

For an explicit intensive run, dispatch this workflow with `run_openrouter_check=true`. The MCP job then calls the fixed OpenRouter diagnostic, polls its result, and stores evidence for the actual provider preset, Bun 1.4.4 output, Linux tool call, and verified disposable proof file. The default workflow run does not consume model quota.

Required GitHub Actions secrets are the existing `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`, scoped to the Staging Access application. The MCP E2E verifies OAuth discovery without credentials, then uses the service token for read-only health and supervisor checks. Interactive MCP clients use Cloudflare Access OAuth instead of copying service-token values. The visual test only accepts the known Staging origin (or localhost for a local run); the MCP E2E URL is a fixed Staging URL.

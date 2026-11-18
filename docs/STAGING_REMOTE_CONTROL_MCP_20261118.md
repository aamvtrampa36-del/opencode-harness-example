# OpenCode Staging Control MCP — Runbook (18 Nov 2026)

## Scope and precedence

This component is *not* another OpenCode agent. It exposes the existing supervisor Durable Object through MCP JSON-RPC over HTTP, using an explicit cross-script Durable Object binding. **Only** the Worker `opencode-g1-staging` is reachable. This document supplements `docs/SUPERVISOR_REMOTE_CONTROL_STAGING_20261111.md`; the historical Worker versions and branch names in that record are not current.

This feature must remain deployed from `opencode/staging-control-mcp-20261118`, never merged into `main` merely to publish the adapter. The staging Worker is deployed from `wrangler.g1.jsonc`, while the separate MCP worker is deployed from `wrangler.staging-control.jsonc`. The latter names the external Durable Object owner by the fixed field `script_name: "opencode-g1-staging"` and never accepts account, Worker, environment or Durable Object names from clients.

The supervisory task branch for OpenCode self-development now uses this staged source branch. Other authorized repositories continue to start reviews from their default branch. This makes a supervised PR reviewable against the exact staging implementation rather than the obsolete November 11 branch.

## Authentication and transport

- Remote MCP endpoint after deployment: `https://opencode-staging-control-mcp.<account-subdomain>.workers.dev/mcp` (subdomain must be confirmed from Cloudflare, not guessed).
- Only `POST /mcp` JSON-RPC requests are supported. MCP 2025-06-18 initialization, ping, tools/list and tools/call are implemented, with JSON response mode; `GET` streaming/SSE and OAuth discovery are intentionally not implemented.
- Bind a **Worker secret** `MCP_TOKEN` containing a randomly generated 32–256 character value. No token or an invalid token means no access. Do not commit, paste into prompts, logs, or expose to model tools. Rotate through the Cloudflare dashboard / API. Never pass this credential to OpenCode or Containers.
- Requests must include `Authorization: Bearer <token>` and `Content-Type: application/json`; present browser Origin must equal the endpoint's origin. No wildcard CORS. Treat the token as allowing code execution, albeit only inside existing scoped staging tasks.
- ChatGPT custom MCP availability, OAuth requirements and write permissions are **not guaranteed** by a working HTTP endpoint. Validate with the actual client; if the client requires OAuth instead of bearer, add an OAuth layer without weakening staging restrictions.
- Cross-worker DO methods `remoteSupervisorStatus`, `remoteSupervisorSessions`, `remoteSupervisorInspect`, `remoteSupervisorContinue`, and `remoteSupervisorSelectModel` are added to the **staging-only deployment** of the existing `OpenCodeAgent` class. No extra DO and no independent Linux engine.

## Tools and contracts

All methods return real server data, or `isError:true`. No tool can promote, merge, deploy, choose another Worker, change cloud credentials, use arbitrary Linux paths, or select a random Durable Object.

| Tool | Arguments | Action |
| --- | --- | --- |
| opencode_status | {} | Real staging supervisor status and native model IDs |
| opencode_sessions | {} | Only sessions created in the supervisor workspace |
| opencode_inspect | {taskId} | Bounded transcript excerpt (last 16 KB) and task status |
| opencode_submit | {requestId, repository, prompt, model?} | Idempotently create isolated branch and project; start native Workers AI inference |
| opencode_continue | {taskId, turnId, prompt} | Idempotent subsequent turn in same OpenCode session |
| opencode_operation | {taskId} | Read status, tool counts, errors and operation ID without rerunning |
| opencode_select_model | {taskId, model} | Switch only an idle supervised session between economy and cloudflare |
| opencode_review | {taskId} | Review changes on the isolated branch without approving them |
| opencode_cancel | {taskId} | Abort only the scoped supervised task |

Both task IDs and turn IDs require 16 lowercase hexadecimal characters. The repository must be in the existing owner-approved allowlist, checked again at the Durable Object boundary. Native model selection is limited to `economy` (Cloudflare DeepSeek) or `cloudflare` (Cloudflare GLM); the remote supervisor does **not** silently use OpenRouter.

The supervisor exports a synthetic transcript excerpt, not arbitrary access to other users' sessions. Each supervised task creates a new Linux project `supervised-<id>` and isolated branch `opencode/staging-<id>` for the OpenCode repository. Branch writes and PR creation are confined by the existing GitHub bridge. The status response always returns `passed:false` and `verified:false`; finished means *finished*, not independently approved.

## Execution recipe

1. Use the `opencode_status` MCP tool and verify `environment=staging`, `worker=opencode-g1-staging`.
2. Pick a repository from the owner's allowlist. Choose a fresh `requestId` and submit an isolated, reversible task.
3. Store the returned `taskId` and `operationId`. Never retry with a new ID when the reply is lost; first poll the original ID.
4. Poll `opencode_operation` without making another model call. A stale/busy result does not mean failure. `unknown` after an interrupted submit means inspect before retrying.
5. Use `opencode_inspect` for real tool results; `opencode_review` for the branch diff.
6. Continue with a unique `turnId` or select a native model only when the prior operation is idle.
7. Validate independently through GitHub Actions or Cloudflare metadata. Do not accept the model's prose alone.
8. When finished, document real output and any remaining uncertainty. No automatic PR merge and no production promotion.

## Build, deployment and rollback

- Use a branch separate from `main`. Run `bun test`, `bun run typecheck`, `bun scripts/check-invariants.mjs` and `bunx wrangler deploy --dry-run -c wrangler.staging-control.jsonc` before live changes.
- Deploy the updated staging OpenCode first, using its existing Cloudflare Builds pipeline but branch/commit-scoped, after CI passes. The existing production Worker is never a deployment target.
- Deploy the MCP worker separately with its own Wrangler configuration or a versioned Cloudflare API upload. Configure `MCP_TOKEN` as a secret, not a plaintext binding.
- Verify the MCP handshake and tools with a real client and authorized token. Test unknown and production-target parameters fail closed. A successful unit test or script upload is **not** proof of a working external client.
- Record the last working staging Worker and MCP Worker version IDs before deployments. Roll back only the affected staging scripts if necessary. A Worker version rollback does not roll back Durable Object state or GitHub commits.
- Do not merge this branch to `main`: main triggers deployment of `opencode-harness-example`, which is explicitly out of scope.

## Recovery and known limitations

Existing supervisor workflows `opencode-supervisor-stage` provide an independent account-authorized control path if the MCP frontend fails. Cloudflare and GitHub APIs remain the recovery path if the whole OpenCode staging harness fails.

The previous standalone `/api/supervisor/v1` HTTP route requires an `OPENCODE_SUPERVISOR_TOKEN` secret and Cloudflare Access; that secret was not listed among staging Worker secrets on 18 Nov 2026. The new MCP adapter does not depend on this HTTP route: it calls the staging DO directly. Do not turn off Access or weaken the old route.

MCP tool responses are truncated at 24 KB and transcript excerpts at 16 KB. There is no SSE stream, OAuth, arbitrary user session access, automated visual browser testing, or autonomous production promotion in this release. Playwright-based UI testing and compatible client installation are follow-up acceptance work; add them only when live MCP control is proven.

The existing `docs/SUPERVISOR_REMOTE_CONTROL_STAGING_20261111.md` has historical facts, including some stale deployment/version references; this runbook supersedes them for the new connector.

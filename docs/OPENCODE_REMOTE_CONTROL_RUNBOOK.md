# OpenCode Staging Remote Control

## Purpose and boundary

This MCP server remotely inspects and controls the OpenCode installation in `opencode-g1-staging`. Its Service Binding targets that Worker, and its Durable Object binding names the same Staging script. The Production Worker is a separate deployment and namespace, with the remote-supervisor flag disabled. Do not change the bindings in `wrangler.mcp-staging.jsonc` to point elsewhere.

The MCP endpoint is protected by Cloudflare Access OAuth. Clients must authenticate through the configured Access application; the MCP tools do not accept or return OpenCode, GitHub, or OpenRouter credentials. When the MCP server itself is unavailable, use Cloudflare Workers observability or GitHub Actions as independent diagnostic paths.

## Session, project, and model behavior

- A task creates a new OpenCode session and a task-specific Linux Container project by default. Its repository is chosen from OpenCode's existing owner-approved repository list and pinned to a source commit before work begins.
- A task fork is opt-in. Supply both the exact Staging workspace UUID and exact `ses...` session ID. It inherits conversation history only; the new task's project and Container are initialized from the pinned GitHub commit, so unsaved files from the source project are not copied.
- `economy` is the default model and uses the existing Cloudflare Workers AI binding. `staging_models` reports the currently registered presets and, only when OpenRouter is configured, tool-compatible catalogue models with prices. OpenRouter selections are rejected unless configured and verified for tool use.
- The existing GitHub bridge holds its credential in the Worker. A self-development task uses a deterministic `opencode/staging-<requestId>` branch based on the branch currently observed by Workers Builds: `staging/opencode-g1-rpc-safe-20261120`. Keep `OPENCODE_STAGING_BASE` aligned with that branch; other approved repositories use their existing supervised branch policy. The agent can create a draft PR, but cannot merge or deploy.
- A completed operation is reported as `finished`; this does not mean its code is approved. Review the transcript, branch diff, and CI before accepting any change. Cancellation is reported as confirmed only after OpenCode observes the interruption.

## MCP tools

| Tool | Inputs | Purpose |
| --- | --- | --- |
| `staging_status` | none | Staging health plus supervisor schema and capabilities |
| `staging_models`, `staging_repositories` | none | Discover registered models and owner-approved repositories |
| `staging_sessions` | optional `workspace` UUID | List at most 100 sessions inside the selected Staging workspace |
| `staging_session_inspect` | `session`; optional `workspace` UUID | Read a bounded, redacted conversation excerpt and its project scope |
| `staging_mcp_servers` | none | List enabled MCP servers already configured in OpenCode |
| `staging_mcp_tools` | `server` | Discover the selected server's allowed tools and input schemas |
| `staging_mcp_call` | `server`, `name`, optional JSON `arguments` | Call an existing allowed MCP tool; its own permissions still apply |
| `staging_diagnostics` | none | Read Staging health and the persisted incident ledger |
| `staging_agent_check` | optional `model`, `kind` | Run an isolated real Linux, Bun, or red-to-green repair check |
| `staging_agent_check_status` | none | Read independent tool/file/runtime evidence from the last check |
| `staging_openrouter_check` | none | Spend one OpenRouter inference to verify provider, Bun, and Linux |
| `staging_openrouter_check_status` | none | Read the OpenRouter check evidence |
| `staging_start_task` | `requestId`, `prompt`; optional `repository`, `model`; fork pair `workspace` + `sourceSession` | Start one isolated delegated task; `requestId` is exactly 16 lowercase hex characters |
| `staging_task_status` | `id`; optional `workspace` | Read durable state, operation ID, and real tool-call counts |
| `staging_task_progress` | `id`; optional `workspace`; optional `after` cursor | Read bounded event sequence/type without chain-of-thought |
| `staging_task_continue` | `id`, `turnId`, `prompt`; optional `workspace` | Continue or steer a task; retry with the same `turnId` and prompt |
| `staging_task_select_model` | `id`, `model`; optional `workspace` | Change model while the task session is idle |
| `staging_cancel_task` | `id`; optional `workspace` | Request cancellation and report whether interruption was confirmed |
| `staging_task_transcript` | `id`; optional `workspace` | Read the last 20 persisted messages with reasoning omitted and secrets redacted |
| `staging_review_task` | `id`; optional `workspace` | Compare the task's locked branch with its base; does not approve or merge |

All workspace identifiers are UUIDs for Durable Objects in the Staging namespace. The `workspace` parameter is accepted for task creation only together with `sourceSession`; it cannot retarget the Service Binding or select Production.

## Delegation and recovery example

1. Call `staging_status`, then `staging_models` and `staging_repositories`.
2. Start with a fresh 16-character hexadecimal `requestId`, a bounded engineering prompt, and optionally a model selection. Omit `workspace` and `sourceSession` for an isolated session.
3. Poll `staging_task_status`; use `staging_task_progress` with the returned cursor for progress. `staging_task_transcript` includes persisted tool records; require actual Linux/GitHub tool results before claiming work was executed.
4. If the client disconnects, retry `staging_start_task` with the exact same `requestId` and payload. The server persists `rc-start-<requestId>` before submission, so the retry retrieves the same operation rather than submitting a second task. Reusing an ID with different parameters fails.
5. Use a new `turnId` for each `staging_task_continue` instruction and reuse that same ID only for retries of the same instruction. The native OpenCode receipt is `rc-turn-<taskId>-<turnId>`.
6. Inspect the diff with `staging_review_task` and confirm the draft PR and CI. Never treat `finished` as approval.

## Diagnostics and limits

`staging_diagnostics` reads the incident ledger persisted by the OpenCode Worker. Cloudflare Workers logs and deployment/version history are the independent path for Worker errors, latency, and runtime observations. GitHub Actions logs and artifacts are the independent path for build, unit, Playwright, and MCP E2E failures. If Remote Control fails, inspect those sources directly through Cloudflare or GitHub; they do not call the MCP endpoint.

`staging_sessions` does not enumerate all Durable Objects. To inspect a normal UI session, the operator must supply its exact workspace UUID and session ID. Transcript and session excerpts are bounded and sanitized, but they may still contain user conversation content; share them only with the authorized owner.

## Validation

- Local static and regression checks: `bun run typecheck`, `bun test`, and `bun run test:staging:control:unit`.
- Remote protocol smoke: `bun run test:staging:control:mcp` with `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` supplied through the protected CI secrets. It checks OAuth discovery, the full tool catalog, Staging identity, model/repository/session/MCP discovery, invalid workspace rejection, and an unknown task negative case. Playwright is not installed in this job.
- Mobile UI E2E: `bun run test:staging:mobile` runs the deterministic Playwright flow independently of an AI agent and saves a 393x852 screenshot.
- Manual, cost-gated workflow dispatch can enable the OpenRouter check, isolated repair, delegated engineering task, and client disconnect/reconnect recovery. A push to the hardening branch with `[remote-control-full-e2e]` in its commit message runs the three Cloudflare economy experiments after deployment. The MCP job uploads a JSON evidence summary; it does not upload conversation transcripts.

The delegated task and recovery experiments use `economy` by default. OpenRouter is optional and its check may consume provider credit. All tasks use isolated Container projects and review branches; no E2E scenario merges or deploys a task-created PR.

## Deployment and rollback

Build and review both Staging configs before deployment. The application Worker is built through Cloudflare Workers Builds from `wrangler.g1.jsonc`; the MCP Worker has an independent build configuration using `wrangler.mcp-staging.jsonc`. Their build commands run checks before deployment. The MCP Worker config must retain the Service Binding to `opencode-g1-staging` and the Durable Object binding with `script_name: opencode-g1-staging`. Never use Production's `wrangler.jsonc` for this task.

After a Staging-only deploy, check `staging_status`, verify the MCP tool list, and run the non-costly E2E smoke. For rollback, select the last known-good version of `opencode-staging-control-mcp` or `opencode-g1-staging` in Cloudflare Workers Deployments and restore that version. Verify Staging health and the remote-control smoke afterward. Do not roll back or edit `opencode-harness-example` (Production) as part of this runbook.

## Memory-bounded status polling (incident #90)

Supervisor task status uses the durable OpenCode event log with a persisted per-task sequence cursor, **not** `session.history()`. Each poll processes at most 256 durable events and returns the partial-progress flag `toolCountsComplete`; if the log cannot be read, counters are unknown (`null`, `toolCountsError`) rather than fabricated zeros. A follow-up status poll advances the cursor. Full transcript export is an explicit, separate operation and is not a safe health probe for a very large session.

Live staging issue: [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). Bounded polling prevents this specific unbounded materialization, but does not establish that the historical 2026-11-20 isolate memory reset had exactly this cause. Preserve evidence and observe after deployment.

## Automatic PR conflict preflight (agent-scoped)

Before an OpenCode agent creates a draft PR through GitHubBridge `action: "pr"`, the bridge now reads **actual GitHub Compare changed paths** and **all open PR file lists for the same base branch**. Duplicate branch, overlapping current or prior renamed paths, untrustworthy/truncated results, and moved base/head SHA all reject **before** the GitHub PR POST. This is enforced in code, not optional handoff advice. Review branches remain isolated and cannot merge using GitHubBridge.

Limit: this is a preflight for **agent-created PRs**, not a distributed lock. Two truly simultaneous PR creates may race; direct GitHub UI/API merges do not pass this bridge. Protect the target branch through GitHub rulesets with required CI/checks and human review before claiming organization-wide merge prevention. No expansion of CDF editorial permissions is implied.

# OWNERS — Plan Metralla v1.0 / R2

B0 `837dce9b283f6b4b0b2ba939407883ec95be726a`; tree `79a5fb65f0f0cd825e2f2dd37defca692317da8c`. One active writer per lane, serial P within each M. Branches from exact B0, then predecessor verified HEAD; create only when respective L-B prompt authorized. No precreation by M00. Read access only to all other paths; explicit paths/prefixes below are exclusive. Prefix ending in `/` means subtree; `src/metralla-mXX-` means filename prefix. New files elsewhere require M08 hunk or scope clarification, not silent takeover. No edits to protected historical branches. Every specialist writes only own receipt(s), and submits shared hunks under its packet directory with base SHA, affected path and test. Cross-lane contracts below are initial compatibility interfaces, not certified runtime contracts; consumers can implement against fixtures while producer verifies; conflicts go to M08. P11/P16 may use published interface before predecessor package finalization; if incompatible, deliver isolated hunk to M08. No automatic grant from this file.

## M01 — admisión y recuperación
Branch: `metralla/m01`; subencargos P02, P03, P04, P05; sequence 02→03→04→05→25.

Interface: Admission v1: request/turn identity, reservation token/generation, intent→confirmed/unknown, cancellation and verified release; no second ledger. M04 budget and M03/M05 receipt interfaces.

Exact paths (including reserved new paths):
- `src/supervisor-admission.ts`
- `src/supervisor-admission.test.ts`
- `src/supervisor-admission-c05-t02.test.ts`
- `src/supervisor-reconciliation.ts`
- `src/supervisor-reconciliation.test.ts`
- `src/supervisor-r2.ts`
- `src/supervisor-legacy-capacity.ts`
- `src/supervisor-legacy-admission.test.ts`
- `src/supervisor-async-start.ts`
- `src/supervisor-async-start.test.ts`
- `src/supervisor-recovery.test.ts`
- `src/supervisor-status-reconciliation.test.ts`
- `src/supervisor-t03-t04-integration.test.ts`
- `scripts/f0-c10/c05-t03-server.test.mjs`
- `docs/metralla/receipts/M01.md`
- `docs/metralla/receipts/P02.md`
- `docs/metralla/receipts/P03.md`
- `docs/metralla/receipts/P04.md`
- `docs/metralla/receipts/P05.md`

Exclusive prefixes:
- `src/metralla-m01-`
- `scripts/f0-c10/metralla-m01/`
- `docs/metralla/packets/M01/`

## M02 — memoria, telemetría y Remote
Branch: `metralla/m02`; subencargos P06, P07, P08, P09; sequence 06→07→08→09→25.

Interface: Remote evidence v1: bounded projection, scoped cursor, request/session/operation + phase interval and distinct active/queued counts; M07 consumes, M08 wires.

Exact paths (including reserved new paths):
- `src/supervisor-phase-telemetry.ts`
- `src/supervisor-phase-telemetry.test.ts`
- `src/supervisor-metrics.ts`
- `src/supervisor-metrics.test.ts`
- `src/supervisor-directory.ts`
- `src/supervisor-directory.test.ts`
- `src/supervisor-progress.ts`
- `src/supervisor-progress.test.ts`
- `src/supervisor-transcript-containment.test.ts`
- `scripts/f0-c10/phase-memory-profile.mjs`
- `scripts/f0-c10/phase-memory-profile.test.mjs`
- `scripts/f0-c10/harness-residency-bench.mjs`
- `scripts/f0-c10/harness-residency-bench.test.mjs`
- `scripts/f0-c10/memory-retention-prototype.mjs`
- `scripts/f0-c10/memory-retention-prototype.test.mjs`
- `scripts/f0-c10/r3-memory-baseline.mjs`
- `scripts/f0-c10/r3-memory-baseline.test.mjs`
- `docs/metralla/receipts/M02.md`
- `docs/metralla/receipts/P06.md`
- `docs/metralla/receipts/P07.md`
- `docs/metralla/receipts/P08.md`
- `docs/metralla/receipts/P09.md`

Exclusive prefixes:
- `src/staging-control-mcp/`
- `src/metralla-m02-`
- `scripts/f0-c10/metralla-m02/`
- `docs/metralla/packets/M02/`

## M03 — Linux y recuperación física
Branch: `metralla/m03`; subencargos P10, P11, P12; sequence 10→11→12→25; 11 uses M05 interface v1; no wait on live.

Interface: Execution/source v1: repo SHA/tree, project/VM/boot/digest, lease, bounded stdout/stderr, exit, timeout, verified physical close; M05 provides source, M01 consumes closure.

Exact paths (including reserved new paths):
- `src/dev-container.ts`
- `src/dev-guard.ts`
- `src/dev-guard.test.ts`
- `src/bounded-process-output.ts`
- `src/bounded-process-output.test.ts`
- `src/pilot-preparation.ts`
- `src/pilot-preparation.test.ts`
- `src/github-import-source.ts`
- `src/github-import-source.test.ts`
- `src/github-import-certification.test.ts`
- `src/container-recovery.ts`
- `src/container-recovery.test.ts`
- `src/container-verify.ts`
- `src/container-verify.test.ts`
- `src/dev-runtime.ts`
- `src/dev-runtime.test.ts`
- `src/scoped-linux-tools.ts`
- `src/scoped-linux-tools.test.ts`
- `src/snapshot-policy.ts`
- `src/snapshot-policy.test.ts`
- `src/restore-project.ts`
- `src/restore-project.test.ts`
- `src/project-container.ts`
- `src/project-container.test.ts`
- `scripts/f0-c10/t06-linux-fixtures.mjs`
- `scripts/f0-c10/t06-r2-output-disconnect.test.mjs`
- `scripts/f0-c10/t06-r2-process-fixtures.mjs`
- `scripts/f0-c10/t06-r3-linux.test.mjs`
- `scripts/f0-c10/t06-r3-source-contract.test.mjs`
- `scripts/f0-c10/t06-r3-tree-child.cjs`
- `docs/metralla/receipts/M03.md`
- `docs/metralla/receipts/P10.md`
- `docs/metralla/receipts/P11.md`
- `docs/metralla/receipts/P12.md`

Exclusive prefixes:
- `src/metralla-m03-`
- `scripts/f0-c10/metralla-m03/`
- `docs/metralla/packets/M03/`

## M04 — inferencia y costes
Branch: `metralla/m04`; subencargos P13, P14, P15; sequence 13→14→15→25.

Interface: Budget v1: reservation/settlement/unknown sticky, input/output/wire/calls/time caps, pricing and round ceiling; transport manual deny 3xx without credential forwarding; M01 calls budget, M05 consumes transport.

Exact paths (including reserved new paths):
- `src/supervisor-inference-budget.ts`
- `src/pilot-hybrid.ts`
- `src/pilot-hybrid.test.ts`
- `src/pilot-http.ts`
- `src/pilot-http.test.ts`
- `src/model-presets.ts`
- `src/model-presets.test.ts`
- `src/openrouter-catalog.ts`
- `src/openrouter-catalog.test.ts`
- `scripts/f0-c10/inference-budget.mjs`
- `scripts/f0-c10/inference-budget.test.mjs`
- `scripts/f0-c10/inference-durable.test.mjs`
- `scripts/f0-c10/inference-durable-known-red.red.mjs`
- `scripts/f0-c10/inference-known-red.red.mjs`
- `scripts/f0-c10/inference-sim.mjs`
- `scripts/f0-c10/inference-sim.test.mjs`
- `docs/metralla/receipts/M04.md`
- `docs/metralla/receipts/P13.md`
- `docs/metralla/receipts/P14.md`
- `docs/metralla/receipts/P15.md`

Exclusive prefixes:
- `src/metralla-m04-`
- `scripts/f0-c10/metralla-m04/`
- `docs/metralla/packets/M04/`

## M05 — GitHub
Branch: `metralla/m05`; subencargos P16, P17, P18; sequence 16→17→18→25; 16 uses M04 interface v1.

Interface: GitHub effect/source v1: repo/base SHA/tree, scoped branch/paths, expected ref, idempotent draft PR and positive proof of absent/materialized/unknown; consume M04 transport and M03 import-source.

Exact paths (including reserved new paths):
- `src/github.ts`
- `src/github.test.ts`
- `src/github-import.ts`
- `src/github-import.test.ts`
- `src/github-download.ts`
- `src/github-publication-durable.ts`
- `src/github-publication-durable.test.ts`
- `src/github-publication-gate.test.ts`
- `src/github-r3-multiwriter.test.ts`
- `src/github-pr-conflicts.test.ts`
- `src/github-pr-search.test.ts`
- `src/project-scope.ts`
- `src/project-scope.test.ts`
- `src/project-scope-read-only.test.ts`
- `src/repository-import-scope.ts`
- `src/repository-import-scope.test.ts`
- `src/scoped-github.ts`
- `src/scoped-github.test.ts`
- `docs/metralla/receipts/M05.md`
- `docs/metralla/receipts/P16.md`
- `docs/metralla/receipts/P17.md`
- `docs/metralla/receipts/P18.md`

Exclusive prefixes:
- `src/metralla-m05-`
- `scripts/f0-c10/metralla-m05/`
- `docs/metralla/packets/M05/`

## M06 — resultados y artefactos
Branch: `metralla/m06`; subencargos P19, P20, P21; sequence 19→20→21→25.

Interface: Artifact v1: task/owner/project, safe name/type, length, sha256, authenticated byte retrieval and bounded export; client.tsx hunk only; M07 checks bytes.

Exact paths (including reserved new paths):
- `src/task-output-artifacts.ts`
- `src/task-output-artifacts.test.mjs`
- `src/task-artifact-source.ts`
- `src/task-artifact-source.test.mjs`
- `src/task-artifact-http.test.mjs`
- `src/download-response.ts`
- `src/download-response.test.ts`
- `src/session-export.ts`
- `src/session-export.test.ts`
- `scripts/f0-c10/c05-t09-safety.test.mjs`
- `docs/metralla/receipts/M06.md`
- `docs/metralla/receipts/P19.md`
- `docs/metralla/receipts/P20.md`
- `docs/metralla/receipts/P21.md`

Exclusive prefixes:
- `src/metralla-m06-`
- `scripts/f0-c10/metralla-m06/`
- `docs/metralla/packets/M06/`

## M07 — evaluación y harness
Branch: `metralla/m07`; subencargos P22, P23, P24; sequence 22→23→24→25.

Interface: Evidence v1: frozen manifest with task identity, independent activity events/intersection, oracle, verified bytes/hash, tool exits, GitHub effect, cost and physical/logical close; offline is never live PASS.

Exact paths (including reserved new paths):
- `scripts/f0-c10/evaluate.mjs`
- `scripts/f0-c10/evaluate.test.mjs`
- `scripts/f0-c10/live-evidence.mjs`
- `scripts/f0-c10/live-evidence.test.mjs`
- `scripts/f0-c10/mock.mjs`
- `scripts/f0-c10/tasks.mjs`
- `scripts/f0-c10/run-offline.mjs`
- `scripts/f0-c10/verify-live.mjs`
- `scripts/f0-c10/observed-journal.mjs`
- `docs/metralla/receipts/M07.md`
- `docs/metralla/receipts/P22.md`
- `docs/metralla/receipts/P23.md`
- `docs/metralla/receipts/P24.md`

Exclusive prefixes:
- `docs/f0-c10/fixtures/`
- `src/metralla-m07-`
- `scripts/f0-c10/metralla-m07/`
- `docs/metralla/packets/M07/`

## M08 shared/integration only
- `src/server.ts`
- `src/supervisor-workflow.ts`
- `src/supervisor-control.ts`
- `src/sockets.ts`
- `src/protocol.ts`
- `src/client.tsx`
- `src/entrypoint.ts`
- `src/pilot-authorization.ts`
- `package.json`
- `bun.lock`
- `tsconfig.json`
- `wrangler*.jsonc`
- `.github/workflows/**`
- `scripts/f0-c10/r4-*`
- `src/*-bindings.d.ts`
Other unassigned runtime files read-only for specialists; bring exact hunks to M08. M03 owns github-import-source, M05 owns github-import, M04 owns pilot-http, M06 owns artifact contract but client.tsx only hunk, M01 owns admission/reconciliation; M07 owns explicit harness paths, not the entirety of scripts/f0-c10. For P25 integration branch metralla/integracion-01, use exact B0 + accepted lane receipts; L-C required. Control only coordinator P01/P25/live/auditor per authorized handoff. No two chats write same branch concurrently. GitHub expected ref is checked; STATE advisory, not a technical runtime lease.

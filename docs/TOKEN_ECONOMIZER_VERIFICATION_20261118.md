# TokenEconomizer connector — staging verification (2026-11-18)

Status: **staging evidence, not an approved production record.** This document records what was
actually executed in an isolated Linux Container for the review branch
`opencode/staging-c0de202611180515`. It does not certify the Cloudflare Container runtime,
billing, or the mobile end-to-end suite.

## What the connector is

- Upstream product: `microsoft/TokenEconomizer`, Python 3.10+, standard library only,
  Apache-2.0, version `0.1.0` (`pyproject.toml`).
- Pinned commit: `7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0`, the same commit already named in
  [OpenCode Cloud extensions](OPEN_CODE_EXTENSIONS_20261115.md).
- Hook entry point: `tokeneconomizer.plugin.hook.run(payload, env, host_hint="opencode")`.
  The official OpenCode plugin (`plugin/opencode/tokeneconomizer.ts`) is a translator around
  that entry point; this repository keeps its own OpenCode event adapter
  (`src/token-economizer-adapter.ts`) and calls the same entry point from the connector
  Container.

The adaptation is deliberately model-free: only the `envfacts` micro-skill is enabled.
`envfacts` learns short environment facts from recurring failures and its module docstring
states `opt_tokens` is 0. Loop guarding, tool pruning, repository maps and paid side calls stay
off. No model key, proxy or host credential is placed in the hook environment.

## Starting point: the base branch already ships the connector

The review branch starts from `staging/opencode-g1-20261118`
(`1a5a3aaf3f46824798f7f54f688b3ccc1f3e0041`), which already contains the connector end to end:

- `src/dev-container.ts`: `installTokenEconomizer()` (pinned clone/checkout) and
  `runTokenEconomizerHook()` (validated event, bounded `exec`, frozen environment).
- `src/server.ts`: `/api/settings/connectors` routes and hook invocation.
- `src/token-economizer-adapter.ts`: OpenCode event translation.
- `src/connector-panel.tsx` and the connector documentation.

This change therefore does **not** claim to introduce the connector. It adds a drift guard and
records reproducible evidence for the existing code.

## Change under review

1. `src/token-economizer-contract.ts` (new, dependency-free): one source of truth for the pin,
   the clone URL, the three connector directories, the five accepted events, the transcript
   path, the hook environment and the runner source.
2. `src/token-economizer-contract.test.ts` (new): locks the pin (and checks the documentation
   records it), the model-free environment, the five accepted events, the runner's official
   entry point and fail-open shape, and — when the pinned checkout and `python3` are present —
   executes the exact runner bytes. It also reads `src/dev-container.ts` and
   `src/token-economizer-adapter.ts` and fails if the shipped installer or adapter drifts from
   these values, including a comparison of the evaluated runner string.
3. `src/token-economizer-adapter.ts`: one-line substitution, so the workspace path comes from
   `tokenEconomizerWorkspace(project)` instead of a repeated literal.
4. `src/dev-container.ts` and `src/server.ts` are **unchanged** from the base branch.

The runner constant in the contract module and the runner already present in
`src/dev-container.ts` evaluate to the same 689-byte string. Their source spellings differ
(escaped newlines in the base file, literal newlines in the contract module); the test executes
the contract copy and the comparison below evaluates both.

## Commands and real results

Environment: Debian container, Python `3.13.5`, Bun `1.4.4`. The checkout at
`/workspace/projects/opencode-connectors/token-economizer` is detached at
`7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0` (`git rev-parse HEAD`).

| Command | Result |
| --- | --- |
| `git -C <clone> rev-parse HEAD` | `7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0` |
| manual check against that clone (`rev-parse` + `test -f` on `hook.py` and `paths.py`) | `INSTALL_CHECKS_OK` |
| runner evaluated from `src/dev-container.ts` vs from `src/token-economizer-contract.ts` | equal, 689 bytes |
| `bun test src/token-economizer-contract.test.ts src/token-economizer-adapter.test.ts` | 10 pass, 0 fail, 113 `expect()` calls |
| `NODE_OPTIONS=--max-old-space-size=3072 bun run typecheck` | exit 0 |
| `bun run build` | **not completed**: `timeout 300` returned 124 with no output |

The plain `bun run typecheck` needed `NODE_OPTIONS=--max-old-space-size=3072` in this Container;
without it, `tsc` previously exited 134 after an out-of-memory crash. The build timeout is a
Container resource limit here and is reported as unresolved, not as a pass.

## Live hook run (exact shipped runner)

The runner source was extracted from the module under test and executed with the shipped
environment (`TE_MICROSKILLS=envfacts`, loopguard/toolprune/repomap `off`,
`TE_OPENCODE_MODE=run`), against the pinned clone and the real state root.

- Four simulated sessions, each with `SessionStart`, `UserPromptSubmit`, `PostToolUse`,
  `Stop` and `SessionEnd`: **20 hook calls, all exit code 0**.
- The transcripts recorded `pytest -q` failing with `bash: pytest: command not found`
  (`exit_code: 127`) and `python -m pytest -q` succeeding.
- The next `SessionStart` returned 145 characters of learned context:

  ```text
  # environment facts learned from earlier sessions in this repository
  - `pytest …` fails here with command not found; `python -m pytest …` works.
  ```

- Ledger written by the fold: `state/repos/verify-20261118-5bce193a9b/opencode/ledger.jsonl`
  (2807 bytes). The state root is created with mode `0700`.

## Limits and open items

- The hook layer ran in this Linux Container, not inside the Cloudflare Container. The installer
  shell fragment and the Container `exec` arguments were checked against the same clone, but the
  Durable Object path (`installTokenEconomizer`, `runTokenEconomizerHook`) was not executed here.
- The mobile end-to-end workflow (`verify_token_economizer`) was not run for this change.
- `envfacts` is the only enabled micro-skill; no statement here covers loop guarding, tool
  pruning, repository maps or paid side calls.
- Known gap, not changed here: the shipped installer verifies only the commit SHA. It does not
  assert that `tokeneconomizer/plugin/hook.py` and `tokeneconomizer/plugin/paths.py` exist after
  checkout, so a truncated checkout would surface at the first chat turn. Adding that assertion
  requires editing `src/dev-container.ts` and is left as a follow-up rather than done silently.

## Rollback

- Revert this branch's commit. The contract module and its test are additive; the only edit to
  an existing file is the one-line workspace helper in the adapter, and `dev-container.ts` and
  `server.ts` are untouched.
- Or disable the connector in **Settings → Conectores y hooks**; hooks fail open, so chat turns
  continue without the connector.
- Connector state under `/workspace/projects/opencode-connectors/state` is disposable learning
  data and can be removed without touching project files.

# F0-C10/R4 — PARTIAL / STOP_LIVE / NO_COMPLETE_PASS

Actor: ChatGPT; authorized GitHub auxiliary branch only, Cloudflare Admin GET, no remote inference. Candidate PR #163 remains draft at `42574cb3f5ee0cbfab2ce54176145c089edc41df`, source CI 45326449041. No deployment, merge, modification of production, main, integrator, Access, secrets, Cloudflare resources or billing policies. No pilot branch/task created by this lot.

## Proven subgates
- Transport canary run 45328957269, artifact 14891315380 (347 bytes): producer/consumer success and actual connector download into Linux, ZIP SHA-256 and inner bytes independently verified.
- Two independent source builds run 45329083188: jobs 138225597580/138225597948/138225837363 all success. ZIP A 14891381103 / 69e7c466de1a0a4b3065b0f53042986250fe0b8c5e3f3f26feeb51f20c6d7ca5; ZIP B 14891465366 / cba4bb8d081fb20157659e6f1a6cb3166fd8cd69378581a72e00eebf83359ee2. Both actually downloaded; 1,002 entries, 999 byte-identical, three differences: principal/README.md and mcp/README.md timestamps; mcp/worker.js.map sourceRoot only. Other map fields identical. No executable difference. Strict normalizer checks only these generated fields, verifies outer ZIP, inner archive and every file. Diagnostic artifact label remains; no claim of deployable upload.
- Verifier commit 7547fc981e0279f50c027bf5cfa3912c31caa5ae, CI 45329324593, nine tests pass, independent local reproduction gives identical receipt. Initial operational CI 45329698139 STOP code 1: manually transcribed pin 62 chars; corrected from earlier independently verified 64-char receipt (23ac425f7027fb99dc2d51d29a8a10ee180fdb08), one bounded retry CI 45329797840 passes ten negative/positive checks and expected operational STOP code 2. Report artifact 14890973284, SHA256 82923cc1c8420488cbc3f651ddaa971d04a8340405e9758a2b3869b9a8deeb64, downloaded and executed locally with 10 PASS and identical receipt.
- Stage-only selection: 771 files / 57,377,840 bytes, 230 production-directory files excluded. Generated principal config no_bundle true; original MCP config still refers to source TS, so prebuilt mapping must be verified, not guessed. Both rollback versions and binding metadata match observed candidate configuration. Zero active/starting container instances in point-in-time read, not global exclusivity. Container image absent from returned configuration and application versions empty.
- Current billing query returned 588 records, no current cycle records; prior DO 49947.723081728, previous-cycle proxy 81,948/400,000 with 318,052 estimated headroom. Not a current measured balance or invoice cap; revalidate pricing and unrelated activity before live authorization.
- Artifacts retained one day; diagnostic packages expire 2026-11-25 around 04:50Z. Future recompilation must verify normalized content, retain actual bytes and independently record new raw archive digests; do not reuse stale evidence.

## Remaining decisive executor gap
Linux receives actual artifact bytes but has no verified Cloudflare deployment credential/network. Cloudflare Admin accepts code strings / multipart payload construction, no documented direct file-ref handoff. Existing Workers Builds triggers for the two Staging Workers have existing token association and auto-deploy commands; the API supports manual exact commit_hash builds, but current commands cannot enforce the R4 manifest before deployment, and the MCP prebuilt/config mapping is unverified. Do not launch the existing triggers as-is. Recommended next experiment (separate specific authorization for temporary edits to the two existing Staging Build triggers only, no secrets/new infrastructure): snapshot triggers, lock auto-trigger scope, run exact candidate build under a guarded command with an explicitly inert deploy command; verify normalized executable/assets/config content and exact target/config paths before proposing actual upload; restore trigger configuration and verify no Worker deployment changed. If the runner cannot reproduce the content, STOP and investigate differences; do not use unverified bytes or automatic deploy. No claim that this route is proven. Also certify Container image/compatibility, exclusive lane and never-consumed request ID, fresh economics and one-use grant before any dispatch. Preserve current code rollback IDs; code rollback is not data rollback.

## Machine receipt (historical, not an activation grant)

```json
{
  "billing": {
    "basis": "previous-cycle-proxy",
    "currentCycleRecords": 0,
    "estimatedSlackGBs": 318052,
    "invoiceGuarantee": false,
    "proxyTotalGBs": 81948
  },
  "completePass": false,
  "decision": "STOP",
  "deploymentAuthorized": false,
  "differingMetadata": [
    "mcp/README.md",
    "mcp/worker.js.map",
    "principal/README.md"
  ],
  "gates": {
    "artifactIntegrity": "PASS",
    "authorizationV2": "STOP_NOT_INSTALLED",
    "billingScenario": "CONDITIONAL_PROXY_ONLY",
    "bindingMetadataParity": "PASS",
    "candidateCI": "PASS",
    "containerIdleSnapshot": "PASS_POINT_IN_TIME",
    "containerImageCompatibility": "STOP_NOT_CERTIFIED",
    "currentPricingAndSharedActivity": "STOP_REVALIDATE",
    "executorByteHandoff": "STOP_NOT_CERTIFIED",
    "freshReadSnapshot": "PASS",
    "liveScope": "STOP_OFFLINE_ONLY",
    "pilotBranchAbsent": "PASS",
    "reproducibility": "PASS_METADATA_ONLY",
    "requestNeverConsumedAndExclusiveLease": "STOP_NOT_CERTIFIED",
    "rollbackReadback": "PASS",
    "stageOnlySelection": "PASS"
  },
  "normalizedInventorySha256": "e98e57a3bc0c860440a4a4a116e57644b990ed5105764567b0cb1158a929b575",
  "observedAt": "2026-11-24T04:54:17Z",
  "packageRun": "45329083188",
  "providerDispatchAuthorized": false,
  "rollback": {
    "opencode-g1-staging": "613059c6-4675-4b24-b124-ed289ba23d01",
    "opencode-staging-control-mcp": "90910fcf-455d-4b26-8df0-eb8fcab8b7a0"
  },
  "schema": "r4-operational-preflight-v1",
  "source": "42574cb3f5ee0cbfab2ce54176145c089edc41df",
  "sourceCI": "45326449041",
  "stageOnly": {
    "bytes": 57377840,
    "excludedProductionFiles": 230,
    "files": 771,
    "inventorySha256": "e7b13a5d9fbecaccb8a9159f86ce31d485c5722ea996ce5f2dcd8733e19f71d1",
    "targets": [
      {
        "assets": "dist/client",
        "config": "dist/opencode_g1_staging/wrangler.json",
        "main": "principal/index.js",
        "worker": "opencode-g1-staging"
      },
      {
        "assets": null,
        "config": "wrangler.mcp-staging.jsonc",
        "main": "mcp/worker.js",
        "note": "config is original source config; using prebuilt MCP requires verified executor/metadata mapping",
        "worker": "opencode-staging-control-mcp"
      }
    ]
  }
}
```

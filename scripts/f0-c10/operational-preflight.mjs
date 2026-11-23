/**
 * F0-C10/PREFLIGHT-01. Read-only evidence evaluator.
 *
 * This module deliberately CANNOT authorize a live request or deployment.
 * The current inputs are observations collected through connectors and are
 * not signed, provider-enforced spending cutoffs or runtime leases.
 * "STOP" is mandatory even if a caller hand-edits all claims to "true".
 *
 * A future operational adapter must independently attest live identities,
 * costs, lease and cutoffs before a separate GO gate can be designed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "f0-c10.preflight-readonly.v1";
export const GATE_IDS = Object.freeze([
  "source_offline_ci",
  "deployment_provenance",
  "exclusive_lease",
  "legacy_capacity",
  "native_recovery",
  "isolate_memory",
  "linux_process_isolation",
  "all_service_hard_cost_cutoff",
  "artifact_acl_android",
  "independent_observer",
  "rollback_complete"
]);
const SHA = /^[a-f0-9]{40}$/;
const STATUS = new Set(["VERIFIED", "PARTIAL", "BLOCKED", "FAIL", "NOT_TESTED"]);
const fixed = (status, reason) => ({status, reason});
const asObject = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const truth = value => value === true;

/**
 * @param {unknown} raw Unsigned, read-only snapshot. Never accept it as a
 * live authorization token, regardless of how optimistic its fields are.
 */
export function evaluateReadonlyPreflight(raw) {
  const input = asObject(raw);
  if (input.schema !== SCHEMA || input.evidenceClass !== "read_only_connector_snapshot") {
    throw new Error("PREFLIGHT_SNAPSHOT_SCHEMA_OR_PROVENANCE_INVALID");
  }
  const source = asObject(input.source);
  const cf = asObject(input.cloudflare);
  const control = asObject(input.controls);
  const deployments = asObject(cf.deployments);
  const ci = Array.isArray(source.ci) ? source.ci : [];
  const validatedCandidate = SHA.test(source.candidateSha) &&
    ci.length >= 2 && ci.every(item => item &&
      item.headSha === source.candidateSha && item.status === "completed" &&
      item.conclusion === "success" && Number.isSafeInteger(item.runId));
  const principal = asObject(deployments.principal);
  const mcp = asObject(deployments.mcp);
  const pairObserved = principal.percentage === 100 && mcp.percentage === 100 &&
    typeof principal.versionId === "string" &&
    typeof mcp.versionId === "string";
  const signedSourceIdentity = truth(control.workerSourceBundleDigestAttested) &&
    truth(control.mcpSourceBundleDigestAttested) &&
    truth(control.assetsAndBindingsAttested);
  const observedGateway = asObject(cf.aiGateway);
  const disabledLegacyLimit = observedGateway.legacySpendingLimitEnabled === false;
  const gatewayRateUnknown = observedGateway.rateLimit === null ||
    observedGateway.rateLimit === undefined;
  const modelRoutes = asObject(cf.modelRoutes);
  const directAI = truth(modelRoutes.workersAIBindingConfigured);
  const tracing = asObject(cf.tracing);
  const r3 = asObject(input.r3);
  const gates = {
    source_offline_ci: validatedCandidate
      ? fixed("VERIFIED", "SOURCE_CI_PASS_ONLY")
      : fixed("BLOCKED", "EXACT_CANDIDATE_CI_NOT_PROVEN"),
    deployment_provenance: pairObserved && signedSourceIdentity
      ? fixed("PARTIAL", "READ_ONLY_SNAPSHOT_CANNOT_PROVE_RUNTIME_BINARY")
      : fixed("BLOCKED", "TWO_WORKER_SOURCE_ASSET_BINDING_DIGEST_NOT_ATTESTED"),
    exclusive_lease: fixed("NOT_TESTED", "NO_AUTHENTIC_EXCLUSIVE_LIVE_LEASE"),
    legacy_capacity: truth(r3.legacyFailClosedCode) ?
      fixed("PARTIAL", "LEGACY_NATIVE_EXECUTION_INVENTORY_NOT_COMPLETE") :
      fixed("BLOCKED", "LEGACY_CAPACITY_CONTRACT_UNCONFIRMED"),
    native_recovery: truth(r3.disposableWorkerdTestsPassed)
      ? fixed("PARTIAL", "DO_LOCAL_NOT_REAL_REMOTE_RACE_RECEIPT")
      : fixed("NOT_TESTED", "NATIVE_RECOVERY_NOT_VALIDATED"),
    isolate_memory: fixed("BLOCKED", "REAL_ISOLATE_OOM_CAUSE_AND_HEADROOM_UNVERIFIED"),
    linux_process_isolation: fixed("BLOCKED", "SETSID_CGROUP_SCOPE_NOT_PROVEN"),
    all_service_hard_cost_cutoff:
      disabledLegacyLimit || gatewayRateUnknown || directAI ||
      !truth(control.allSixServiceCutoffsAttested) ||
      !truth(control.sdkInferenceInterceptorVerified)
        ? fixed("BLOCKED", "PROVIDER_INFRA_HARD_STOP_NOT_ATTESTED")
        : fixed("PARTIAL", "SNAPSHOT_CLAIMS_ARE_NOT_ENFORCEMENT"),
    artifact_acl_android: fixed("BLOCKED", "PRINCIPAL_ACL_AND_AUTHENTICATED_ANDROID_NOT_PROVEN"),
    independent_observer: tracing.principal === false || tracing.mcp === false ||
      !truth(control.independentSignedCollectorVerified)
        ? fixed("BLOCKED", "SIGNED_RUNTIME_OBSERVER_NOT_PROVEN")
        : fixed("PARTIAL", "READ_ONLY_SNAPSHOT_NO_RUNTIME_PROVENANCE"),
    rollback_complete: fixed("NOT_TESTED", "WORKER_DO_CONTAINER_RESTORE_NOT_DRILLED")
  };
  for (const id of GATE_IDS) {
    if (!gates[id] || !STATUS.has(gates[id].status)) {
      throw new Error("PREFLIGHT_INTERNAL_GATE_MISSING");
    }
  }
  const blockers = GATE_IDS.filter(id => gates[id].status !== "VERIFIED")
    .map(id => ({gate: id, ...gates[id]}));
  // Read-only source claims cannot cross the trust boundary into GO.
  // This result is a status report, not a dispatch/deployment API.
  return {
    schema: "f0-c10.preflight-decision.v1",
    decision: "STOP",
    scope: "READ_ONLY_NO_EFFECTS",
    candidateSha: SHA.test(source.candidateSha) ? source.candidateSha : null,
    observedDate: typeof input.observedDate === "string" ? input.observedDate : null,
    offlineSourceCI: validatedCandidate ? "PASS" : "UNKNOWN",
    gates, blockers,
    sourceMayBeDeployed: false,
    liveLoadAuthorizedByThisArtifact: false,
    nextAction: "ESTABLISH_PROVIDER_AND_INFRA_HARD_CUTOFF_WITH_EXCLUSIVE_DISPOSABLE_LEASE",
    warnings: [
      "AI_GATEWAY_LEGACY_LIMIT_DISABLED_OR_UNVERIFIED",
      "UNSIGNED_READ_ONLY_EVIDENCE_CANNOT_AUTHORIZE_PAID_DISPATCH",
      "CLOUD_WORKER_VERSION_ID_IS_NOT_GIT_COMMIT_SHA",
      "OFFLINE_WORKER_OR_WORKERD_TEST_IS_NOT_TEN_LIVE_AGENTS"
    ]
  };
}

function cli(argv) {
  if (argv.length !== 2 || argv[0] !== "--snapshot" || !argv[1]) {
    throw new Error("USAGE: node operational-preflight.mjs --snapshot <read-only-snapshot.json>");
  }
  const path = resolve(argv[1]);
  const source = JSON.parse(readFileSync(path, "utf8"));
  const result = evaluateReadonlyPreflight(source);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // A STOP has exit=2 so pipelines cannot accidentally deploy.
  process.exitCode = result.decision === "STOP" ? 2 : 3;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (e) {
    process.stderr.write("PREFLIGHT_FAIL_CLOSED: " + (e instanceof Error ? e.message : "UNKNOWN") + "\n");
    process.exitCode = 2;
  }
}

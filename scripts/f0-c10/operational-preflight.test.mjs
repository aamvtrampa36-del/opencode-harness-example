import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateReadonlyPreflight, GATE_IDS, SCHEMA } from "./operational-preflight.mjs";

const evidenceUrl = new URL("../../docs/f0-c10/preflight-01-observed-20261123.json", import.meta.url);
const scriptPath = fileURLToPath(new URL("./operational-preflight.mjs", import.meta.url));
const snapshot = () => structuredClone(JSON.parse(readFileSync(evidenceUrl, "utf8")));

test("real read-only snapshot produces STOP and exact R3-T11 offline CI PASS", () => {
  const out = evaluateReadonlyPreflight(snapshot());
  assert.equal(out.decision, "STOP");
  assert.equal(out.scope, "READ_ONLY_NO_EFFECTS");
  assert.equal(out.offlineSourceCI, "PASS");
  assert.equal(out.candidateSha, "304145eca71a5ffcf6d9c235e67a8065718c6ae5");
  assert.deepEqual(Object.keys(out.gates), GATE_IDS);
  assert.equal(out.gates.all_service_hard_cost_cutoff.status, "BLOCKED");
  assert.equal(out.gates.independent_observer.status, "BLOCKED");
  assert.equal(out.gates.deployment_provenance.status, "BLOCKED");
  assert.equal(out.gates.legacy_capacity.status, "PARTIAL");
  assert.equal(out.liveLoadAuthorizedByThisArtifact, false);
  assert.ok(out.blockers.length >= 10);
});

test("replacing every reported control with true cannot forge a runtime GO", () => {
  const forged = snapshot();
  for (const k of Object.keys(forged.controls)) forged.controls[k] = true;
  forged.cloudflare.aiGateway.legacySpendingLimitEnabled = true;
  forged.cloudflare.aiGateway.rateLimit = 100;
  forged.cloudflare.modelRoutes.workersAIBindingConfigured = false;
  forged.cloudflare.tracing.principal = true;
  forged.cloudflare.tracing.mcp = true;
  forged.r3.fullProductionOomRootCauseVerified = true;
  const out = evaluateReadonlyPreflight(forged);
  assert.equal(out.decision, "STOP");
  assert.equal(out.sourceMayBeDeployed, false);
  assert.equal(out.liveLoadAuthorizedByThisArtifact, false);
  assert.equal(out.gates.deployment_provenance.status, "PARTIAL");
  assert.equal(out.gates.all_service_hard_cost_cutoff.status, "PARTIAL");
  assert.equal(out.gates.independent_observer.status, "PARTIAL");
});

test("a synthetic success from another HEAD cannot pass exact source CI", () => {
  const wrong = snapshot();
  wrong.source.ci[1].headSha = "f".repeat(40);
  const out = evaluateReadonlyPreflight(wrong);
  assert.equal(out.offlineSourceCI, "UNKNOWN");
  assert.equal(out.gates.source_offline_ci.status, "BLOCKED");
  assert.equal(out.decision, "STOP");
});

test("missing CI or absent deployment is a STOP, not a best-effort GO", () => {
  const lost = snapshot();
  lost.source.ci = [];
  lost.cloudflare.deployments = {};
  const out = evaluateReadonlyPreflight(lost);
  assert.equal(out.offlineSourceCI, "UNKNOWN");
  assert.equal(out.gates.deployment_provenance.status, "BLOCKED");
  assert.ok(out.blockers.some(b => b.gate === "deployment_provenance"));
});

test("refuses unknown, untrusted and invalid evidence provenance", () => {
  for (const bad of [
    {},
    {schema:SCHEMA},
    {...snapshot(),evidenceClass:"manual_go"},
    {...snapshot(),schema:"f0-c10.preflight-operational-go.v1"}
  ]) assert.throws(()=>evaluateReadonlyPreflight(bad),/PREFLIGHT_SNAPSHOT_SCHEMA_OR_PROVENANCE_INVALID/);
});

test("CLI returns exit 2 for STOP, safe JSON, and never starts any remote task", () => {
  const run=spawnSync(process.execPath,[scriptPath,"--snapshot",fileURLToPath(evidenceUrl)],{
    encoding:"utf8",timeout:5000
  });
  assert.equal(run.status,2);
  const value=JSON.parse(run.stdout);
  assert.equal(value.decision,"STOP");
  assert.equal(value.liveLoadAuthorizedByThisArtifact,false);
  assert.equal(value.sourceMayBeDeployed,false);
  assert.equal(run.stderr,"");
  assert.doesNotMatch(run.stdout,/payment_method|last4|OPENROUTER_API_KEY|CLOUDFLARE_API_TOKEN/);
});

test("CLI fails closed for unreadable or unsupported snapshots", () => {
  const run=spawnSync(process.execPath,[scriptPath,"--snapshot","/no-such-file.json"],{
    encoding:"utf8",timeout:5000
  });
  assert.equal(run.status,2);
  assert.match(run.stderr,/PREFLIGHT_FAIL_CLOSED/);
  assert.equal(run.stdout,"");
});

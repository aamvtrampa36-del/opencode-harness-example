#!/usr/bin/env bash
# Explicit principal upload-only executor. No promotion, dispatch, or pilot grant.
set -euo pipefail
mode="$1"; source_sha="$2"; tree="$3"; expiry="$4"; pin="${5:-}"; normal_cfg_pin="${6:-}"; recovery_cfg_pin="${7:-}"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ && "$tree" =~ ^[0-9a-f]{40}$ && "$expiry" =~ ^[0-9]+$ ]]
test "${WORKERS_CI_COMMIT_SHA:?}" = "$source_sha"
test "$(git rev-parse HEAD)" = "$source_sha"
test "$(git rev-parse HEAD^{tree})" = "$tree"
test "$(date +%s)" -lt "$expiry"
export GITHUB_SHA="$source_sha" SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" WRANGLER_SEND_METRICS=false
tmp=/tmp/p26-principal
if [ "$mode" = build ]; then
  timeout -k 5s 8m bash scripts/f0-c10/r4-release-build.sh principal "$source_sha" "$tmp"
  exit 0
fi
test "$mode" = upload
[[ "$pin" =~ ^[0-9a-f]{64}$ && "$normal_cfg_pin" =~ ^[0-9a-f]{64}$ && "$recovery_cfg_pin" =~ ^[0-9a-f]{64}$ ]]
export P26_NORMAL_CONFIG_PIN="$normal_cfg_pin" P26_RECOVERY_CONFIG_PIN="$recovery_cfg_pin"
git diff --exit-code
git diff --cached --exit-code
node scripts/f0-c10/r4-release-guard.mjs inventory principal "$source_sha" "$tmp" > "$tmp/receipt"
printf '%s  %s\n' "$pin" "$tmp/receipt" | sha256sum -c -
node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const d="dist/opencode_g1_staging/",p=d+"wrangler.json";
const c=JSON.parse(readFileSync(p,"utf8"));
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const normalize=x=>({...x,configPath:"/home/runner/work/opencode-harness-example/opencode-harness-example/wrangler.g1.jsonc",userConfigPath:"/home/runner/work/opencode-harness-example/opencode-harness-example/wrangler.g1.jsonc"});
assert.equal(c.name,"opencode-g1-staging");
assert.equal(hash(normalize(c)),process.env.P26_NORMAL_CONFIG_PIN);
assert.equal(c.containers.length,1);
assert.equal(c.containers[0].class_name,"DevContainer");
assert.equal(c.containers[0].scheduling_policy,"durable_object");
assert.deepEqual(c.containers[0].images,{pilot:{image:"registry.cloudflare.com/83ac825cf01b6ef0c2244007406d83ab/opencode-g1-staging-m09-linux@sha256:049156e4dd236c8b00f4c3319ffbe4d16bde8d3da3904e4376e11aca6a48c9a8"}});
assert(!Object.keys(c.vars).some(k=>k.startsWith("OPENCODE_PILOT_")||k==="OPENCODE_NORMAL_AUTHORIZATION"));
c.vars.OPENCODE_M08_RECOVERY_MODE="true";
c.assets.run_worker_first=true;
assert.equal(hash(normalize(c)),process.env.P26_RECOVERY_CONFIG_PIN);
writeFileSync(d+".m08-recovery-principal.json",JSON.stringify(c),{flag:"wx",mode:0o600});
console.log("P26_PRINCIPAL_EXACT_CONFIGS_PASS");
JS
test "$(date +%s)" -lt "$expiry"
timeout -k 5s 2m node_modules/.bin/wrangler versions upload --config dist/opencode_g1_staging/.m08-recovery-principal.json --no-bundle --tag p26-certified-principal-recovery
test "$(date +%s)" -lt "$expiry"
timeout -k 5s 2m node_modules/.bin/wrangler versions upload --config dist/opencode_g1_staging/wrangler.json --no-bundle --tag p26-certified-principal-normal

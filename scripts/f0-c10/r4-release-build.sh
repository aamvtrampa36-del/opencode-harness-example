#!/usr/bin/env bash
# Called by public CI or the exact-commit Workers Builds executor. No upload here.
set -euo pipefail
role="$1"
source_sha="$2"
export R4_TMP="$3" GITHUB_SHA="$source_sha" WRANGLER_SEND_METRICS=false CI=true
test "$role" = principal || test "$role" = mcp
test "$(git rev-parse HEAD)" = "$source_sha"
if [ -n "$(printenv WORKERS_CI_COMMIT_SHA || true)" ]; then
  test "$(printenv WORKERS_CI_COMMIT_SHA)" = "$source_sha"
fi
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CF_API_TOKEN CF_API_KEY CF_EMAIL
test "$(bun --version)" = 1.4.4
bun install --frozen-lockfile
test "$(node -p 'require("./node_modules/wrangler/package.json").version')" = 4.158.0
mkdir "$R4_TMP"
if [ "$role" = principal ]; then
  bun run build
  CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.g1.jsonc bun run build
  node_modules/.bin/wrangler deploy --dry-run --config dist/opencode_g1_staging/wrangler.json --outdir "$R4_TMP/principal"
  # Exercise the actual future upload CLI and colon-containing JSON var, offline.
  node_modules/.bin/wrangler versions upload --dry-run --no-bundle --config dist/opencode_g1_staging/wrangler.json --outdir "$R4_TMP/principal-upload-check" --var 'OPENCODE_PILOT_HYBRID_REQUEST_ID:0000000000000000' --var 'OPENCODE_PILOT_AUTHORIZATION:{"schema":"offline-test-only"}'
  cmp "$R4_TMP/principal/index.js" "$R4_TMP/principal-upload-check/index.js"
  node_modules/.bin/wrangler versions upload --dry-run --no-bundle --config dist/opencode_g1_staging/wrangler.json --outdir "$R4_TMP/principal-maintenance-check" --var 'OPENCODE_PILOT_HYBRID_REQUEST_ID:0000000000000000' --var 'OPENCODE_R4_RECONCILIATION:{"schema":"offline-test-only"}'
  cmp "$R4_TMP/principal/index.js" "$R4_TMP/principal-maintenance-check/index.js"
else
  node_modules/.bin/wrangler deploy --dry-run --config wrangler.mcp-staging.jsonc --outdir "$R4_TMP/mcp"
  node --input-type=commonjs -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync("wrangler.mcp-staging.jsonc"));if(c.name!=="opencode-staging-control-mcp")throw Error("worker");c.main="mcp/worker.js";c.no_bundle=true;fs.writeFileSync(process.env.R4_TMP+"/mcp-check.json",JSON.stringify(c))'
  node_modules/.bin/wrangler deploy --dry-run --no-bundle --config "$R4_TMP/mcp-check.json" --outdir "$R4_TMP/mcp-checked"
  cmp "$R4_TMP/mcp/worker.js" "$R4_TMP/mcp-checked/worker.js"
  node_modules/.bin/wrangler versions upload --dry-run --no-bundle --config "$R4_TMP/mcp-check.json" --outdir "$R4_TMP/mcp-upload-check"
  cmp "$R4_TMP/mcp/worker.js" "$R4_TMP/mcp-upload-check/worker.js"
fi
node scripts/f0-c10/r4-release-guard.mjs inventory "$role" "$source_sha" "$R4_TMP"
test "$(git rev-parse HEAD)" = "$source_sha"
git diff --exit-code
git diff --cached --exit-code

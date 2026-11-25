#!/bin/bash
# Standard reviewed P26/M09 runner. Upload-only, exact C1R MCP bytes;
## A successor can reuse these only when its exact CI confirms identical hashes.
set -eu
test "$#" -eq 4
mode=$1; sha=$2; tree=$3; expiry=$4
[[ "$sha" =~ ^[a-f0-9]{40}$ && "$tree" =~ ^[a-f0-9]{40}$ && "$expiry" =~ ^[0-9]+$ ]]
test "$(git rev-parse HEAD)" = "$sha"
test "$(git rev-parse HEAD^{tree})" = "$tree"
test "${WORKERS_CI_COMMIT_SHA:-}" = "$sha"
test "$(date +%s)" -lt "$expiry"
git diff --exit-code
git diff --cached --exit-code
case "$mode" in
build) timeout -k 5s 6m bash -euc 'unset CLOUDFLARE_API_TOKEN CF_API_TOKEN CLOUDFLARE_API_KEY CF_API_KEY CLOUDFLARE_EMAIL CF_EMAIL; export WRANGLER_SEND_METRICS=false; test "$(bun --version)" = 1.4.4; bun install --frozen-lockfile; test "$(node -p '\''require("./node_modules/wrangler/package.json").version'\'')" = 4.158.0; a=/tmp/metralla-m08-repro/mcp; r=/tmp/m08-recovery-repro/mcp; node_modules/.bin/wrangler deploy --dry-run --config wrangler.mcp-staging.jsonc --outdir "$a"; p=$(node -p '\''require("path").relative(process.argv[1],process.cwd())'\'' "$a"); sed -i "3s|$p/|../../../home/runner/work/opencode-harness-example/opencode-harness-example/|g" "$a/worker.js.map"; mkdir -p "$r"; cp "$a/worker.js" "$r/"; sed "4s|$a|$r|" "$a/worker.js.map" > "$r/worker.js.map"; for k in a r; do node -e '\''let c=JSON.parse(require("fs").readFileSync(0));if(process.argv[1]==="r")c.vars.OPENCODE_M08_RECOVERY_MODE="true";c.main=process.argv[2]+"/worker.js";c.no_bundle=true;process.stdout.write(JSON.stringify(c))'\'' "$k" "${!k}" < wrangler.mcp-staging.jsonc > "/tmp/p26-$k.json"; done';;
upload) printf '%s\n' 'b657ab7065a2935a4b897b05eff3af14520a1306a50c21a75c8e238e18634644  /tmp/metralla-m08-repro/mcp/worker.js' 'bd2568c214d638b122fb7c76a94bba49584be70ee2bb6d9b2b55e6d0a73fc104  /tmp/metralla-m08-repro/mcp/worker.js.map' 'b657ab7065a2935a4b897b05eff3af14520a1306a50c21a75c8e238e18634644  /tmp/m08-recovery-repro/mcp/worker.js' 'f73e09560446013b26979bacc99998cc3725b014618e24ad5e68e229ade7e8d7  /tmp/m08-recovery-repro/mcp/worker.js.map' '7a2e0998243ecf5cc2cf27c1ff68a994f2fc53a2abe7d8aef5f464c73aeee547  /tmp/p26-a.json' '2a116feeb5aca2c431ee76313951cea99e726c14b57bb912d688c38fe175b062  /tmp/p26-r.json' | sha256sum -c -; export WRANGLER_SEND_METRICS=false; timeout -k 5s 2m bash -ec 'node_modules/.bin/wrangler versions upload --config /tmp/p26-r.json --no-bundle --tag p26-certified-mcp-recovery; node_modules/.bin/wrangler versions upload --config /tmp/p26-a.json --no-bundle --tag p26-certified-mcp-normal';;
*) exit 64;;
esac

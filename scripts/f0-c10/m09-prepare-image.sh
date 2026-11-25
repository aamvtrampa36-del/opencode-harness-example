#!/usr/bin/env bash
# Image-only operation: never deploy a Worker or start a Cloudflare VM.
set -euo pipefail
mode="$1"; sha="$2"; tree="$3"; expiry="$4"
[[ "$sha" =~ ^[a-f0-9]{40}$ && "$tree" =~ ^[a-f0-9]{40}$ && "$expiry" =~ ^[0-9]+$ ]]
test "${WORKERS_CI_COMMIT_SHA:?}" = "$sha"
test "$(git rev-parse HEAD)" = "$sha"
test "$(git rev-parse HEAD^{tree})" = "$tree"
test "$(date +%s)" -lt "$expiry"
git diff --exit-code
git diff --cached --exit-code
export WRANGLER_SEND_METRICS=false
tag="opencode-g1-staging-m09-linux:p26-20261125-v2"
tmp=/tmp/p26-image
if [ "$mode" = build ]; then
  command -v docker
  mkdir -p "$tmp"
  timeout -k 5s 3m bun install --frozen-lockfile
  test "$(node -p 'require("./node_modules/wrangler/package.json").version')" = 4.158.0
  # Reuse the pinned build-runner Bun; no apt/npm download inside the image.
  test "$(bun --version)" = 1.4.4
  install -m 0755 "$(readlink -f "$(command -v bun)")" "$tmp/bun"
  sha256sum "$tmp/bun"
  cp scripts/f0-c10/m09-linux.Dockerfile "$tmp/Dockerfile"
  timeout -k 5s 6m docker build --network none --platform linux/amd64 -t "$tag" "$tmp"
  docker image inspect --format '{{.Id}}' "$tag" > "$tmp/id"
  exit 0
fi
test "$mode" = push
test "$(docker image inspect --format '{{.Id}}' "$tag")" = "$(cat "$tmp/id")"
timeout -k 5s 45s docker run --rm --network none "$tag" sh -ec 'test "$(node -v)" = v24.20.0; test "$(bun -v)" = 1.4.4; grep -qx VERSION_CODENAME=trixie /etc/os-release; command -v bash; command -v git; command -v timeout; echo P26_IMAGE_TOOLS_PASS'
test "$(date +%s)" -lt "$expiry"
timeout -k 5s 3m node_modules/.bin/wrangler containers push "$tag" --config wrangler.g1.jsonc

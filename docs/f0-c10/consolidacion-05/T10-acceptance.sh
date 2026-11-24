#!/usr/bin/env bash
# Offline structural check only; no fetch, network, checkout, merge, or writes.
set -u
base=f3fc8813b1bad28f7f6c74c2b56656b8d9150425
rpc=11161dd6f2c4b5237a2da59d7275ff693e0afdbe
historical=0e3b4e040304d4450f1f142e261bc5e76168e619
source=74632f75db010223cc90d99ba4a801ce0e6414e5
candidate=${1:-}
if [[ $# != 1 || ! $candidate =~ ^[0-9a-f]{40}$ ]]; then
  echo 'usage: bash T10-acceptance.sh FULL_CANDIDATE_SHA' >&2; exit 2
fi
if [[ $(git rev-parse --is-shallow-repository 2>/dev/null) != false ]]; then
  echo 'BLOCKED: full local Git history required' >&2; exit 2
fi
for ref in "$candidate" "$base" "$rpc" "$historical" "$source"; do
  if ! git cat-file -e "$ref^{commit}" 2>/dev/null; then
    echo "BLOCKED: missing commit $ref" >&2; exit 2
  fi
done
failed=0
for ref in "$base" "$rpc" "$historical" "$source"; do
  git merge-base --is-ancestor "$ref" "$candidate"
  rc=$?
  case $rc in
    0) echo "ANCESTOR $ref";;
    1) echo "NOT_ANCESTOR $ref"; failed=1;;
    *) echo "BLOCKED: git ancestry error $rc" >&2; exit 2;;
  esac
done
for pair in 'scripts/test-preview.mjs:ea7e5269e1dca8a6a98f9c60db81c65e04f2a0c7' 'docs/f0-c10/preflight-03-usd2-observed-20261123.json:8151c07a61f6971816230bebf9381ead5413bd78'; do
  path=${pair%:*}; expected=${pair##*:}
  actual=$(git rev-parse --verify "$candidate:$path" 2>/dev/null) || actual=missing
  if [[ $actual != "$expected" ]]; then
    echo "REVIEW_REQUIRED $path expected=$expected actual=$actual"; failed=1
  else
    echo "EXACT_BLOB $path $actual"
  fi
done
echo 'STOP_LIVE providerDispatchAuthorized=false NO_COMPLETE_PASS'
echo 'Ancestry and blob checks never prove functional equivalence, CI or deployment provenance.'
if [[ $failed != 0 ]]; then exit 1; fi
exit 0

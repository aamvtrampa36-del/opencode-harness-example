#!/usr/bin/env bash
set -euo pipefail
source_sha=42574cb3f5ee0cbfab2ce54176145c089edc41df
test "$(git rev-parse HEAD)" = "$source_sha"
test "$(printenv WORKERS_CI_COMMIT_SHA)" = "$source_sha"
export GITHUB_SHA="$source_sha" R4_ROLE="$1" WRANGLER_SEND_METRICS=false CI=true
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CF_API_TOKEN CF_API_KEY CF_EMAIL
test "$R4_ROLE" = principal || test "$R4_ROLE" = mcp
node --version
bun --version
test "$(bun --version)" = 1.4.4
bun install --frozen-lockfile
test "$(node -p 'require("./node_modules/wrangler/package.json").version')" = 4.158.0
export R4_TMP="$(mktemp -d)"
trap 'rm -rf -- "$R4_TMP"' EXIT
if [ "$R4_ROLE" = principal ]; then
  bun run build
  CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.g1.jsonc bun run build
  node_modules/.bin/wrangler deploy --dry-run --config dist/opencode_g1_staging/wrangler.json --outdir "$R4_TMP/principal"
else
  node_modules/.bin/wrangler deploy --dry-run --config wrangler.mcp-staging.jsonc --outdir "$R4_TMP/mcp"
fi
node --input-type=commonjs <<'JS'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function sort(x){if(Array.isArray(x))return x.map(sort);if(x!==null&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])]));return x}
const canon=x=>JSON.stringify(sort(x));
const role=process.env.R4_ROLE,tmp=process.env.R4_TMP,repo=process.cwd();
assert.equal(process.env.GITHUB_SHA,'42574cb3f5ee0cbfab2ce54176145c089edc41df');
function inventory(root,prefix,normalize){const m={};function walk(d){for(const f of fs.readdirSync(d).sort()){const p=path.join(d,f),s=fs.lstatSync(p);if(s.isDirectory())walk(p);else{assert(s.isFile());const n=prefix+path.relative(root,p);m[n]=hash(normalize(n,fs.readFileSync(p)))}}}walk(root);return m}
function verify(root,prefix,n,pin,normal){const m=inventory(root,prefix,normal),h=hash(canon(m));console.log('R4_CONTENT '+JSON.stringify({prefix,files:Object.keys(m).length,sha256:h,expected:pin}));if(Object.keys(m).length!==n||h!==pin){console.log('R4_DIAGNOSTIC_INVENTORY '+canon(m));throw Error('R4_CONTENT_MISMATCH '+prefix)}}
function norm(n,b){if(n===role+'/README.md'){const name=role==='principal'?'opencode-g1-staging':'opencode-staging-control-mcp',prefix='This folder contains the built output assets for the worker "'+name+'" generated at ',s=b.toString();assert(s.startsWith(prefix)&&s.endsWith('.'));const t=s.slice(prefix.length,-1);assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t)&&new Date(t).toISOString()===t);return Buffer.from(prefix+'<BUILD_TIMESTAMP>.')}if(n==='mcp/worker.js.map'){const m=JSON.parse(b);assert.deepEqual(Object.keys(m).sort(),['mappings','names','sourceRoot','sources','sourcesContent','version']);assert.equal(m.version,3);assert.equal(m.sourceRoot,tmp+'/mcp');m.sources=m.sources.map(s=>{assert.equal(typeof s,'string');assert(!path.isAbsolute(s));const abs=path.resolve(m.sourceRoot,s),rel=path.relative(repo,abs);assert(rel&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../'));return '<REPO>/'+rel});m.sourceRoot='<PILOT_TEMP>/mcp';console.log('R4_MAP_FIELD_DIGESTS '+canon(Object.fromEntries(Object.entries(m).map(([k,v])=>[k,hash(canon(v))]))));return Buffer.from(canon(m))}if(n==='dist/opencode_g1_staging/wrangler.json'){const c=JSON.parse(b);for(const k of ['configPath','userConfigPath']){assert.equal(c[k],repo+'/wrangler.g1.jsonc');c[k]='<REPO>/wrangler.g1.jsonc'}return Buffer.from(canon(c))}return b}
if(role==='principal'){
verify('dist/client','dist/client/',308,'dee45dc81b82dd8845798a24d482b25aa6013ed81f9d0bf49c5784cffebb4946',norm);
verify('dist/opencode_g1_staging','dist/opencode_g1_staging/',230,'80682ca8aea2f4da2744ef3f2a4386d4796a7d842c5036cea6d22e700a4a3c64',norm);
verify(tmp+'/principal','principal/',229,'87debd5d60ee8b02482100e881e76fa3de1e066a968f01c9e0527bb1e0efe79c',norm)
}else if(role==='mcp'){
assert.equal(hash(fs.readFileSync('wrangler.mcp-staging.jsonc')),'31907fc438748600c198eaef9d85d204838f63e47a0134bc0dfe8f1559878e54');
verify(tmp+'/mcp','mcp/',3,'e177d67467685eb9be04fcfee763a44d3858e2fab0ec84506135e24a8e705c49',norm);
const cfg=JSON.parse(fs.readFileSync('wrangler.mcp-staging.jsonc'));assert.equal(cfg.name,'opencode-staging-control-mcp');cfg.main='mcp/worker.js';cfg.no_bundle=true;fs.writeFileSync(tmp+'/mcp-prebuilt.json',JSON.stringify(cfg))
}else throw Error('unknown role');
console.log('R4_CONTENT_PASS '+role);
JS
if [ "$R4_ROLE" = mcp ]; then
  node_modules/.bin/wrangler deploy --dry-run --no-bundle --config "$R4_TMP/mcp-prebuilt.json" --outdir "$R4_TMP/mcp-checked"
  test "$(sha256sum "$R4_TMP/mcp-checked/worker.js" | cut -d' ' -f1)" = 047fb2c8bb4ec8e5f2aad66a0a66f52318c62b13201ecf77f2267867851350e8
  printf '%s\n' R4_MCP_PREBUILT_EXECUTABLE_MATCH
fi
test "$(git rev-parse HEAD)" = "$source_sha"
git diff --exit-code
git diff --cached --exit-code

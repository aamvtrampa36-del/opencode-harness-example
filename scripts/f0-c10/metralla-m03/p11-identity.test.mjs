import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExecutionIdentity, assertImagePolicy, assertSourceScope } from '../../../src/metralla-m03-execution-identity.ts';
const project='supervised-0123456789abcdef';
const source={project,repository:'aamvtrampa36-del/opencode-harness-example',commit:'a'.repeat(40),tree:'b'.repeat(40)};
const receipt={...source,certification:'raw-git-tree-v1',sha256:'c'.repeat(64),files:2};
const lease={project,requestId:'0123456789abcdef',generation:2,token:'fixture-only',expiresAt:2000};
const digest='sha256:'+'d'.repeat(64);
const reference='registry.cloudflare.com/account/pilot@'+digest;
const boot={project,objectId:'e'.repeat(64),bootLabel:'12345678-1234-1234-1234-123456789abc',bootId:'23456789-1234-1234-1234-123456789abc',image:{kind:'pinned',reference,digest}};
const observation={project,objectId:boot.objectId,bootLabel:boot.bootLabel,bootId:boot.bootId,running:true,imageReference:reference};
const scope={source,lease,boot};
let effects=0;
function run({s=scope,r=receipt,o=observation,l=lease,c=[reference],now=1000}={}) {
  assertExecutionIdentity(s,r,o,l,c,now);
  effects++;
}
function denied(options,code){const before=effects;assert.throws(()=>run(options),{message:code});assert.equal(effects,before);}
test('valid exact certified source and boot',()=>{const before=effects;run();assert.equal(effects,before+1)});
test('normal reference only: no pilot ID or pinned digest required',()=>{const image={kind:'reference',reference:'cloudflare/debian-trixie'};run({s:{...scope,boot:{...boot,image}},o:{...observation,imageReference:image.reference},c:[image.reference]});});
test('digest mismatch, mutable tag and bare digest cannot satisfy pin',()=>{for(const ref of ['cloudflare/debian-trixie',digest,'registry.cloudflare.com/account/pilot@sha256:'+'0'.repeat(64)]){assert.throws(()=>assertImagePolicy({kind:'pinned',reference:ref,digest},[ref]),/M03_IMAGE_DIGEST_MISMATCH/)}denied({o:{...observation,imageReference:'registry.cloudflare.com/account/other@'+digest}},'M03_IMAGE_REFERENCE_MISMATCH');});
test('unprepared image cannot be started',()=>denied({c:[]},'M03_IMAGE_NOT_CONFIGURED'));
test('lost boot, replacement VM, foreign project or DO reject before effect',()=>{for(const patch of [{running:false},{bootLabel:''},{bootId:'00000000-0000-0000-0000-000000000000'},{objectId:'f'.repeat(64)},{project:'other'}])denied({o:{...observation,...patch}},'M03_VM_IDENTITY_MISMATCH');});
test('source scope and certification are checked',()=>{for(const patch of [{project:'other'},{repository:'other/repo'},{commit:'0'.repeat(40)},{tree:'0'.repeat(40)}])denied({r:{...receipt,...patch}},'M03_SOURCE_SCOPE_MISMATCH');for(const patch of [{certification:undefined},{sha256:'bad'},{files:0}])denied({r:{...receipt,...patch}},'M03_SOURCE_UNCERTIFIED');});
test('lease expiry, stale generation, wrong token, absent durable lease and scope mismatch',()=>{denied({now:2000},'M03_LEASE_FENCED');for(const patch of [{generation:1},{token:'different'},{project:'other'},{expiresAt:3000}])denied({l:{...lease,...patch}},'M03_LEASE_FENCED');denied({l:null},'M03_LEASE_FENCED');});
test('pre-download source contract rejects foreign commit or tree',()=>{assert.doesNotThrow(()=>assertSourceScope(source,source));assert.throws(()=>assertSourceScope(source,{...source,tree:'f'.repeat(40)}),/M03_SOURCE_SCOPE_MISMATCH/)});
test('ordinary project scope needs no supervised project naming',()=>{const p='repo-example';const image={kind:'reference',reference:'cloudflare/debian-trixie'};const s={source:{...source,project:p},lease:{...lease,project:p},boot:{...boot,project:p,image}};run({s,r:{...receipt,project:p},l:s.lease,o:{...observation,project:p,imageReference:image.reference},c:[image.reference]});});
test('non-string digest and commit are not coerced',()=>{denied({r:{...receipt,sha256:[receipt.sha256]}},'M03_SOURCE_UNCERTIFIED');assert.throws(()=>assertSourceScope({...source,commit:[source.commit]},source),/M03_SOURCE_SCOPE_MISMATCH/);});

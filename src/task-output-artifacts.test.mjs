import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  validateCaptureRequest, captureInspectedArtifact, artifactView, artifactKey,
  artifactIsOwnedBy, verifiedArtifactDownload, artifactDownloadPath,
  TASK_ARTIFACT_MAX_BYTES, TASK_ARTIFACT_TTL_MS
} from './task-output-artifacts.ts';

const task = id => ({ id, project: `supervised-${id}`, session: 'sesA_task_' + id, repository: 'aamvtrampa36-del/opencode-harness-example' });
const text = (v, path='dist/report.txt') => ({ path, byteSize: Buffer.byteLength(v), base64: Buffer.from(v).toString('base64'), sha256: createHash('sha256').update(v).digest('hex') });
async function capture(id, contents='hello', overrides={}) {
  const owner = task(id);
  const req = overrides.request ?? { path:'dist/report.txt',name:'report.txt',mime:'text/plain' };
  return captureInspectedArtifact({ requestId:id,ownerProject:owner.project,ownerSession:owner.session,
    repository:owner.repository, request:req, inspected:overrides.inspected ?? text(contents,req.path),now:1000 });
}
const T1='0000000000000001',T2='0000000000000002';

test('auth-bound GET returns actual UTF-8 bytes, sha, headers, not a path claim', async()=>{
  const a=await capture(T1,'olá 🌎');
  const r=await verifiedArtifactDownload(a,1001);
  assert.equal(r.status,200); assert.equal(r.headers.get('content-length'),String(Buffer.byteLength('olá 🌎')));
  assert.match(r.headers.get('content-disposition'),/attachment/);
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  const bytes=new Uint8Array(await r.arrayBuffer());
  assert.equal(Buffer.from(bytes).toString('utf8'),'olá 🌎');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);
  assert.equal(artifactView(a).delivery.path,artifactDownloadPath(T1,a.artifactId));
  assert.equal(artifactView(a).delivery.expiresAt,1000+TASK_ARTIFACT_TTL_MS);
});

test('immutable requestId + content addresses independent artifact IDs',async()=>{
  const a=await capture(T1,'alpha'),b=await capture(T2,'alpha'),c=await capture(T1,'beta');
  assert.notEqual(a.artifactId,b.artifactId); assert.notEqual(a.artifactId,c.artifactId);
  assert.notEqual(artifactKey(T1,a.artifactId),artifactKey(T2,b.artifactId));
  assert.ok(artifactIsOwnedBy(a,{...task(T1),id:T1},1001));
  assert.ok(!artifactIsOwnedBy(a,{...task(T2),id:T2},1001));
  assert.ok(!artifactIsOwnedBy(a,{...task(T1),project:'other'},1001));
  assert.ok(!artifactIsOwnedBy(a,{...task(T1),session:'sesOther'},1001));
});

test('same request is idempotent for identical bytes',async()=>{
  const a=await capture(T1,'same'),b=await capture(T1,'same');
  assert.equal(a.artifactId,b.artifactId); assert.equal(a.sha256,b.sha256);
});

test('Unicode filename normalized without traversal and safely encoded',async()=>{
  const request={path:'dist/relatorio.md',name:'Relatório – São Paulo 🇧🇷.md',mime:'text/markdown'};
  const a=await capture(T1,'# bom', {request}); const r=await verifiedArtifactDownload(a,1001);
  assert.equal(r.status,200); assert.match(decodeURIComponent(r.headers.get('content-disposition')),/Relatório – São Paulo 🇧🇷\.md/);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString('utf8'),'# bom');
});

test('valid JSON and invalid JSON classification',async()=>{
  const req={path:'dist/data.json',name:'data.json',mime:'application/json'};
  const ok=await capture(T1,'{"ok":true}',{request:req});assert.equal((await verifiedArtifactDownload(ok,1001)).status,200);
  await assert.rejects(capture(T1,'{"broken":', {request:req}),/INVALID_JSON_ARTIFACT/);
});

test('HTML/SVG active, MIME mismatch and file:/internal URLs never become captures',async()=>{
  for (const request of [
    {path:'dist/a.html',name:'a.html',mime:'text/html'},
    {path:'dist/a.svg',name:'a.svg',mime:'image/svg+xml'},
    {path:'file:///bundle/a.txt',name:'a.txt',mime:'text/plain'},
    {path:'/bundle/a.txt',name:'a.txt',mime:'text/plain'},
    {path:'../private.txt',name:'a.txt',mime:'text/plain'},
    {path:'dist/../../a.txt',name:'a.txt',mime:'text/plain'},
    {path:'dist/a.txt',name:'a.txt',mime:'text/html'},
    {path:'dist/a.txt',name:'../a.txt',mime:'text/plain'},
    {path:'dist/a.txt',name:'a.svg',mime:'image/svg+xml'},
    {path:'dist/a.txt',name:'a\u202Etxt',mime:'text/plain'},
    {path:'dist/a.txt',name:'a\u0301.txt',mime:'text/plain'},
    {path:'https://example.com/a.txt',name:'a.txt',mime:'text/plain'},
    {path:'dist/.secret.txt',name:'a.txt',mime:'text/plain'}
  ]) assert.throws(()=>validateCaptureRequest(request));
});

test('Large source rejects at 32KiB instead of truncating and announcing 200',async()=>{
  const source='x'.repeat(TASK_ARTIFACT_MAX_BYTES+1);
  await assert.rejects(capture(T1,source),/UNVERIFIED_SOURCE_READ/);
});

test('Invalid UTF-8 readback accounting is a hard failure',async()=>{
  await assert.rejects(capture(T1,'hello',{inspected:{...text('hello'),byteSize:1}}),/SOURCE_BYTE_COUNT_MISMATCH/);
});

test('Expired bytes never receive attachment headers',async()=>{
  const a=await capture(T1);
  const r=await verifiedArtifactDownload(a,1000+TASK_ARTIFACT_TTL_MS);
  assert.equal(r.status,410); assert.equal(r.headers.get('content-disposition'),null);
  assert.equal(artifactIsOwnedBy(a,{...task(T1)},1000+TASK_ARTIFACT_TTL_MS),false);
});

test('Modified stored bytes or sha cannot be delivered successfully',async()=>{
  const a=await capture(T1);const forged={...a,bytes:new TextEncoder().encode('other')};
  const r=await verifiedArtifactDownload(forged,1001);
  assert.equal(r.status,502);assert.equal(r.headers.get('content-disposition'),null);
});

test('Ten out-of-order tasks associate file bytes with exact request',async()=>{
  const completions=[7,2,9,1,5,4,0,8,6,3];
  const store=new Map();
  for(const number of completions){
    const id=number.toString(16).padStart(16,'0');
    const artifact=await capture(id,`task-${number}\n`);
    store.set(artifactKey(id,artifact.artifactId), artifact);
  }
  assert.equal(store.size,10);
  for(let number=0;number<10;number++){
    const id=number.toString(16).padStart(16,'0');
    const item=[...store.values()].find(x=>x.requestId===id);
    assert.ok(item);
    const r=await verifiedArtifactDownload(store.get(artifactKey(id,item.artifactId)),1001);
    assert.equal(await r.text(),`task-${number}\n`);
    assert.ok(artifactIsOwnedBy(item,{...task(id)},1001));
    const other=(number+1)%10;
    assert.ok(!artifactIsOwnedBy(item,{...task(other.toString(16).padStart(16,'0'))},1001));
  }
});

test('Spoofed MIME and stored metadata rejected at download boundary',async()=>{
  const a=await capture(T1),forged={...a,name:'report.html',mime:'text/html'};
  const r=await verifiedArtifactDownload(forged,1001);
  assert.equal(r.status,502);assert.equal(r.headers.get('content-disposition'),null);
});

test('Manifest advertises only authenticated relative route, no bearer or source path',async()=>{
 const a=await capture(T1),m=artifactView(a);
 assert.equal(m.schema,'opencode.task-output.v1');assert.equal(m.delivery.kind,'authenticated-route');
 assert.ok(!JSON.stringify(m).includes('dist/report.txt'));assert.ok(!JSON.stringify(m).includes('/bundle'));
 assert.ok(!JSON.stringify(m).includes('Bearer'));assert.ok(!JSON.stringify(m).includes('http'));
});
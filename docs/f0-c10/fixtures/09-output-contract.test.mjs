import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { artifactPath, validateManifest, verifyDownload } from './09-output-contract.mjs';

const resources = new Map();
const auth = 'Bearer offline-test-only';
const server = createServer((req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(403).end(); return; }
  const obj = resources.get(req.url);
  if (!obj) { res.writeHead(404).end(); return; }
  if (obj.redirect) { res.writeHead(302, { location: 'https://evil.example/' }).end(); return; }
  res.writeHead(200, {
    'Content-Type': obj.mime,
    'Content-Length': String(obj.body.byteLength),
    'Content-Disposition': `attachment; filename=\"download.txt\"; filename*=UTF-8''${encodeURIComponent(obj.name || 'desconocido.txt')}`, 
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer'
  });
  // Real HTTP bytes, optionally sent as chunks to exercise stream consumption.
  if (obj.body.byteLength > 100_000) {
    for (let i = 0; i < obj.body.byteLength; i += 64_000) res.write(obj.body.subarray(i, i + 64_000));
    res.end();
  } else res.end(obj.body);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const baseURL = `http://127.0.0.1:${server.address().port}`;
const now = Date.now();
function fixture(taskNo, name = 'reporte.txt', mime = 'text/plain', body = Buffer.from('hola')) {
  const requestId = taskNo.toString(16).padStart(16, '0');
  const artifactId = `file_${taskNo.toString(16).padStart(8, '0')}`;
  const path = artifactPath(requestId, artifactId);
  const artifact = { requestId, artifactId, name, mime, byteSize: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), delivery: {kind:'authenticated-route',path,expiresAt:now+300000} };
  const manifest = {schema:'opencode.task-output.v1',requestId,status:'finished',passed:false,verified:false,reviewRequired:true,summary:{text:'Tarea completa',truncated:false},artifacts:[artifact],errors:[],evidence:{source:'offline-fixture'}};
  resources.set(path, {mime,body,name});
  return {manifest,artifact,body,path};
}
async function verify(x) { return verifyDownload({manifest:x.manifest,artifact:x.artifact,baseURL,trustedOrigin:baseURL,authorization:auth,now,allowLocalTestOrigin:true}); }
async function rejects(p, code) { await assert.rejects(p, e => e.message === code); }

test('TXT: GET real, count and SHA-256 match', async () => { const x=fixture(1); assert.equal((await verify(x)).bytesVerified,4); });
test('Markdown UTF-8 filename and body', async () => { const x=fixture(2,'niño_árbol_東京.md','text/markdown',Buffer.from('# Árbol 🌳')); assert.equal((await verify(x)).sha256,x.artifact.sha256); });
test('JSON: artifact bytes are actually retrievable', async () => { const x=fixture(3,'datos.json','application/json',Buffer.from('{"ok":true}')); await verify(x); });
test('2 MiB chunked output uses streaming verification', async () => { const x=fixture(4,'grande.bin','application/octet-stream',Buffer.alloc(2*1024*1024,0x7f)); assert.equal((await verify(x)).bytesVerified,2*1024*1024); });
test('ten tasks finishing out of order keep exact task/file association', async () => {
  const fs=Array.from({length:10},(_,i)=>fixture(100+i,`reporte_${i}.txt`,'text/plain',Buffer.from(`task ${i} distinct`)));
  const order=[8,3,9,0,6,4,1,7,2,5];
  const receipts=[];
  await Promise.all(order.map(async (idx,pos)=>{ await new Promise(resolve=>setTimeout(resolve,(9-pos)*3)); receipts.push(await verify(fs[idx])); }));
  assert.deepEqual(new Set(receipts.map(x=>x.requestId)),new Set(fs.map(x=>x.manifest.requestId)));
  assert.equal(new Set(receipts.map(x=>x.artifactId)).size,10);
  for(const x of receipts) assert.ok(fs.some(f=>f.artifact.artifactId===x.artifactId && f.manifest.requestId===x.requestId && f.artifact.sha256===x.sha256));
});
test('cross-task artifact injection rejected', async()=>{ const a=fixture(20),b=fixture(21); const wrong=structuredClone(a.manifest);wrong.artifacts=[b.artifact];await rejects(Promise.resolve().then(()=>validateManifest(wrong,now)),'ARTIFACT_WRONG_TASK'); });
test('do not accept successful HTTP with corrupted bytes', async()=>{const x=fixture(22);resources.set(x.path,{name:x.artifact.name,mime:x.artifact.mime,body:Buffer.from('evil!')});await rejects(verify(x),'CONTENT_LENGTH_MISMATCH');});
test('do not accept equal-length substituted bytes', async()=>{const x=fixture(23);resources.set(x.path,{name:x.artifact.name,mime:x.artifact.mime,body:Buffer.from('evil')});await rejects(verify(x),'BYTE_HASH_MISMATCH');});
test('no path, file:, localhost from untrusted manifest, token URL or external URL',()=>{
 const x=fixture(24);for(const path of ['/bundle/reporte.txt','file:///etc/passwd','https://evil.test/file?token=abc','/api/tasks/0000000000000024/artifacts/file_00000018?key=secret']){
  const obj=structuredClone(x.manifest);obj.artifacts[0].delivery.path=path;assert.throws(()=>validateManifest(obj,now),{message:'UNTRUSTED_DELIVERY_PATH'});
 }
});
test('reject HTML/SVG active, mismatched mime and hostile file names',()=>{
 const x=fixture(25);for(const [name,mime] of [['run.html','text/html'],['pic.svg','image/svg+xml'],['fake.json','text/plain'],['../secret.txt','text/plain'],['x\u202ecod.exe.txt','text/plain']]){
  const obj=structuredClone(x.manifest);obj.artifacts[0].name=name;obj.artifacts[0].mime=mime;assert.throws(()=>validateManifest(obj,now));
 }
});
test('expired URLs, size over policy, duplicate artifact IDs and undeclared truncation fail closed',()=>{
 const x=fixture(26);for(const mutate of [
  o=>{o.artifacts[0].delivery.expiresAt=now-1},
  o=>{o.artifacts[0].byteSize=21*1024*1024},
  o=>{o.artifacts.push(structuredClone(o.artifacts[0]))},
  o=>{o.summary.truncated=true}
 ]){const o=structuredClone(x.manifest);mutate(o);assert.throws(()=>validateManifest(o,now));}
});
test('error codes for missing, rejected, redirected and swapped MIME',async()=>{
 const missing=fixture(27);resources.delete(missing.path);await rejects(verify(missing),'NOT_DOWNLOADABLE_HTTP_404');
 const redirect=fixture(28);resources.set(redirect.path,{redirect:true});await rejects(verify(redirect),'NOT_DOWNLOADABLE_HTTP_302');
 const swapped=fixture(29);resources.set(swapped.path,{name:swapped.artifact.name,mime:'text/html',body:swapped.body});await rejects(verify(swapped),'RESPONSE_MIME_MISMATCH');
 await rejects(verifyDownload({manifest:swapped.manifest,artifact:swapped.artifact,baseURL,trustedOrigin:baseURL,authorization:'Bearer wrong',now,allowLocalTestOrigin:true}),'NOT_DOWNLOADABLE_HTTP_403');
});
test('cannot verify untrusted origins or non-existent manifest association',async()=>{
 const a=fixture(30),b=fixture(31);
 await rejects(verifyDownload({manifest:a.manifest,artifact:b.artifact,baseURL,trustedOrigin:baseURL,authorization:auth,now,allowLocalTestOrigin:true}),'ARTIFACT_NOT_IN_MANIFEST');
 await rejects(verifyDownload({manifest:a.manifest,artifact:a.artifact,baseURL:'http://evil.example',trustedOrigin:baseURL,authorization:auth,now}),'UNTRUSTED_DOWNLOAD_ORIGIN');
});

test('filename in download headers must match the requested Unicode artifact', async()=>{
  const x=fixture(32,'resumen_東京.md','text/markdown',Buffer.from('ok'));
  resources.set(x.path,{name:'otro.md',mime:x.artifact.mime,body:x.body});
  await rejects(verify(x),'DOWNLOAD_FILENAME_MISMATCH');
});

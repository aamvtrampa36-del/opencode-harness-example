import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureInspectedArtifact, persistTaskArtifact, readTaskArtifactPage, artifactKey, artifactIndexKey, artifactIsOwnedBy, verifiedArtifactDownload, TASK_ARTIFACT_TTL_MS } from './task-output-artifacts.ts';
const scope = { id:'0000000000000001', project:'supervised-0000000000000001', session:'sesFixture1', repository:'fixture/repository' };
const NOW=1000;
function store(rows=new Map()) {
  const reads=[];
  return {rows,reads, async get(key){reads.push(key);return structuredClone(rows.get(key));},async put(key,value){rows.set(key,structuredClone(value));},async delete(key){return rows.delete(key);}};
}
async function capture(text, now=NOW, owner=scope, mime='text/plain') {
  const path=mime==='application/json'?'dist/report.json':'dist/report.txt';
  const bytes=Buffer.from(text);
  return captureInspectedArtifact({requestId:owner.id,ownerProject:owner.project,ownerSession:owner.session,repository:owner.repository,request:{path,name:path.slice(5),mime},inspected:{path,byteSize:bytes.length,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')},now});
}
test('existing keys survive serialized reconstruction and replay preserves original expiry and bytes',async()=>{
  const first=store();const a=await capture('olá 🌎');
  await persistTaskArtifact(first,scope,a,NOW);
  const reopened=store(structuredClone(first.rows));
  const replay=await persistTaskArtifact(reopened,scope,await capture('olá 🌎',NOW+10),NOW+10);
  assert.equal(replay.createdAt,NOW);assert.equal(replay.expiresAt,NOW+TASK_ARTIFACT_TTL_MS);
  assert.deepEqual(reopened.rows.get(artifactIndexKey(scope.id)),[a.artifactId]);
  const page=await readTaskArtifactPage(reopened,scope,undefined,2,NOW+10);
  assert.equal(page.artifacts.length,1);assert.equal(page.artifacts[0].sha256,a.sha256);
  assert.ok(!JSON.stringify(page).includes('dist/report.txt'));
  const response=await verifiedArtifactDownload(reopened.rows.get(artifactKey(scope.id,a.artifactId)),NOW+10);
  assert.equal(response.status,200);assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),a.sha256);
});
test('incremental reads hydrate at most one page, preserve ordering, reject foreign cursor',async()=>{
  const s=store();const records=[];
  for(let n=0;n<5;n++){const a=await capture('report '+n);records.push(a);await persistTaskArtifact(s,scope,a,NOW);}
  s.reads.length=0;
  const one=await readTaskArtifactPage(s,scope,undefined,2,NOW);
  assert.equal(s.reads.length,3);assert.equal(one.scanned,2);
  const two=await readTaskArtifactPage(s,scope,one.nextAfter,2,NOW);
  const three=await readTaskArtifactPage(s,scope,two.nextAfter,2,NOW);
  assert.deepEqual([...one.artifacts,...two.artifacts,...three.artifacts].map(a=>a.artifactId),records.map(a=>a.artifactId));
  assert.equal(three.nextAfter,null);
  await assert.rejects(readTaskArtifactPage(s,scope,'0000000000000002:'+records[0].artifactId,2,NOW),/ARTIFACT_CURSOR_INVALID/);
  await assert.rejects(readTaskArtifactPage(s,scope,undefined,9,NOW),/ARTIFACT_PAGE_LIMIT/);
});
test('foreign owner, malformed repository, duplicate index and tampered bytes fail closed',async()=>{
  const s=store();const a=await capture('report');await persistTaskArtifact(s,scope,a,NOW);
  const key=artifactKey(scope.id,a.artifactId);
  for(const other of [{...a,ownerSession:'sesForeign'},{...a,repository:null},{...a,bytes:new Uint8Array(a.byteSize)}]){
    s.rows.set(key,other);await assert.rejects(readTaskArtifactPage(s,scope,undefined,2,NOW),/ARTIFACT_SCOPE_OR_EXPIRY|ARTIFACT_INTEGRITY_FAILURE/);
    await assert.rejects(persistTaskArtifact(s,scope,a,NOW),/ARTIFACT_SCOPE_OR_EXPIRY|ARTIFACT_INTEGRITY_FAILURE/);
  }
  assert.equal(artifactIsOwnedBy({...a,repository:null},scope,NOW),false);
  s.rows.set(key,a);s.rows.set(artifactIndexKey(scope.id),[a.artifactId,a.artifactId]);
  await assert.rejects(readTaskArtifactPage(s,scope,undefined,2,NOW),/ARTIFACT_INDEX_INVALID/);
  await assert.rejects(persistTaskArtifact(s,scope,a,NOW),/ARTIFACT_INDEX_INVALID/);
  await assert.rejects(persistTaskArtifact(store(),{...scope,project:'foreign'},a,NOW),/ARTIFACT_SCOPE_OR_EXPIRY/);
});
test('bounded retention, expiration, JSON and bytes stay distinct',async()=>{
  const s=store();const a=await capture('{"ok":true}',NOW,scope,'application/json');await persistTaskArtifact(s,scope,a,NOW);
  for(let n=1;n<8;n++)await persistTaskArtifact(s,scope,await capture('report '+n),NOW);
  await assert.rejects(persistTaskArtifact(s,scope,await capture('ninth'),NOW),/ARTIFACT_TASK_LIMIT/);
  const expired=await readTaskArtifactPage(s,scope,undefined,8,NOW+TASK_ARTIFACT_TTL_MS);
  assert.equal(expired.scanned,8);assert.deepEqual(expired.artifacts,[]);
  await assert.rejects(persistTaskArtifact(s,scope,await capture('{"ok":true}',NOW+TASK_ARTIFACT_TTL_MS,scope,'application/json'),NOW+TASK_ARTIFACT_TTL_MS),/ARTIFACT_SCOPE_OR_EXPIRY/);
  await assert.rejects(capture('{broken',NOW,scope,'application/json'),/INVALID_JSON_ARTIFACT/);
  const fresh=await capture('new distinct report',NOW+TASK_ARTIFACT_TTL_MS);
  await persistTaskArtifact(s,scope,fresh,NOW+TASK_ARTIFACT_TTL_MS);
  assert.deepEqual(s.rows.get(artifactIndexKey(scope.id)),[fresh.artifactId]);
  assert.equal(s.rows.size,2);
});

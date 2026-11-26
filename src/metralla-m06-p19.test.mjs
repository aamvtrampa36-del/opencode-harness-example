import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { taskArtifactReaderSource } from './task-artifact-source.ts';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'p19-'));
  try {
    mkdirSync(join(root, 'owner', 'dist', 'real'), {recursive:true});
    mkdirSync(join(root, 'foreign', 'dist'), {recursive:true});
    writeFileSync(join(root, 'foreign', 'dist', 'report.txt'), 'synthetic foreign data');
    writeFileSync(join(root, 'owner', 'dist', 'real', 'report.txt'), 'synthetic report');
    const run = (project, file) => spawnSync(process.execPath, ['-e', taskArtifactReaderSource(root), project, file], { encoding:'utf8', timeout:2000, maxBuffer:100000 });
    fn(root, run);
  } finally { rmSync(root, {recursive:true,force:true}); }
}
function denied(r) {
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim(), 'ARTIFACT_READ_UNAVAILABLE');
}
test('project symlink cannot impersonate another task', () => fixture((root, run) => {
  symlinkSync(join(root,'foreign'),join(root,'alias'));
  denied(run('alias','dist/report.txt'));
}));
test('nested alias and ambiguous paths fail closed', () => fixture((root, run) => {
  symlinkSync(join(root,'owner','dist','real'),join(root,'owner','dist','alias'));
  denied(run('owner','dist/alias/report.txt'));
  denied(run('owner','dist/missing.txt'));
  writeFileSync(join(root,'owner','dist','bad..txt'),'synthetic');
  denied(run('owner','dist/bad..txt'));
}));
test('bounded exact bytes and digest including full limit and empty file', () => fixture((root, run) => {
  for (const size of [0,32768,32769]) {
    const bytes = Buffer.alloc(size, 0x61);
    writeFileSync(join(root,'owner','dist','report.txt'),bytes);
    const r=run('owner','dist/report.txt');
    if(size>32768) { denied(r); continue; }
    assert.equal(r.status,0,r.stderr);
    const out=JSON.parse(r.stdout);
    assert.equal(out.byteSize,size);
    assert.deepEqual(Buffer.from(out.base64,'base64'),bytes);
    assert.equal(out.sha256,createHash('sha256').update(bytes).digest('hex'));
  }
}));
test('recognisable credential material is refused without echo', () => fixture((root, run) => {
  for (const contents of ['-----BEGIN PRIVATE KEY-----', 'Authorization: Bearer synthetic-fixture-value', '{"api_key":"synthetic-fixture-value"}', 'ghp_'+'x'.repeat(30)]) {
    writeFileSync(join(root,'owner','dist','report.txt'),contents);
    denied(run('owner','dist/report.txt'));
  }
}));

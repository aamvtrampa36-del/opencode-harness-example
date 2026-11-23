import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { taskArtifactReaderSource } from './task-artifact-source.ts';

const root = mkdtempSync(join(tmpdir(), 'opencode-output-probe-'));
const project = 'supervised-0000000000000001';
const src = taskArtifactReaderSource(root);
function probe(filePath) {
  return spawnSync(process.execPath, ['-e', src, project, filePath], {encoding:'utf8', timeout:1500, maxBuffer:100_000});
}
try {
  mkdirSync(join(root, project, 'dist'), {recursive:true});
  writeFileSync(join(root, project, 'dist', 'olá.txt'), Buffer.from('olá'));
  writeFileSync(join(root, project, 'dist', 'valid.txt'), Buffer.from('olá'));
  writeFileSync(join(root, project, 'dist', 'broken.txt'), Buffer.from([0xc3, 0x28]));
  writeFileSync(join(root, project, 'dist', 'large.txt'), Buffer.alloc(32769, 0x61));
  writeFileSync(join(root, 'private.txt'), 'PRIVATE');
  symlinkSync(join(root,'private.txt'),join(root,project,'dist','link.txt'));
  symlinkSync(join(root,'private.txt'),join(root,project,'dist','alias.txt'));
  linkSync(join(root,'private.txt'),join(root,project,'dist','hard.txt'));
  const foreign = 'supervised-0000000000000002';
  mkdirSync(join(root,foreign,'dist'), {recursive:true});
  writeFileSync(join(root,foreign,'dist','confidential.txt'), 'OTHER TASK SECRET');
  linkSync(join(root,foreign,'dist','confidential.txt'), join(root,project,'dist','cross-task.txt'));
  // Probe path and identity in the actual read-only process, not a mocked receipt.
  test('real Container-style process reads exact source bytes and SHA-256', () => {
    const result=probe('dist/valid.txt');
    assert.equal(result.status,0, result.stderr);
    const report=JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report).sort(), ['base64','byteSize','path','sha256']);
    const actual=Buffer.from(report.base64,'base64');
    assert.equal(actual.toString(),'olá');
    assert.equal(report.byteSize,actual.length);
    assert.equal(report.sha256,createHash('sha256').update(actual).digest('hex'));
  });
  test('malformed UTF-8 is returned byte-identically instead of silently replaced', () => {
    const res=probe('dist/broken.txt'); assert.equal(res.status,0,res.stderr);
    assert.deepEqual(Buffer.from(JSON.parse(res.stdout).base64,'base64'),Buffer.from([0xc3,0x28]));
  });
  test('symlink, traversal, absolute and internal URLs are rejected by source process', () => {
    for (const p of ['dist/link.txt','dist/alias.txt','dist/../private.txt','../private.txt','/bundle/x.txt','file:///tmp/x.txt','dist/missing.txt']) {
      const result=probe(p); assert.notEqual(result.status,0,p);
      assert.equal(result.stdout,'',p);
    }
  });
  test('hardlinks to other tasks or private files fail closed (R3 RED to GREEN)', () => {
    for (const p of ['dist/hard.txt','dist/cross-task.txt']) {
      const result = probe(p);
      assert.notEqual(result.status,0,p);
      assert.equal(result.stdout,'',p);
      assert.ok(!result.stderr.includes('OTHER TASK SECRET') &&
        !result.stderr.includes('PRIVATE'),p);
    }
  });
  test('large files over 32KiB cannot become a successful receipt', () => {
    const r=probe('dist/large.txt'); assert.notEqual(r.status,0); assert.equal(r.stdout,'');
  });
} finally {
  // node:test execution may be deferred; cleanup via process exit not required
  process.on('exit', () => { try { rmSync(root,{recursive:true,force:true}); } catch {} });
}
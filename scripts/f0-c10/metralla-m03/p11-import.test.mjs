import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
// Pass a checked-out copy of src/github-import-source.ts or point to the B0 blob.
const importer = process.env.P11_IMPORT_SOURCE;
const {GITHUB_IMPORT_SOURCE}=await import(importer?pathToFileURL(importer).href:new URL('../../../src/github-import-source.ts',import.meta.url));
test('real git archive certifies raw tree without .git; wrong tree fails before publication',()=>{
  const temp=mkdtempSync(join(tmpdir(),'p11-import-'));
  try {
    const repo=join(temp,'repo'),root=join(temp,'projects');mkdirSync(repo);mkdirSync(root);
    const git=(...args)=>execFileSync('git',args,{cwd:repo});
    git('init','-q');mkdirSync(join(repo,'nested'));writeFileSync(join(repo,'hello.txt'),'P11\n');
    writeFileSync(join(repo,'nested','run.sh'),'#!/bin/sh\nexit 0\n');chmodSync(join(repo,'nested','run.sh'),0o755);
    git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','offline fixture');
    const tree=git('rev-parse','HEAD^{tree}').toString().trim();
    const archive=git('archive','--format=tar.gz','--prefix=fixture/','HEAD');
    const run=(project,expectedTree)=>spawnSync(process.execPath,['--input-type=module','-e',GITHUB_IMPORT_SOURCE,project,expectedTree],{input:archive,env:{...process.env,IMPORT_TEST_ROOT:root},encoding:'utf8',timeout:10000});
    const good=run('valid',tree);assert.equal(good.status,0,good.stderr);const receipt=JSON.parse(good.stdout);
    assert.equal(receipt.tree,tree);assert.equal(receipt.certification,'raw-git-tree-v1');assert.equal(receipt.files,2);
    assert.equal(readFileSync(join(root,'valid','hello.txt'),'utf8'),'P11\n');assert.equal(existsSync(join(root,'valid','.git')),false);
    const bad=run('invalid','0'.repeat(40));assert.notEqual(bad.status,0);assert.match(bad.stderr,/Git tree hash mismatch/);assert.equal(existsSync(join(root,'invalid')),false);
  } finally {rmSync(temp,{recursive:true,force:true});}
});

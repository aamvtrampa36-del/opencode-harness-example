const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const importer=fs.readFileSync(path.join(__dirname,'../../../src/github-import-source.ts'),'utf8');
const source=importer.split('String.raw'+String.fromCharCode(96))[1].split(String.fromCharCode(96)+';')[0];
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'p16-tree-'));
after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
const repo=path.join(fixture,'fixture');fs.mkdirSync(repo);
const root=path.join(fixture,'out');fs.mkdirSync(root);
const git=(...a)=>execFileSync('git',a,{cwd:repo});
git('init','-q');git('config','user.name','P16 synthetic');git('config','user.email','fixture@example.invalid');
git('config','core.autocrlf','false');git('config','core.filemode','true');
fs.mkdirSync(path.join(repo,'src'));
fs.writeFileSync(path.join(repo,'src','hello.txt'),'a\r\nb\n');
fs.writeFileSync(path.join(repo,'run.sh'),'#!/bin/sh\nexit 0\n',{mode:0o755});
git('add','.');git('commit','-qm','fixture');
const tree=git('rev-parse','HEAD^{tree}').toString().trim();
const tar=git('archive','--format=tar.gz','--prefix=fixture/','HEAD');
const run=(target,expected,input=tar)=>spawnSync(process.execPath,['--input-type=module','-e',source,target,expected],
  {input,encoding:'utf8',env:{...process.env,IMPORT_TEST_ROOT:root}});
test('raw Git tree fixture imports exact bytes and executable mode without .git',()=>{
  const p=run('correct',tree);assert.equal(p.status,0,p.stderr);
  const r=JSON.parse(p.stdout);assert.equal(r.tree,tree);assert.equal(r.certification,'raw-git-tree-v1');
  assert.equal(fs.existsSync(path.join(root,'correct','.git')),false);
  assert.equal(fs.readFileSync(path.join(root,'correct','src','hello.txt'),'utf8'),'a\r\nb\n');
  assert.equal(fs.statSync(path.join(root,'correct','run.sh')).mode&0o777,0o755);
  console.log('TREE='+tree+' CERT='+r.certification+' IMPORT_EXIT='+p.status);
});
test('divergent tree fails and does not publish destination',()=>{
  const p=run('wrong','f'.repeat(40));assert.equal(p.status,1);assert.match(p.stderr,/Git tree hash mismatch/);
  assert.equal(fs.existsSync(path.join(root,'wrong')),false);assert.deepEqual(fs.readdirSync(root),['correct']);
  console.log('DIVERGENCE_EXIT='+p.status);
});
test('invalid tarball fails without publication',()=>{
  const p=run('invalid',tree,Buffer.from('invalid archive'));assert.equal(p.status,1);
  assert.match(p.stderr,/Invalid gzip archive/);assert.equal(fs.existsSync(path.join(root,'invalid')),false);
  console.log('INVALID_ARCHIVE_EXIT='+p.status);
});

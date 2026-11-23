/**
 * F0-C10/T08: offline GitHub publication/isolation fixtures.
 * Run: node --test scripts/f0-c10-t08-integrity.test.mjs
 * No network, model inference, cloud calls or repository mutations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const run = (cwd, ...args) => execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function makeRepo() {
  const cwd=mkdtempSync(join(tmpdir(),'f0-c10-t08-'));
  run(cwd,'init','-q','-b','main');
  run(cwd,'config','user.name','T08 Synthetic');
  run(cwd,'config','user.email','t08@example.invalid');
  writeFileSync(join(cwd,'README.md'),'fixture\n');
  run(cwd,'add','README.md');
  run(cwd,'commit','-qm','initial fixture');
  return cwd;
}
test('ten branches preserve ten isolated Git file blobs; base stays untouched',()=>{
  const cwd=makeRepo();
  try{
    const base=run(cwd,'rev-parse','HEAD');
    const path='docs/opencode-agent-lab/collision-t08.json';
    const blobs=new Set();
    for(let i=0;i<10;i++){
      const name='opencode/staging-'+String(i).padStart(16,'0');
      const dir=join(cwd,'worktree-'+i);
      run(cwd,'worktree','add','-q','-b',name,dir,base);
      mkdirSync(join(dir,'docs/opencode-agent-lab'),{recursive:true});
      writeFileSync(join(dir,path),JSON.stringify({task:i,isolated:true})+'\n');
      run(dir,'add',path);
      run(dir,'commit','-qm','synthetic '+i);
      blobs.add(run(cwd,'rev-parse',name+':'+path));
      assert.equal(JSON.parse(run(cwd,'show',name+':'+path)).task,i);
      assert.equal(run(cwd,'rev-list','--count',base+'..'+name),'1');
    }
    assert.equal(blobs.size,10);
    assert.equal(run(cwd,'rev-parse','main'),base);
    assert.equal(run(cwd,'ls-tree','-r','--name-only','main').includes(path),false);
  } finally {rmSync(cwd,{recursive:true,force:true});}
});
test('two independent writers on identical path produce real Git add/add conflict',()=>{
  const cwd=makeRepo();
  try{
    const path='collision.json';
    for(const [branch,value] of [['opencode/staging-aaaaaaaaaaaaaaaa','A'],['opencode/staging-bbbbbbbbbbbbbbbb','B']]){
      run(cwd,'checkout','-q','-b',branch,'main');
      writeFileSync(join(cwd,path),JSON.stringify({value}));
      run(cwd,'add',path);run(cwd,'commit','-qm',branch);
    }
    run(cwd,'checkout','-q','opencode/staging-aaaaaaaaaaaaaaaa');
    let code=0,output='';
    try{run(cwd,'merge','--no-commit','--no-ff','opencode/staging-bbbbbbbbbbbbbbbb');}
    catch(e){code=e.status??1;output=String(e.stderr??'')+String(e.stdout??'');}
    assert.notEqual(code,0);
    assert.match(output,/CONFLICT|conflict/i);
    assert.match(run(cwd,'ls-files','-u'),/collision\.json/);
    run(cwd,'merge','--abort');
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('two writers updating one Git ref with expected old OID: exactly one wins',()=>{
  const cwd=makeRepo();
  try{
    const old=run(cwd,'rev-parse','HEAD');
    const name='opencode/staging-cccccccccccccccc';
    run(cwd,'branch',name,old);
    const tree=run(cwd,'rev-parse',old+'^{tree}');
    const commits=['candidate-A','candidate-B'].map(message=>
      execFileSync('git',['-C',cwd,'commit-tree',tree,'-p',old],
        {encoding:'utf8',input:message+'\n'}).trim());
    const results=commits.map(sha=>{try{
      run(cwd,'update-ref','refs/heads/'+name,sha,old);return 'won';
    }catch{return 'lost';}});
    assert.deepEqual(results,['won','lost']);
    assert.equal(run(cwd,'rev-parse',name),commits[0]);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
const overlap=(a,b)=>a.base===b.base&&a.files.some(path=>b.files.includes(path));
function barrier(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test('RED: non-atomic list-then-POST allows two overlapping PRs',async()=>{
  const open=[],gate=barrier();let ready=0;
  const writers=[{base:'staging/ref',head:'A',files:['src/shared.ts']},
    {base:'staging/ref',head:'B',files:['src/shared.ts']}];
  async function create(pr){
    assert.equal(open.some(other=>overlap(pr,other)),false);
    if(++ready===2)gate.resolve();
    await gate.promise;
    open.push(pr);
  }
  await Promise.all(writers.map(create));
  assert.equal(open.length,2);
  assert.equal(overlap(open[0],open[1]),true);
});
class Coordinator{
  #lease=null;#generation=0;
  claim(owner,now,ttl=1000){
    if(this.#lease&&this.#lease.expires>now)return null;
    this.#lease={owner,generation:++this.#generation,expires:now+ttl};
    return {...this.#lease};
  }
  valid(lease,now){return !!(lease&&this.#lease&&this.#lease.owner===lease.owner&&
    this.#lease.generation===lease.generation&&this.#lease.expires>now);}
  release(lease){if(!this.#lease||this.#lease.owner!==lease.owner||
    this.#lease.generation!==lease.generation)return false;
    this.#lease=null;return true;}
}
test('MODEL ONLY: exclusive claim + recheck prevents second conflicting PR',()=>{
  const coord=new Coordinator(),open=[];
  const a={base:'staging/ref',head:'A',files:['src/shared.ts']},
    b={base:'staging/ref',head:'B',files:['src/shared.ts']};
  const la=coord.claim('A',10),lb=coord.claim('B',10);
  assert.ok(la);assert.equal(lb,null);
  assert.equal(open.some(other=>overlap(a,other)),false);
  open.push(a);
  assert.equal(coord.release(la),true);
  const next=coord.claim('B',12);
  assert.ok(next);
  assert.equal(open.some(other=>overlap(b,other)),true);
  assert.equal(open.length,1);
  assert.equal(coord.release(next),true);
});
test('MODEL ONLY: generation fencing rejects expired stale owner',()=>{
  const coord=new Coordinator();
  const a=coord.claim('A',100,5),b=coord.claim('B',106,5);
  assert.ok(a&&b);
  assert.equal(coord.valid(a,106),false);
  assert.equal(coord.release(a),false);
  assert.equal(coord.valid(b,107),true);
});
test('lost response after successful PUT is reconciled by readback, no duplicate',async()=>{
  const db={content:null,commits:0};
  async function put(value){db.content=value;db.commits++;throw Error('lost after remote commit');}
  async function write(value){if(db.content===value)return {reconciled:true,unchanged:true};await put(value);}
  await assert.rejects(write('intended text'),/lost after remote commit/);
  assert.deepEqual(await write('intended text'),{reconciled:true,unchanged:true});
  assert.equal(db.commits,1);
});
test('same path under different bases is not caught by same-base PR check',()=>{
  assert.equal(overlap({base:'main',files:['src/shared.ts']},
    {base:'staging/ref',files:['src/shared.ts']}),false);
});

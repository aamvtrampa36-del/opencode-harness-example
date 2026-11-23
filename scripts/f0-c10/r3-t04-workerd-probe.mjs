/**
 * R3-T04 executable local workerd experiment. No paid inference or Staging.
 * Starts a disposable Wrangler DO/SQLite fixture and *kills only that local
 * process*, reopens the same temporary directory, then validates native GET.
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";

const config = "scripts/f0-c10/r3-t04-workerd.wrangler.jsonc";
const wrangler = path.resolve("node_modules/.bin/wrangler");
const persist = await mkdtemp(path.join(tmpdir(), "f0-c10-r3-t04-"));
const serverLogs = [];
let runner;
let passed = 0;
function note(message) { passed++; process.stdout.write("R3_T04_WORKERD_PASS " + message + "\n"); }
async function randomPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  return port;
}
const port = await randomPort(), origin = "http://127.0.0.1:" + port;
function start() {
  runner = spawn(wrangler, ["dev","--local","--config",config,
    "--ip","127.0.0.1","--port",String(port),"--persist-to",persist,
    "--log-level","error"], { cwd:process.cwd(), env:{
      ...process.env, CI:"true", NO_COLOR:"1", WRANGLER_SEND_METRICS:"false"
    }, detached:true, stdio:["ignore","pipe","pipe"] });
  for(const stream of [runner.stdout,runner.stderr]) {
    stream.on("data",chunk=>{
      const str=String(chunk);
      serverLogs.push(str.slice(0,1600));
      if(serverLogs.length>100)serverLogs.shift();
    });
  }
}
async function stop() {
  const p=runner;runner=null;
  if(!p) return;
  if(p.exitCode!==null) return;
  const closed=once(p,"close");
  try { process.kill(-p.pid,"SIGTERM"); } catch {}
  await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,5000))]);
  if(p.exitCode===null) {try{process.kill(-p.pid,"SIGKILL");}catch{}}
}
async function http(scope,action,body) {
  const url=origin+"/"+action+"?scope="+encodeURIComponent(scope);
  const res=await fetch(url,{method:body?"POST":"GET",
    ...(body?{headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{})});
  const json=await res.json();
  return { status:res.status, ...json };
}
async function ready(){
  const limit=Date.now()+90000;
  while(Date.now()<limit) {
    if(runner?.exitCode!==null) throw Error("WORKERD_EXITED_EARLY: "+serverLogs.join("").slice(-5000));
    try { const res=await http("fixture-health","get",{id:"fffffffffffffffd"});
      if(res.status===200) return; } catch {}
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  throw Error("WORKERD_START_TIMEOUT: "+serverLogs.join("").slice(-5500));
}
const sid=id=>"ses_r2_"+id;
const ID="0000000000000001";
function scope(i){return "fixture-"+i}
const post=(i,method,obj={})=>http(scope(i),method,{id:ID,...obj});
const get=(i,method)=>http(scope(i),method,undefined);
try {
  start();await ready();
  const negative=await get(1,"get");
  assert.equal(negative.found,false);
  assert.ok(["SessionNotFoundError","Session.NotFoundError"].includes(negative.errorTag),
    "actual SDK must tag missing session; received "+negative.errorTag);
  note("native GET negative tagged="+negative.errorTag);

  const reserv=await post(2,"prepare",{intent:false});
  assert.equal(reserv.kind,"granted");
  const notYet=await post(2,"reconcile");
  assert.equal(notYet.kind,"effect_unknown");
  note("pre-create transfer denied");

  await post(3,"prepare",{intent:true,marker:false});
  const noMarker=await post(3,"reconcile");
  assert.equal(noMarker.kind,"effect_unknown");
  note("write-ahead missing marker cannot be reconciled");

  const original=await post(4,"prepare",{intent:true});
  assert.equal(original.kind,"granted");
  const lost=await post(4,"create",{lost:true});
  assert.equal(lost.status,503);
  assert.equal(lost.simulatedLostReply,true);
  const after=await get(4,"get");
  assert.equal(after.found,true);
  assert.equal(after.id,sid(ID));
  const sessionRow=after.native.matchingRows.find(r=>r.table==="opencode_session");
  if(sessionRow) assert.equal(sessionRow.count,1);
  note("native SDK created deterministic session before simulated lost reply");

  // Destroy only the local Wrangler process. Recreate exactly the same
  // SQLite data directory: proves get() is a real durable read after restart.
  await stop();start();await ready();
  const interruptedMarker = await get(3,"state");
  assert.equal(interruptedMarker.task.sessionCreationAttempted,false);
  assert.equal(interruptedMarker.slot.phase,"effect_unknown");
  assert.equal((await get(3,"get")).found,false);
  note("pre-create intent survives LOCAL restart without inventing native session");
  const recoveredRow=await get(4,"get");
  assert.equal(recoveredRow.found,true);
  assert.equal(recoveredRow.id,sid(ID));
  note("native SQLite exact-ID read after LOCAL workerd process restart");

  const results=await Promise.all([post(4,"reconcile"),post(4,"reconcile")]);
  assert.deepEqual(results.map(x=>x.kind).sort(),["recovered","stale"]);
  const winner=results.find(x=>x.kind==="recovered");
  assert.equal(winner.state.task.session,sid(ID));
  assert.equal(winner.state.owner,ID);
  assert.equal(winner.state.slot.generation,original.grant.generation+1);
  note("two concurrent reconcilers transfer exactly one generation");

  const staleCommit=await post(4,"commit",{grant:original.grant});
  assert.equal(staleCommit.status,409);
  assert.equal(staleCommit.error,"ADMISSION_FENCE_REJECTED");
  const staleEffect=await post(4,"late-effect",{grant:original.grant});
  assert.equal(staleEffect.status,409);
  assert.equal(staleEffect.error,"ADMISSION_FENCE_REJECTED");
  const staleFailure=await post(4,"late-error",{grant:original.grant});
  assert.equal(staleFailure.kind,"fenced");
  assert.equal(staleFailure.state.task.status,"preparing");
  note("stale creator commit, configure, and ERROR branch all fenced");

  // Explicit repeat only after native positive GET + committed transfer, and
  // only in this disposable fixture. Production never auto-repeats create.
  const duplicate=await post(4,"create");
  assert.equal(duplicate.nativeId,sid(ID));
  const count=duplicate.after.matchingRows.find(r=>r.table==="opencode_session");
  if(count) assert.equal(count.count,1);
  assert.deepEqual(duplicate.before.matchingRows,duplicate.after.matchingRows);
  note("repeated create after positive reconciliation retains one native session row");

  const prepScope=await post(5,"prepare",{intent:true});
  await post(5,"create");
  await post(5,"foreign-scope");
  const wrongScope=await post(5,"reconcile");
  assert.equal(wrongScope.status,409);
  assert.equal(wrongScope.error,"SESSION_RECONCILE_SCOPE_CONFLICT");
  const prepOwner=await post(6,"prepare",{intent:true});
  await post(6,"create");
  await post(6,"foreign-owner");
  const wrongOwner=await post(6,"reconcile");
  assert.equal(wrongOwner.status,409);
  assert.equal(wrongOwner.error,"SESSION_RECONCILE_SCOPE_CONFLICT");
  note("cross-project scope and reverse-owner conflicts both rejected");

  const finGrant=await post(7,"prepare",{intent:true});
  await post(7,"create");
  const commit=await post(7,"commit",{grant:finGrant.grant});
  assert.equal(commit.kind,"committed");
  const finish=await post(7,"finish",{grant:finGrant.grant});
  assert.equal(finish.kind,"finished-synthetic-receipt");
  const [turnA,turnB]=await Promise.all([post(7,"readmit"),post(7,"readmit")]);
  assert.deepEqual([turnA.kind,turnB.kind].sort(),["existing","submit"]);
  assert.equal(turnA.state.slot.phase,"effect_unknown");
  const notFound=await post(7,"turn-receipt",{status:"unanswered",reason:"not_found"});
  assert.equal(notFound.accepted,false);
  assert.equal(notFound.state.slot.phase,"effect_unknown");
  const done=await post(7,"turn-receipt",{status:"done"});
  assert.equal(done.accepted,true);
  assert.equal(done.state.slot.phase,"running");
  note("native-operation receipt UNKNOWN/not_found cannot release slot; synthetic terminal receipt can");
  note("finished readmission single-slot atomic; duplicate turn never double-submitted");
  process.stdout.write(JSON.stringify({schema:"f0-c10.r3-t04.workerd.v1",
    status:"PASS",cases:passed,pinned:{agents:"0.33.0",sdk:"2.0.24"},
    localPersist:true,proof:"real-local-workerd-sqlite-and-sdk-no-inference"})+"\n");
}catch(e){
  process.stderr.write("R3_T04_WORKERD_FAIL "+String(e?.stack||e)+"\n"+serverLogs.join("").slice(-9000)+"\n");
  process.exitCode=1;
}finally{
  await stop();
  await rm(persist,{recursive:true,force:true});
}

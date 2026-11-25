import {test} from "node:test";
import assert from "node:assert/strict";
import {REMOTE_SCHEMA as schema,MAX_BODY_BYTES,remoteScope,validateStatus,validateProgress,projectRemoteProgress,dispatchBoundedMcp,boundMcpRequest} from "./p08-remote.ts";
const scope=remoteScope("0000000000000001",null);
const status={schema,...scope,revision:3,status:"finished",passed:true,verified:true};
const key=await crypto.subtle.generateKey({name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
const rows=Array.from({length:70},(_,i)=>({seq:i+1,type:i===1?"session.reasoning.delta":"session.tool.called"}));
let reads=0;
const source={async next(_scope,after,max,signal){reads++;assert(!signal.aborted);const row=rows[Number(after||0)];return row?(JSON.stringify(row).length<=max?{kind:"row",row}:{kind:"oversize"}):{kind:"end"};}};
const allow=async()=>({principal:"fixture-owner",workspace:"opencode-supervisor-v1",session:"sesFixture",key,source});
test("status incremental and no fabricated PASS",()=>{
  assert.equal(validateStatus(status,scope,3).changed,false);
  assert.equal(validateStatus(status,scope,2).changed,true);
  assert.equal(validateStatus(status,scope,null).verified,false);
});
test("bad schema, identity, revision and status",()=>{
  for(const patch of [{schema:"v0"},{id:"0000000000000002"},{workspace:"other"},{revision:1},{status:"success"}])
    assert.throws(()=>validateStatus({...status,...patch},scope,2),/REMOTE_/);
  assert.throws(()=>remoteScope("bad",null),/REMOTE_ID/);
  assert.throws(()=>remoteScope(scope.id,"bad"),/REMOTE_WORKSPACE/);
});
test("P07 signed cursor, paginated source, explicit reasoning omission",async()=>{
  const a=await projectRemoteProgress(scope,undefined,allow);
  assert.equal(a.events.length,64);assert.equal(a.nextAfter,64);assert.equal(a.events[1].type,"event.omitted");
  assert.equal(a.complete,false);assert.equal(a.verified,false);
  const b=await projectRemoteProgress(scope,a.cursor,allow);
  assert.equal(b.events.length,6);assert.equal(b.nextAfter,70);assert.equal(b.complete,true);assert.equal(b.cursor,null);
});
test("cursor foreign principal/task/session, tampered and invalid; no source read",async()=>{
  const a=await projectRemoteProgress(scope,undefined,allow);
  const before=reads;
  for(const [s,token,auth] of [[{...scope,id:"0000000000000002"},a.cursor,allow],[scope,a.cursor,async()=>({...await allow(),principal:"other"})],[scope,a.cursor,async()=>({...await allow(),session:"sesOther"})],[scope,a.cursor.slice(0,-1)+(a.cursor.endsWith("a")?"b":"a"),allow],[scope,"bad",allow]])
    await assert.rejects(projectRemoteProgress(s,token,auth),/CURSOR_INVALID/);
  await assert.rejects(projectRemoteProgress(scope,undefined,async()=>null),/SCOPE_FORBIDDEN/);
  assert.equal(reads,before);
});
test("negative source and no advance",async()=>{
  for(const next of [async()=>({kind:"oversize"}),async()=>({kind:"row",row:{seq:2,type:"event"}}),async()=>{throw Error("upstream");}])
    await assert.rejects(projectRemoteProgress(scope,undefined,async()=>({...await allow(),source:{next}})));
  const good={schema,...scope,requestCursor:null,from:0,nextAfter:1,events:[{seq:1,type:"event"}],complete:true,cursor:null,pageAvailable:true};
  for(const patch of [{schema:"v0"},{id:"0000000000000002"},{workspace:"wrong"},{from:1},{nextAfter:2},{events:[{seq:2,type:"event"}]},{events:[{seq:1,type:"reasoning"}]},{pageAvailable:false},{complete:false,cursor:null}])
    assert.throws(()=>validateProgress({...good,...patch},scope,undefined),/REMOTE_/);
});
const req=(body,headers={})=>new Request("https://fixture/mcp",{method:"POST",body,headers});
test("body limit before dispatch, headers retained, GET unchanged",async()=>{
  let calls=0;const dispatch=async r=>{calls++;assert.equal(r.headers.get("mcp-session-id"),"fixture");return new Response(await r.text());};
  const ok=await dispatchBoundedMcp(req("{}",{"mcp-session-id":"fixture"}),dispatch);
  assert.equal(await ok.text(),"{}");assert.equal(calls,1);
  for(const r of [req("x".repeat(MAX_BODY_BYTES+1)),req("{}",{"content-length":String(MAX_BODY_BYTES+1)}),req("{}",{"content-encoding":"gzip"}),req("{}",{"content-length":"1"})])
    assert([400,413,415].includes((await dispatchBoundedMcp(r,dispatch)).status));
  assert.equal(calls,1);
  const get=new Request("https://fixture/mcp");assert.equal(await boundMcpRequest(get),get);
});
test("slow body times out and cancels; no retry of handler effect",async()=>{
  let cancelled=false;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
  await assert.rejects(boundMcpRequest(new Request("https://fixture/mcp",{method:"POST",body:stream,duplex:"half"}),10),/MCP_BODY_TIMEOUT/);
  assert.equal(cancelled,true);let attempts=0;
  await assert.rejects(dispatchBoundedMcp(req("{}"),async()=>{attempts++;throw Error("upstream");}),/upstream/);
  assert.equal(attempts,1);
});

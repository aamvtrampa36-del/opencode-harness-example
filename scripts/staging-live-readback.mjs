// Staging-only, no inference, no writes or task start. Check complete expected public asset set.
import {createHash} from "node:crypto";
import {readFileSync,statSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import assert from "node:assert/strict";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {digestDirectory} from "./staging-release-receipt.mjs";
const origin="https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev";
const mcp="https://opencode-staging-control-mcp.cdf-cloud-mvp-20261019.workers.dev/mcp";
const root=process.argv[2];
if(!root||!process.env.CF_ACCESS_CLIENT_ID||!process.env.CF_ACCESS_CLIENT_SECRET)throw Error("Existing Staging Access service credentials unavailable");
const headers={"CF-Access-Client-Id":process.env.CF_ACCESS_CLIENT_ID,"CF-Access-Client-Secret":process.env.CF_ACCESS_CLIENT_SECRET};
const manifest=digestDirectory(root).manifest;
const ignore=readFileSync(join(root,".assetsignore"),"utf8").trim().split(/\r?\n/);
assert.deepEqual(ignore,["wrangler.json",".dev.vars"],"Unexpected static asset ignore policy");
const expected=manifest.filter(([p])=>p!==".assetsignore");
assert.equal(expected.length,manifest.length-1);
const actual=[];let cursor=0;const failures=[];
async function check(){
  while(cursor<expected.length&&failures.length<8){
    const [p,sha]=expected[cursor++];
    try{
      assert.ok(!p.split("/").some(x=>x===".."||x==="."||!x));
      const url=new URL(p==="index.html"?"/":"/"+p.split("/").map(encodeURIComponent).join("/"),origin);
      assert.equal(url.origin,origin);
      const r=await fetch(url,{headers:{...headers,"Accept-Encoding":"identity","Cache-Control":"no-cache"},redirect:"manual",signal:AbortSignal.timeout(20000)});
      if(r.status!==200)throw Error("HTTP "+r.status);
      const size=statSync(join(root,p)).size;
      if(!r.body)throw Error("No body");
      const reader=r.body.getReader();let total=0;const h=createHash("sha256");
      try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>size){await reader.cancel();throw Error("Size mismatch");}h.update(value);}}finally{reader.releaseLock();}
      const digest=h.digest("hex");
      if(total!==size||digest!==sha)throw Error("Byte mismatch");
      actual.push([p,digest]);
    }catch(e){failures.push({path:p,reason:e instanceof Error?e.message:"unknown"});if(failures.length>=8)return;}
  }
}
await Promise.all(Array.from({length:4},()=>check()));
actual.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
const digest=rows=>createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const health=await fetch(origin+"/api/health",{headers,redirect:"manual",signal:AbortSignal.timeout(20000)});
assert.equal(health.status,200,"Authenticated health status");
const healthData=await health.json();assert.equal(healthData.status,"ok");
const client=new Client({name:"opencode-release-readback",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL(mcp),{requestInit:{headers,redirect:"manual",signal:AbortSignal.timeout(30000)}});
let tools,status;
try{
  await client.connect(transport);
  const list=await client.listTools();
  tools=list.tools.map(t=>t.name).sort();
  assert.deepEqual(tools,["staging_agent_check","staging_agent_check_status","staging_cancel_task","staging_diagnostics","staging_mcp_call","staging_mcp_servers","staging_mcp_tools","staging_models","staging_openrouter_check","staging_openrouter_check_status","staging_repositories","staging_review_task","staging_session_inspect","staging_sessions","staging_start_task","staging_status","staging_task_continue","staging_task_progress","staging_task_select_model","staging_task_status","staging_task_transcript"]);
  const result=await client.callTool({name:"staging_status",arguments:{}});
  assert.ok(!result.isError);
  const data=JSON.parse(result.content.find(x=>x.type==="text").text);
  assert.equal(data.targetWorker,"opencode-g1-staging");assert.equal(data.status,"ok");assert.equal(data.supervisor.schema,"opencode.staging-control.v2");assert.equal(data.supervisor.ready,true);
  status={health:"ok",schema:data.supervisor.schema,ready:true,tools:tools.length};
}finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
const report={schema:"opencode-staging-readback/v1",expected:expected.length,matched:actual.length,expectedSha256:digest(expected),actualSha256:digest(actual),failures,status,passed:actual.length===expected.length&&!failures.length&&digest(expected)===digest(actual)};
writeFileSync("staging-readback.json",JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));
if(!report.passed)process.exitCode=1;

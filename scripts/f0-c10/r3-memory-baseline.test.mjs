import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const fixture=fileURLToPath(new URL("./r3-memory-baseline.mjs",import.meta.url));
function run(count,mode){
  const r=spawnSync(process.execPath,["--experimental-strip-types","--expose-gc",fixture,"--count",String(count),"--mode",mode],
    {encoding:"utf8",timeout:12000,maxBuffer:16384});
  if(r.error)throw r.error;
  assert.equal(r.status,mode==="red"?1:0,`unexpected exit: ${r.status}, stderr=${r.stderr.slice(0,300)}`);
  return JSON.parse(r.stdout);
}
for(const count of [1,2,4,10]){
  test(`R3-T01 deterministic RED/GREEN count ${count} isolates heap labels from Cloudflare`,()=>{
    const red=run(count,"red"),green=run(count,"green");
    for(const x of [red,green]){
      assert.equal(x.label,"SYNTHETIC_NODE_ONLY");
      assert.equal(x.count,count);
      assert(x.markers<=32&&x.markers>0);
      assert.equal(x.cloudflareIsolateBytes,null);
      assert.equal(x.cloudflareContainerBytes,null);
      assert.equal(x.cloudflareWorkerMcpHeapBytes,null);
      assert(x.nodeHeapUsedAfterBytes>0);
      assert(x.nodeRSSAfterBytes>0);
      assert(x.mcpWireBytes<=128);
      assert.equal(x.eventsPerSession,256);
    }
    assert.equal(red.retainedStrings,count);
    assert.equal(green.retainedStrings,0);
    assert.equal(green.retainedCursorProjections,count);
    assert(red.materializedBytes>green.materializedBytes*100,
      "full-history serialization must materially exceed cursor-only projection");
    console.log(JSON.stringify({count,
      redExit:1,greenExit:0,
      nodeRedHeapDeltaBytes:red.nodeV8HeapRetainedDeltaBytes,
      nodeGreenHeapDeltaBytes:green.nodeV8HeapRetainedDeltaBytes,
      redMaterializedBytes:red.materializedBytes,
      greenMaterializedBytes:green.materializedBytes,
      isolateBytes:null,containerBytes:null}));
  });
}
test("baseline rejects invalid task count (prevents accidental real 1-2-4-10 job)",()=>{
  const r=spawnSync(process.execPath,["--experimental-strip-types","--expose-gc",fixture,
    "--count","11","--mode","green"],{encoding:"utf8",timeout:12000,maxBuffer:4096});
  assert.equal(r.status,2);
  assert(!r.stdout.includes("cloudflareIsolateBytes"));
});

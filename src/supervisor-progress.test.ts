import {describe,expect,test} from "bun:test";
import {projectSupervisorProgress} from "./supervisor-progress";

const row=(seq:number,type="session.tool.called",data:Record<string,unknown>={})=>({
  durable:{seq},type,data
});
const source=(rows:unknown[],count:{reads:number}={reads:0})=>(async function*(){
  for(const r of rows){count.reads++;yield r;}
})();
const longLog=(length:number,type:string,count:{reads:number})=>(async function*(){
  for(let i=1;i<=length;i++){count.reads++;yield row(i,type,{largeText:"x".repeat(2000)});}
})();

describe("F0-C10/T05 bounded Remote/MCP progress",()=>{
  test("reasoning-only historical log is never fully traversed; filtered rows advance cursor",async()=>{
    const count={reads:0};
    const page=await projectSupervisorProgress(longLog(50_000,"session.reasoning.delta",count));
    expect(page.events).toEqual([]);
    expect(page.scanned).toBeLessThanOrEqual(128);
    expect(count.reads).toBeLessThanOrEqual(128);
    expect(page.nextAfter).toBeGreaterThan(0);
    expect(page.nextAfter).toBe(page.skipped);
    expect(page.truncated).toBe(true);
  });
  test("replayed events after restart cannot duplicate results",async()=>{
    const first=await projectSupervisorProgress(source([1,2,3].map(i=>row(i))));
    const next=await projectSupervisorProgress(source([row(2),row(3),row(4),row(5)]),first.nextAfter);
    expect(next.events.map(e=>e.seq)).toEqual([4,5]);
    expect(next.duplicates).toBe(2);
    expect(next.nextAfter).toBe(5);
  });
  test("missing sequence is explicitly flagged and not silently verified",async()=>{
    const page=await projectSupervisorProgress(source([row(1),row(3),row(4)]));
    expect(page.gapDetected).toBe(true);
    expect(page.nextAfter).toBe(4);
    expect("passed" in page).toBe(false);
    expect("verified" in page).toBe(false);
  });
  test("malformed cursors, rows and budgets fail closed",async()=>{
    await expect(projectSupervisorProgress(source([]),-1)).rejects.toThrow("CURSOR_INVALID");
    await expect(projectSupervisorProgress(source([]),Number.MAX_SAFE_INTEGER+1)).rejects.toThrow("CURSOR_INVALID");
    await expect(projectSupervisorProgress(source([{}]))).rejects.toThrow("SEQUENCE_INVALID");
    await expect(projectSupervisorProgress(source([]),0,{maxScanned:999})).rejects.toThrow("BUDGET_INVALID");
  });
  test("byte limit is applied before cursor advancement: no delivered event lost",async()=>{
    const rows=Array.from({length:30},(_,i)=>row(i+1,"tool."+"x".repeat(75)));
    const first=await projectSupervisorProgress(source(rows),0,{maxBytes:256});
    expect(first.truncated).toBe(true);
    expect(first.projectedBytes).toBeLessThanOrEqual(256);
    const second=await projectSupervisorProgress(source(rows.slice(first.nextAfter)),first.nextAfter,{maxBytes:256});
    expect(second.events[0]?.seq).toBe(first.nextAfter+1);
  });
  test("large tool payload is never serialized into projected output",async()=>{
    const rows=Array.from({length:200},(_,i)=>row(i+1,"session.tool.called",{secret:"TOP_SECRET"+"X".repeat(20000)}));
    const page=await projectSupervisorProgress(source(rows));
    expect(page.events.length).toBeLessThanOrEqual(64);
    expect(page.projectedBytes).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(page)).not.toContain("TOP_SECRET");
  });
  test("ten concurrent readers have independent sequence and bounded source consumption",async()=>{
    const reads=Array.from({length:10},()=>({reads:0}));
    const ids=Array.from({length:10},(_,i)=>i.toString(16).padStart(16,"0"));
    const pages=await Promise.all(ids.map((id,i)=>
      projectSupervisorProgress((async function*(){
        for(let seq=1;seq<=1000;seq++){
          reads[i].reads++;
          yield row(seq,seq%2?"session.reasoning.delta":"session.tool.called",{owner:id});
        }
      })()).then(page=>({id,page}))
    ));
    expect(new Set(pages.map(x=>x.id)).size).toBe(10);
    for(let i=0;i<10;i++){
      expect(reads[i].reads).toBeLessThanOrEqual(128);
      expect(pages[i].page.events.length).toBeLessThanOrEqual(64);
      expect(pages[i].page.nextAfter).toBeGreaterThan(0);
      expect(pages[i].page.truncated).toBe(true);
    }
  });
});

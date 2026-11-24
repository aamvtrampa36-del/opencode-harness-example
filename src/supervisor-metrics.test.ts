import {describe,expect,test} from "bun:test";
import {foldSupervisorToolLog, EMPTY_SUPERVISOR_TOOL_COUNTS} from "./supervisor-metrics";

const event = (seq: number, type: string, extra: Record<string,unknown> = {}) =>
  ({ durable: { seq }, type, data: extra });

describe("bounded supervisor status event log accounting", () => {
  test("counts real OpenCode durable tool event types without loading message history",async()=>{
    const values=[event(1,"session.tool.called"),event(2,"session.tool.success"),
      event(3,"session.tool.called"),event(4,"session.tool.failed"),
      event(5,"session.text.ended"),event(6,"log.synced")];
    async function* log(){yield* values;}
    const result=await foldSupervisorToolLog(log(),EMPTY_SUPERVISOR_TOOL_COUNTS,100);
    expect(result).toEqual({metrics:{cursor:6,toolCalls:2,completedTools:1,failedTools:1},
      complete:true,eventsRead:6});
  });
  test("limits reads even if log contains millions of large tool payloads",async()=>{
    let yielded=0;
    async function* log(){
      for(let i=1;i<1000000;i++){
        yielded++;
        yield event(i,"session.tool.called",{largeText:"x".repeat(10000)});
      }
    }
    const result=await foldSupervisorToolLog(log(),EMPTY_SUPERVISOR_TOOL_COUNTS,40);
    expect(result.metrics).toEqual({cursor:40,toolCalls:40,completedTools:0,failedTools:0});
    expect(result.complete).toBe(false);
    expect(result.eventsRead).toBe(40);
    expect(yielded).toBeLessThanOrEqual(41);
  });
  test("incremental cursor prevents double-counting after restart or stale replay",async()=>{
    async function* first(){for(let i=1;i<=8;i++)yield event(i,"session.tool.called");}
    const state=(await foldSupervisorToolLog(first(),EMPTY_SUPERVISOR_TOOL_COUNTS,4)).metrics;
    async function* replay(){for(let i=3;i<=9;i++)yield event(i,i===9?"session.tool.success":"session.tool.called");}
    const second=await foldSupervisorToolLog(replay(),state,20);
    expect(second.metrics).toEqual({cursor:9,toolCalls:8,completedTools:1,failedTools:0});
    expect(second.complete).toBe(true);
  });
  test("invalid event sequence fails closed rather than issuing complete status",async()=>{
    async function* bad(){yield {type:"session.tool.called"};}
    await expect(foldSupervisorToolLog(bad(),EMPTY_SUPERVISOR_TOOL_COUNTS))
      .rejects.toThrow("SUPERVISOR_EVENT_SEQUENCE_INVALID");
  });
  test("rejects malformed state or budgets, never fabricates accurate totals",async()=>{
    async function* empty(){return;}
    await expect(foldSupervisorToolLog(empty(),{...EMPTY_SUPERVISOR_TOOL_COUNTS,cursor:-1}))
      .rejects.toThrow("SUPERVISOR_METRICS_INVALID");
    await expect(foldSupervisorToolLog(empty(),EMPTY_SUPERVISOR_TOOL_COUNTS,0))
      .rejects.toThrow("SUPERVISOR_EVENT_BUDGET_INVALID");
  });
});

describe("incremental accounting edge contracts", () => {
  test("empty log preserves a copied checkpoint", async () => {
    const checkpoint = { cursor: 9, toolCalls: 4, completedTools: 2, failedTools: 1 };
    async function* empty() {}
    const r = await foldSupervisorToolLog(empty(), checkpoint);
    expect(r.metrics).toEqual(checkpoint);
    expect(r.metrics).not.toBe(checkpoint);
    expect(r.complete).toBe(true);
    expect(r.eventsRead).toBe(0);
  });
  test("legacy top-level sequence works without durable wrapper", async () => {
    async function* log(){ yield {seq:1,type:"session.tool.called"}; yield {seq:2,type:"session.tool.success"}; }
    expect((await foldSupervisorToolLog(log())).metrics).toEqual({cursor:2,toolCalls:1,completedTools:1,failedTools:0});
  });
  test("an exact event-budget page is complete if the iterator ends", async () => {
    async function* log(){ yield event(1,"session.tool.called"); yield event(2,"session.tool.success"); }
    const r = await foldSupervisorToolLog(log(), EMPTY_SUPERVISOR_TOOL_COUNTS, 2);
    expect(r.complete).toBe(true); expect(r.eventsRead).toBe(2);
  });
  test("a truncated page closes the iterator", async () => {
    let closed=false;
    async function* log(){ try { for(let i=1;i<=5;i++)yield event(i,"session.tool.called"); } finally { closed=true; } }
    expect((await foldSupervisorToolLog(log(), EMPTY_SUPERVISOR_TOOL_COUNTS, 1)).complete).toBe(false);
    expect(closed).toBe(true);
  });
  test("duplicate events do not increment a durable checkpoint", async () => {
    async function* log(){yield event(1,"session.tool.called"); yield event(1,"session.tool.called");}
    expect((await foldSupervisorToolLog(log())).metrics.toolCalls).toBe(1);
  });
  test("counter overflow fails instead of returning a precision-lost count", async () => {
    async function* log(){yield event(2,"session.tool.called");}
    await expect(foldSupervisorToolLog(log(), {cursor:1,toolCalls:Number.MAX_SAFE_INTEGER,completedTools:0,failedTools:0})).rejects.toThrow("SUPERVISOR_METRICS_INVALID");
  });
});

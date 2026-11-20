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
import { describe, expect, test } from "bun:test";
import { boundedMcpJsonText, redactMcpString } from "./bounded-response";

describe("F0-C10/R2-T05 bounded MCP serialization", () => {
  test("normal replies retain API fields and worker correlation", () => {
    const json=boundedMcpJsonText({id:"a1234567890bcdef",status:"running",passed:false,verified:false,
      events:[{seq:1,type:"session.tool.called"}]},16_000,"opencode-g1-staging");
    expect(JSON.parse(json)).toMatchObject({id:"a1234567890bcdef",
      status:"running",targetWorker:"opencode-g1-staging",
      events:[{seq:1,type:"session.tool.called"}],passed:false,verified:false});
    expect(JSON.parse(json)._responseTruncated).toBeUndefined();
  });
  test("giant single event is omitted before serialization; no partial secrets", () => {
    const secret="ghp_"+"a".repeat(6000000);
    const page={status:"passed",passed:true,verified:true,events:[{seq:1,type:"tool",output:secret}]};
    const text=boundedMcpJsonText(page);
    const result=JSON.parse(text);
    expect(text.length).toBeLessThan(16000);
    expect(text).not.toContain("ghp_");
    expect(result._responseTruncated).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.status).toBe("unknown");
  });
  test("never visits an extra array element to learn it is too long", () => {
    const rows=Array.from({length:10000},(_,i)=>i);
    Object.defineProperty(rows,64,{get(){throw Error("UNBOUNDED_ARRAY_SCAN")},enumerable:true});
    const response=JSON.parse(boundedMcpJsonText({events:rows,passed:true,verified:true}));
    expect(response.events).toHaveLength(64);
    expect(response._responseTruncated).toBe(true);
    expect(response.passed).toBe(false);
    expect(response.verified).toBe(false);
  });
  test("secret-key values are not accessed at all", () => {
    const value={status:"running"} as Record<string,unknown>;
    Object.defineProperty(value,"access_token",{get(){throw Error("SECRET_GETTER_ACCESS")},enumerable:true});
    expect(JSON.parse(boundedMcpJsonText(value)).access_token).toBe("[REDACTADO]");
  });
  test("small secret strings are fully redacted", () => {
    const text=boundedMcpJsonText({description:"Bearer ghp_abcdefghijklmnopqrst",secret:"sk-proj-abcdefghijklmnop"});
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("sk-proj");
    expect(redactMcpString("Bearer abc.def")).toContain("[REDACTADO]");
  });
  test("cycles, oversized keys and malformed values fail closed", () => {
    const circular:any={status:"passed",passed:true,verified:true};
    circular.loop=circular;
    const result=JSON.parse(boundedMcpJsonText(circular));
    expect(result._responseTruncated).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.verified).toBe(false);
    const weird=JSON.parse(boundedMcpJsonText({bad:1n}));
    expect(weird._responseTruncated).toBe(true);
  });
  test("hard response cap never leaks a forged PASS", () => {
    const obj:Record<string,unknown>={status:"passed",passed:true,verified:true};
    for(let i=0;i<64;i++)obj["key_"+i]="value_"+i+"_".repeat(300);
    const result=JSON.parse(boundedMcpJsonText(obj,256));
    expect(result._responseTruncated).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.verified).toBe(false);
  });
  test("partial count projections never advertise full verification", () => {
    const text=boundedMcpJsonText({status:"passed",toolCountsComplete:true,
      supervisedCountComplete:true,passed:true,verified:true,extra:"x".repeat(2_000_000)});
    const page=JSON.parse(text);
    expect(page._responseTruncated).toBe(true);
    expect(page.toolCountsComplete).toBe(false);
    expect(page.supervisedCountComplete).toBe(false);
    expect(page.passed).toBe(false);
    expect(page.verified).toBe(false);
  });

  test("ten interleaved MCP projections do not mix task IDs", async () => {
    const pages=await Promise.all(Array.from({length:10},async(_,i)=>{
      const id=i.toString(16).padStart(16,"0");
      return JSON.parse(boundedMcpJsonText({taskId:id,status:"running",events:[
        {seq:i+1,type:"tool",payload:"x".repeat(1_000_000)}
      ],passed:true,verified:true}));
    }));
    expect(new Set(pages.map(x=>x.taskId)).size).toBe(10);
    expect(pages.every(p=>p.passed===false&&p.verified===false&&p._responseTruncated)).toBe(true);
  });
});

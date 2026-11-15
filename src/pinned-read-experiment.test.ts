import { describe, expect, test } from "bun:test";
import { GitHubBridge, type GitHubAction } from "./github";
import { ExperimentalPinnedReadCache } from "./experimental-pinned-read-cache";
import { executeBoundRepositoryAction } from "./scoped-github";

const REPO = "aamvtrampa36-del/opencode-harness-example";
const PIN = "a".repeat(40);
type Scenario = "pinned_repeat" | "pinned_many" | "mutable_branch" | "mixed";
type Mode = "original" | "candidate";
type Operation = { path: string; ref: string };
type RecordRow = {
  scenario: Scenario; mode: Mode; gets: number; wireBytes: number;
  latencyMs: number; exactOutputs: boolean; calls: number;
};

function scenarioOperations(scenario: Scenario): Operation[] {
  const pinned = (path: string) => ({ path, ref: PIN });
  if (scenario === "pinned_repeat") return Array.from({length:10}, () => pinned("src/core.ts"));
  if (scenario === "pinned_many") return Array.from({length:12}, (_, i) => pinned("src/part" + i % 3 + ".ts"));
  if (scenario === "mutable_branch") return Array.from({length:8}, () => ({ path:"src/core.ts", ref:"main" }));
  return [
    pinned("src/core.ts"), pinned("src/config.ts"), pinned("src/core.ts"),
    {path:"src/core.ts",ref:"main"}, pinned("src/config.ts"),
    pinned("src/core.ts"), {path:"src/core.ts",ref:"main"},
    pinned("src/config.ts"), pinned("src/core.ts")
  ];
}

async function run(scenario: Scenario, mode: Mode): Promise<RecordRow> {
  let gets=0,wireBytes=0, mutable=0;
  const cache=new ExperimentalPinnedReadCache();
  const fake: typeof fetch = async (url, init) => {
    const str=String(url);
    gets++;
    const parsed = new URL(str);
    const path = decodeURIComponent(parsed.pathname.split("/contents/")[1] ?? "");
    const ref = parsed.searchParams.get("ref") ?? "default";
    const suffix = ref === "main" ? "-version-" + ++mutable : "";
    const text = "file=" + path + ";ref=" + ref + suffix + ";" + "SOURCE-".repeat(180);
    const body = JSON.stringify({
      type:"file",encoding:"base64",size:new TextEncoder().encode(text).byteLength,
      sha:"b".repeat(40),content:btoa(text)
    });
    wireBytes += new TextEncoder().encode(body).byteLength;
    await Bun.sleep(2); // fixed synthetic network latency per actual HTTP call
    return new Response(body,{status:200,headers:{"Content-Type":"application/json"}});
  };
  const operations = scenarioOperations(scenario);
  const obtained: unknown[]=[];
  const start=performance.now();
  for (const operation of operations) {
    const bridge=new GitHubBridge("synthetic-token",fake,[REPO],mode==="candidate"?cache:undefined);
    const result = await executeBoundRepositoryAction(
      "ses_synthetic","plan",{action:"read",...operation},
      async () => REPO,
      async (_session, repository) => {
        if(repository!==REPO) throw new Error("scope mismatch");
      },
      async (action: GitHubAction) => bridge.execute(action)
    );
    obtained.push(result);
  }
  const latencyMs=Number((performance.now()-start).toFixed(3));
  const expected=operations.map((operation,i)=>{
    const version=operation.ref==="main"
      ? "-version-"+operations.slice(0,i+1).filter(x=>x.ref==="main").length : "";
    return {
      repo:REPO,path:operation.path,ref:operation.ref,sha:"b".repeat(40),
      content:"file="+operation.path+";ref="+operation.ref+version+";"+"SOURCE-".repeat(180)
    };
  });
  return {
    scenario, mode, gets,wireBytes,latencyMs,calls:operations.length,
    exactOutputs:obtained.every((value,i) => {
      const got=value as Record<string,unknown>;
      const want=expected[i] as Record<string,unknown>;
      return Object.keys(got).length === Object.keys(want).length &&
        Object.entries(want).every(([key,expectedValue]) => got[key]===expectedValue);
    })
  };
}
describe("Exp4: paired scoped-tool GitHub read baseline vs candidate",()=>{
  test("repeats equivalent tasks under both modes",async()=>{
    for(const scenario of ["pinned_repeat","pinned_many","mutable_branch","mixed"] as const){
      const results: RecordRow[]=[];
      for(let replicate=1;replicate<=3;replicate++){
        const order: Mode[] = replicate % 2 === 1 ?
          ["original","candidate"] : ["candidate","original"];
        for (const mode of order) {
          const id=mode+":"+scenario+":"+replicate;
          console.log("EXP4_BEGIN "+JSON.stringify({id,scenario,mode,replicate}));
          let outcome: RecordRow;
          try {
            outcome=await run(scenario,mode);
          } catch(error){
            console.log("EXP4_END "+JSON.stringify({id,status:"FAIL",error:String(error)}));
            throw error;
          }
          console.log("EXP4_END "+JSON.stringify({id,status:outcome.exactOutputs?"PASS":"FAIL",...outcome}));
          expect(outcome.exactOutputs).toBe(true);
          results.push(outcome);
        }
      }
      const mean=(mode:Mode,key:"gets"|"wireBytes"|"latencyMs") =>
        results.filter(x=>x.mode===mode).reduce((sum,x)=>sum+x[key],0)/3;
      const getSavings=100*(1-mean("candidate","gets")/mean("original","gets"));
      const bytesSavings=100*(1-mean("candidate","wireBytes")/mean("original","wireBytes"));
      console.log("EXP4_SUMMARY "+JSON.stringify({
        scenario,originalGets:mean("original","gets"),candidateGets:mean("candidate","gets"),
        originalBytes:mean("original","wireBytes"),candidateBytes:mean("candidate","wireBytes"),
        getSavingsPct:Number(getSavings.toFixed(3)),byteSavingsPct:Number(bytesSavings.toFixed(3)),
        originalMs:mean("original","latencyMs"),candidateMs:mean("candidate","latencyMs")
      }));
      if(scenario==="pinned_repeat"||scenario==="pinned_many"){
        expect(getSavings).toBeGreaterThanOrEqual(70);
        expect(bytesSavings).toBeGreaterThanOrEqual(70);
      }
      if(scenario==="mutable_branch") expect(getSavings).toBe(0);
    }
  });

  test("cross-credential cache isolation, local auth, and failed HTTP are preserved",async()=>{
    let gets=0;
    let deny=false;
    const fake:typeof fetch=async() => {
      gets++;
      if(deny) return new Response(JSON.stringify({message:"Forbidden"}),{status:403});
      return new Response(JSON.stringify({
        type:"file",encoding:"base64",size:4,sha:"b".repeat(40),content:btoa("data")
      }),{status:200});
    };
    const cache=new ExperimentalPinnedReadCache();
    const action: GitHubAction={action:"read",repo:REPO,path:"safe.txt",ref:PIN};
    const a=new GitHubBridge("token-a",fake,[REPO],cache);
    await a.execute(action);await a.execute(action);
    expect(gets).toBe(1);
    const unauthorized = new GitHubBridge("token-a",fake,["aamvtrampa36-del/other-repo"],cache);
    await expect(unauthorized.execute(action)).rejects.toThrow("not authorized");
    expect(gets).toBe(1);
    deny=true;
    const b=new GitHubBridge("token-b",fake,[REPO],cache);
    await expect(b.execute(action)).rejects.toThrow("GitHub API 403");
    await expect(b.execute(action)).rejects.toThrow("GitHub API 403");
    expect(gets).toBe(3); // new token and failures are never cached
    const malicious={...action,path:"../sensitive"};
    await expect(a.execute(malicious)).rejects.toThrow("Invalid repository file path");
    expect(gets).toBe(3);
  });

  test("concurrent same-content reads share one HTTP request",async()=>{
    const cache=new ExperimentalPinnedReadCache();let gets=0;
    const fake:typeof fetch=async() => {
      gets++;await Bun.sleep(5);
      return new Response(JSON.stringify({
        type:"file",encoding:"base64",size:4,sha:"b".repeat(40),content:btoa("data")
      }),{status:200});
    };
    const action: GitHubAction={action:"read",repo:REPO,path:"safe.txt",ref:PIN};
    const results=await Promise.all(Array.from({length:8},()=>new GitHubBridge(
      "token-a",fake,[REPO],cache).execute(action)));
    expect(gets).toBe(1);
    expect(new Set(results.map(x=>JSON.stringify(x))).size).toBe(1);
  });
});

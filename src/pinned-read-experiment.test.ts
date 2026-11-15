import { describe, expect, test } from "bun:test";
import { GitHubBridge, type GitHubAction } from "./github";
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
    const bridge=new GitHubBridge("synthetic-token",fake,[REPO]);
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
    exactOutputs:JSON.stringify(obtained)===JSON.stringify(expected)
  };
}
describe("Exp4: source-pinned GitHub read baseline",()=>{
  test("measure original bridge and scoped-tool path before candidate",async()=>{
    for(const scenario of ["pinned_repeat","pinned_many","mutable_branch","mixed"] as const){
      for(let replicate=1;replicate<=3;replicate++){
        const id="original:"+scenario+":"+replicate;
        console.log("EXP4_BEGIN "+JSON.stringify({id,scenario,mode:"original",replicate}));
        try{
          const result=await run(scenario,"original");
          console.log("EXP4_END "+JSON.stringify({id,status:result.exactOutputs?"PASS":"FAIL",...result}));
          expect(result.exactOutputs).toBe(true);
          expect(result.gets).toBe(result.calls);
        }catch(error){
          console.log("EXP4_END "+JSON.stringify({id,status:"FAIL",error:String(error)}));
          throw error;
        }
      }
    }
  });
});

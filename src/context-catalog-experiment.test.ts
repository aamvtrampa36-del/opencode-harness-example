import { describe, expect, test } from "bun:test";
import { workspacePlugin } from "./workspace";

type Scenario = "plan-bound-repo" | "build-bound-repo" | "plan-no-repo" | "build-unscoped";
type Mode = "baseline" | "curated";
type ContextHook = (ctx: {
  sessionID: string; agent: string;
  model: { providerID: string; id: string };
  tools: Record<string, { description: string; input: object }>
}) => Promise<void>;

type Result = {
  scenario: Scenario; mode: Mode; schemaBytes: number; declaredCount: number;
  visibleCount: number; names: string[]; elapsedMs: number; valid: boolean
};
const BOUND = "aamvtrampa36-del/opencode-harness-example";
const cases: Record<Scenario, { agent: string; project: string; repo: string }> = {
  "plan-bound-repo": {agent:"plan",project:"sandbox",repo:BOUND},
  "build-bound-repo": {agent:"build",project:"sandbox",repo:BOUND},
  "plan-no-repo": {agent:"plan",project:"sandbox",repo:""},
  "build-unscoped": {agent:"build",project:"",repo:""}
};

async function exercise(scenario: Scenario, mode: Mode): Promise<Result> {
  const c = cases[scenario];
  const declared: Record<string, { description: string; input: object }> = {};
  let contextHook: ContextHook | undefined;
  const plugin = workspacePlugin(
    {} as never, {},
    {run: async()=>({project:"sandbox",exitCode:0,stdout:"",stderr:"",truncated:false,persistence:"test"}),
      inspect: async()=>({entries:[]})},
    {execute: async()=>({})},
    async()=>undefined,
    async()=>c.repo,
    async()=>c.project
  );
  const ctx = {
    agent: {transform: async (editor: {update: (id:string,fn:(agent:{system:string})=>void)=>void})=>{
      editor.update("build",agent=>{agent.system="";});
      editor.update("plan",agent=>{agent.system="";});
    }},
    session: {hook: async (name:string, fn: ContextHook)=>{
      if (name === "context") contextHook=fn;
    }},
    tool: {transform: async(fn:(editor:{
      remove:(name:string)=>void;
      add:(entry:{name:string;description:string;input:object})=>void
    })=>void)=>{
      fn({remove: name=>{delete declared[name];},
        add: tool=>{declared[tool.name]={description:tool.description,input:tool.input};}});
    }}
  };
  await plugin.setup(ctx as never);
  if(!contextHook) throw new Error("OpenCode context hook was not registered");
  const available=structuredClone(declared);
  const before=performance.now();
  await contextHook({
    sessionID:"ses_exp5_fixture",agent:c.agent,
    model:{providerID:"openrouter",id:"synthetic-model"},
    tools:available
  });
  const elapsedMs=Number((performance.now()-before).toFixed(4));
  const names=Object.keys(available).sort();
  const bytes=Buffer.byteLength(JSON.stringify(
    Object.fromEntries(Object.entries(available).sort(([a],[b])=>a.localeCompare(b)))
  ));
  const wanted=c.project
    ? (c.repo ? ["linux","inspect_linux","github","repo_review","repo_info","repo_read"]
      : ["linux","inspect_linux"])
    : [];
  const valid=c.project ? wanted.every(t=>names.includes(t)) :
    !names.some(x=>["linux","inspect_linux","github","repo_review","repo_info","repo_read"].includes(x));
  void mode; // Baseline first: mode is a logging label, no candidate yet.
  return {
    scenario,mode,schemaBytes:bytes,declaredCount:Object.keys(declared).length,
    visibleCount:names.length,names,elapsedMs,valid
  };
}

describe("Experiment 5: observed plugin context catalog baseline",()=>{
  test("record real workspacePlugin declared schemas and context hook in 3 baseline repeats",async()=>{
    for(const scenario of Object.keys(cases) as Scenario[]){
      for(let replicate=1;replicate<=3;replicate++){
        const id="baseline:"+scenario+":"+replicate;
        console.log("EXP5_BEGIN "+JSON.stringify({id,scenario,replicate,mode:"baseline"}));
        try{
          const result=await exercise(scenario,"baseline");
          console.log("EXP5_END "+JSON.stringify({id,status:result.valid?"PASS":"FAIL",...result}));
          expect(result.valid).toBe(true);
        }catch(error){
          console.log("EXP5_END "+JSON.stringify({id,status:"FAIL",error:String(error)}));
          throw error;
        }
      }
    }
  });
});

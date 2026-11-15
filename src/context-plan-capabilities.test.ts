import { describe, expect, test } from "bun:test";
import { workspacePlugin } from "./workspace";
import type { GitHubAction } from "./github";

const REPO="aamvtrampa36-del/opencode-harness-example";
type Exposed={ name:string; execute:(input:unknown,context:unknown)=>Promise<unknown> };
type Event={sessionID:string;agent:string;model:{providerID:string;id:string};tools:Record<string,{description:string;input:object}>};

async function fixture(){
  const registrations = new Map<string, Exposed>();
  let hook: ((e:Event)=>Promise<void>)|undefined;
  const actions: GitHubAction[]=[];
  const guards: string[]=[];
  const plugin = workspacePlugin(
    {} as never,{},
    { run:async()=>({project:"sandbox",exitCode:0,stdout:"",stderr:"",truncated:false,persistence:"fixture"}),
      inspect:async(project,action,path)=>({project,action,path})},
    {execute:async(input)=>{actions.push(input);return {ok:true,...input};}},
    async(_session,scope)=>{
      if(scope.kind==="github") {
        if(scope.repo!==REPO)throw Error("Wrong repository");
        guards.push(scope.repo);
      } else if(scope.kind==="linux") {
        if(scope.project!=="sandbox")throw Error("Wrong project");
        guards.push(scope.project);
      }else throw Error("Unexpected workspace scope");
    },
    async()=>REPO,async()=>"sandbox","plan-safe"
  );
  await plugin.setup({
    agent:{transform:async(callback:(e:{update:(id:string,fn:(a:{system:string})=>void)=>void})=>void)=>
      callback({update:(_id,fn)=>fn({system:""})})},
    session:{hook:async(name:string,cb:(e:Event)=>Promise<void>)=>{if(name==="context")hook=cb;}},
    tool:{transform:async(callback:(e:{remove:(id:string)=>void;add:(tool:Exposed)=>void})=>void)=>
      callback({remove:()=>undefined,add:tool=>registrations.set(tool.name,tool)})}
  } as never);
  if(!hook)throw Error("Missing actual context hook");
  const available:Event["tools"]={};
  for(const [name,tool] of registrations){
    available[name]={description:(tool as unknown as {description:string}).description ?? name,
      input:(tool as unknown as {input:object}).input ?? {}};
  }
  const event={sessionID:"ses_fixture",agent:"plan",model:{providerID:"fake",id:"fake"},tools:available};
  await hook(event);
  return {available,registrations,actions,guards,hook,event};
}
const C={sessionID:"ses_fixture",agent:"plan",id:"call",signal:new AbortController().signal};

describe("Experiment 5: plan capability preservation and defense in depth",()=>{
  test("read-only aliases still execute correct session-scoped operations",async()=>{
    const state=await fixture();
    expect(Object.keys(state.available)).toContain("repo_read");
    expect(Object.keys(state.available)).toContain("repo_info");
    expect(Object.keys(state.available)).toContain("repo_review");
    expect(Object.keys(state.available)).toContain("inspect_linux");
    expect(Object.keys(state.available)).not.toContain("github");
    expect(Object.keys(state.available)).not.toContain("linux");

    const read=await state.registrations.get("repo_read")!.execute(
      {path:"src/safe.ts",ref:"a".repeat(40)},C) as {content:string};
    const info=await state.registrations.get("repo_info")!.execute({},C) as {content:string};
    const review=await state.registrations.get("repo_review")!.execute(
      {branch:"opencode/exp5-safe"},C) as {content:string};
    const inspect=await state.registrations.get("inspect_linux")!.execute(
      {action:"list",path:""},C) as {content:string};
    expect(JSON.parse(read.content)).toMatchObject({action:"read",repo:REPO,path:"src/safe.ts"});
    expect(JSON.parse(info.content)).toMatchObject({action:"repo",repo:REPO});
    expect(JSON.parse(review.content)).toMatchObject({action:"review",repo:REPO});
    expect(JSON.parse(inspect.content)).toMatchObject({project:"sandbox",action:"list"});
    expect(state.actions.map(a=>a.action)).toEqual(["read","repo","review"]);
    expect(state.guards).toEqual([REPO,REPO,REPO,"sandbox"]);
  });

  test("hidden tools are still rejected if invoked directly in plan mode",async()=>{
    const state=await fixture();
    await expect(state.registrations.get("linux")!.execute({command:"echo test"},C))
      .rejects.toThrow("Planificación");
    await expect(state.registrations.get("github")!.execute(
      {action:"write",repo:REPO,branch:"opencode/a",path:"src/a.ts",content:"x"},C
    )).rejects.toThrow("Planificación");
    expect(state.actions).toHaveLength(0);
    expect(state.guards).toHaveLength(0);
  });

  test("generic GitHub remains available when a dedicated alias is unavailable",async()=>{
    const state=await fixture();
    const tools={...state.event.tools,
      repo_info: {description:"metadata",input:{}}};
    delete tools.repo_info;
    tools.github={description:"generic",input:{}};
    await state.hook!({...state.event,tools});
    expect(Object.keys(tools)).toContain("github");
    expect(Object.keys(tools)).not.toContain("linux");
  });
});

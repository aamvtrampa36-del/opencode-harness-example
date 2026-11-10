import { describe, expect, test } from "bun:test";
import { OpenCodeSessionSockets } from "./sockets";
import { assertScopedTool, requireSameScope, validateProjectScope, type ProjectScope } from "./project-scope";
import type { OpenCodeHarness } from "agents/harness/opencode";
import type { Connection } from "agents/lifecycle";

const repos=["aamvtrampa36-del/cdf-cloud-engine","aamvtrampa36-del/CDF-WorkBench-"];
describe("G8 bound project and repository on live socket protocol", () => {
  test("binds before submit; refuses later repository switch without calling the agent", async () => {
    let bound: ProjectScope | undefined;
    const prompts: string[]=[];
    const frames: string[]=[];
    const socket={
      tags:["opencode-session:ses_root"],readyState:1,
      send:(data:string)=>frames.push(data)
    } as unknown as Connection;
    const handle={
      setModel:async()=>undefined, setAgent:async()=>undefined,
      submit:async(text:string)=>{prompts.push(text);return{operationId:"g8-op"}},
      wait:async()=>undefined, history:async()=>[],busy:async()=>false,
      events:async()=>({start:()=>undefined,stop:async()=>undefined})
    };
    const harness={
      session:()=>handle, sessions:{list:async()=>[{id:"ses_root",busy:false}]},
      pending:async()=>[]
    } as unknown as OpenCodeHarness;
    const sockets=new OpenCodeSessionSockets(
      harness,()=>[socket as unknown as WebSocket],async()=>false,
      async()=>undefined,async()=>undefined,
      async(id,input)=>{
        expect(id).toBe("ses_root");
        const next=validateProjectScope(input,repos);
        bound=requireSameScope(bound,next);
      }
    );
    const send=async (repository:string,project:string)=>
      sockets.options().handlers.onMessage(socket,JSON.stringify({
        type:"submit",id:"test-"+project,text:"Revisa repositorio",
        model:"cloudflare",mode:"build",project,repository
      }));
    await send(repos[0],"cdf-cloud");
    expect(bound).toEqual({project:"cdf-cloud",repository:repos[0]});
    expect(prompts).toHaveLength(1);
    expect(()=>assertScopedTool(bound,{kind:"github",repo:repos[1]})).toThrow("bloqueado");
    await send(repos[1],"cdf-workbench");
    expect(prompts).toHaveLength(1);
    expect(frames.some(frame=>frame.includes("Crea una conversación nueva"))).toBe(true);
    await send(repos[0],"cdf-cloud");
    expect(prompts).toHaveLength(2);
  });
});

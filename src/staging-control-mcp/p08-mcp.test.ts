import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { test, expect } from "bun:test";
import { createStagingControlServer, type StagingSupervisor } from "./server";
import { REMOTE_SCHEMA as schema } from "./p08-remote";
test("versioned RPC MCP scopes, old backend, no fallback, no false pass", async()=>{
  const id="0000000000000001";let legacy=0, calls=0;
  const supervisor={
    async supervisedTaskStatus(){legacy++;throw Error("MUTATING_STATUS");},
    async remoteSupervisorTaskStatusSnapshot(){legacy++;return {id,status:"running"};},
    async remoteSupervisorProgress(){legacy++;return {taskId:id,nextAfter:0,pageAvailable:false};},
    async remoteSupervisorStatusV1(request:string){calls++;return {schema,id:request,workspace:null,revision:4,status:"finished",verified:true};},
    async remoteSupervisorProgressV1(request:string){calls++;return {schema,id:request,workspace:null,requestCursor:null,from:0,nextAfter:1,events:[{seq:1,type:"event"}],cursor:null,complete:true,pageAvailable:true};}
  } as unknown as StagingSupervisor;
  const server=createStagingControlServer({readHealth:async()=>Response.json({status:"ok"}),supervisor:()=>supervisor});
  const client=new Client({name:"p08-fixture",version:"1"});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
    const status=await client.callTool({name:"staging_task_status",arguments:{id,schema,afterRevision:4}});
    const json=(r:any)=>JSON.parse(r.content[0].text);
    expect(json(status)).toMatchObject({id,changed:false,verified:false,passed:false});
    const progress=await client.callTool({name:"staging_task_progress",arguments:{id,schema}});
    expect(json(progress)).toMatchObject({id,nextAfter:1,complete:true,verified:false});
    expect(calls).toBe(2);
    const bad=await client.callTool({name:"staging_task_progress",arguments:{id,schema,after:1}});
    expect(bad.isError).toBe(true);expect(calls).toBe(2);
    delete supervisor.remoteSupervisorStatusV1;
    const old=await client.callTool({name:"staging_task_status",arguments:{id,schema}});
    expect(old.isError).toBe(true);expect(json(old).code).toBe("REMOTE_SCHEMA_UNAVAILABLE");
    supervisor.remoteSupervisorProgressV1=async()=>({schema,id:"0000000000000002",workspace:null});
    const cross=await client.callTool({name:"staging_task_progress",arguments:{id,schema}});
    expect(cross.isError).toBe(true);expect(json(cross).code).toBe("REMOTE_UPSTREAM_IDENTITY_MISMATCH");
    expect(legacy).toBe(0);
  }finally{await client.close();await server.close();}
});

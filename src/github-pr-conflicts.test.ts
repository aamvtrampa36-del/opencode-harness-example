import {describe,expect,test} from "bun:test";
import {GitHubBridge} from "./github";

const repo="aamvtrampa36-del/opencode-harness-example";
const api="/repos/"+repo;
const branch="opencode/synthetic-a";
const source="main";
const shaA="a".repeat(40),shaB="b".repeat(40);
const changed="docs/opencode-agent-lab/collision.json";

function harness(options:{
  ours?:unknown[]; others?:unknown[]; otherFiles?:unknown[];
  movingRef?:boolean; observed?:string[];
  compare?:unknown; open?:unknown;
}={}){
  const calls:string[]=options.observed||[];
  let posts=0,refReads=0;
  const mock=async(url:unknown,init:RequestInit={})=>{
    const u=new URL(String(url));
    const method=init.method||"GET";const path=u.pathname+u.search;
    calls.push(method+" "+path);
    let result:unknown;
    if(path===api && method==="GET")result={full_name:repo,default_branch:source,private:false};
    else if(path.startsWith(api+"/git/ref/heads/")){refReads++;result={object:{sha:options.movingRef&&refReads>=3?"c".repeat(40):path.endsWith("main")?shaB:shaA}};}
    else if(path.startsWith(api+"/compare/"))result=options.compare??{
      total_commits:1,ahead_by:1,files:options.ours??[{filename:changed,status:"added"}]};
    else if(path.startsWith(api+"/pulls?")&&method==="GET")result=options.open??(options.others??[]).map(
      (p:any)=>({number:p.number,base:{ref:source},head:{ref:p.branch||"other-branch"}}));
    else if(/\/pulls\/\d+\/files\?/.test(path))result=options.otherFiles??[];
    else if(path===api+"/pulls"&&method==="POST"){posts++;result={number:700,html_url:"https://github.com/"+repo+"/pull/700",draft:true};}
    else return new Response(JSON.stringify({message:"unexpected route "+method+" "+path}),{status:404});
    return new Response(JSON.stringify(result),{status:method==="POST"?201:200});
  };
  return {bridge:new GitHubBridge("synthetic-test",mock as typeof fetch),calls,posts:()=>posts};
}

describe("automatic GitHub PR writer-scope preflight",()=>{
 test("rejects overlapping real changed files before GitHub PR POST",async()=>{
   const h=harness({others:[{number:42}],otherFiles:[{filename:changed,status:"modified"}]});
   await expect(h.bridge.execute({action:"pr",repo,branch,title:"Synthetic competing writer"}))
     .rejects.toThrow("PR_WRITE_SCOPE_CONFLICT");
   expect(h.posts()).toBe(0);
   expect(h.calls.some(x=>x.includes("/compare/"))).toBe(true);
 });
 test("allows isolated nonoverlapping writes; verifies base and branch refs",async()=>{
   const h=harness({others:[{number:42}],otherFiles:[{filename:"docs/independent.json"}]});
   const result:any=await h.bridge.execute({action:"pr",repo,branch,title:"Independent synthetic change"});
   expect(result.number).toBe(700);
   expect(h.posts()).toBe(1);
   expect(h.calls.some(x=>x.includes("/pulls/42/files?"))).toBe(true);
   expect(h.calls.filter(x=>x.includes("/git/ref/heads/")).length).toBe(4);
 });
 test("rejects a previously opened PR for same branch",async()=>{
   const h=harness({others:[{number:42,branch}]});
   await expect(h.bridge.execute({action:"pr",repo,branch,title:"Duplicate"}))
     .rejects.toThrow("PR_ALREADY_OPEN");
   expect(h.posts()).toBe(0);
 });
 test("fails closed on truncated GitHub Compare API response",async()=>{
   const h=harness({compare:{total_commits:251,ahead_by:1,files:[{filename:changed}]}});
   await expect(h.bridge.execute({action:"pr",repo,branch,title:"Partial history"}))
     .rejects.toThrow("PR_PREFLIGHT_INCOMPLETE");
   expect(h.posts()).toBe(0);
 });
 test("fails closed on truncated file lists from another PR",async()=>{
   const h=harness({others:[{number:42}],otherFiles:Array.from({length:100},(_,i)=>({filename:"other/file-"+i}))});
   await expect(h.bridge.execute({action:"pr",repo,branch,title:"Partial competing diff"}))
     .rejects.toThrow("PR_PREFLIGHT_INCOMPLETE");
   expect(h.posts()).toBe(0);
 });
 test("stale branch SHA blocks PR creation after preflight",async()=>{
   const h=harness({movingRef:true});
   await expect(h.bridge.execute({action:"pr",repo,branch,title:"Stale synthetic review"}))
     .rejects.toThrow("PR_PREFLIGHT_STALE");
   expect(h.posts()).toBe(0);
 });
 test("renamed source path is also a collision",async()=>{
   const h=harness({others:[{number:42}],otherFiles:[{filename:"docs/new.json",previous_filename:changed,status:"renamed"}]});
   await expect(h.bridge.execute({action:"pr",repo,branch,title:"Rename collision"}))
     .rejects.toThrow("PR_WRITE_SCOPE_CONFLICT");
   expect(h.posts()).toBe(0);
 });
});

describe("draft PR receipt reconciliation after ambiguous GitHub responses",()=>{
  test("reuses only an open PR with the exact branch, SHA, base, title and body",async()=>{
    const title="Synthetic verified receipt",body="T08 deterministic intent";
    const previous={number:77,base:{ref:source,sha:shaB},
      head:{ref:branch,sha:shaA,repo:{full_name:repo}},
      title,body,draft:true,html_url:"https://github.com/"+repo+"/pull/77"};
    const h=harness({open:[previous]});
    const result:any=await h.bridge.execute({action:"pr",repo,branch,title,body});
    expect(result).toMatchObject({number:77,reconciled:true,headSha:shaA});
    expect(h.posts()).toBe(0);
  });

  test("rejects a same-branch PR with different intent, head or repository",async()=>{
    const title="Expected intent",body="Expected payload";
    const base={number:77,base:{ref:source,sha:shaB},
      head:{ref:branch,sha:shaA,repo:{full_name:repo}},
      title,body,draft:true,html_url:"https://github.com/"+repo+"/pull/77"};
    for(const previous of [
      {...base,body:"Changed payload"},
      {...base,head:{...base.head,sha:"c".repeat(40)}},
      {...base,head:{...base.head,repo:{full_name:"other/fork"}}},
      {...base,draft:false}
    ]){
      const h=harness({open:[previous]});
      await expect(h.bridge.execute({action:"pr",repo,branch,title,body}))
        .rejects.toThrow("PR_ALREADY_OPEN");
      expect(h.posts()).toBe(0);
    }
  });

  test("lost 503 response after POST is reconciled, without a second POST",async()=>{
    const title="Lost response",body="Deterministic draft";
    let opened:any=null,posts=0;
    const mock=async(url:unknown,init:RequestInit={})=>{
      const u=new URL(String(url)),method=init.method||"GET",path=u.pathname+u.search;
      if(method==="GET" && path===api)
        return Response.json({default_branch:source});
      if(method==="GET" && path.startsWith(api+"/git/ref/heads/"))
        return Response.json({object:{sha:path.endsWith("/main")?shaB:shaA}});
      if(method==="GET" && path.startsWith(api+"/compare/"))
        return Response.json({total_commits:1,ahead_by:1,files:[{filename:changed}]});
      if(method==="GET" && path.startsWith(api+"/pulls?"))
        return Response.json(opened?[opened]:[]);
      if(method==="POST" && path===api+"/pulls"){
        posts++;
        opened={number:78,base:{ref:source,sha:shaB},
          head:{ref:branch,sha:shaA,repo:{full_name:repo}},
          title,body,draft:true,html_url:"https://github.com/"+repo+"/pull/78"};
        return Response.json({message:"upstream reply lost"},{status:503});
      }
      return Response.json({message:"unexpected request"},{status:404});
    };
    const bridge=new GitHubBridge("synthetic-test",mock as typeof fetch);
    await expect(bridge.execute({action:"pr",repo,branch,title,body}))
      .rejects.toThrow("GITHUB_TRANSIENT");
    const receipt:any=await bridge.execute({action:"pr",repo,branch,title,body});
    expect(receipt).toMatchObject({number:78,reconciled:true});
    expect(posts).toBe(1);
  });
});

describe("T08 bounded concurrent-writer exposure",()=>{
  test("two simultaneous PR preflights can each miss the other (not an atomic lock)",async()=>{
    const first="opencode/synthetic-a",second="opencode/synthetic-b";
    let arrivals=0,release!:()=>void,posts=0;
    const bothPreflighted=new Promise<void>(resolve=>{release=resolve;});
    const mock=async(url:unknown,init:RequestInit={})=>{
      const u=new URL(String(url)),method=init.method||"GET",path=u.pathname+u.search;
      if(method==="GET" && path===api)return Response.json({default_branch:source});
      if(method==="GET" && path.startsWith(api+"/git/ref/heads/"))
        return Response.json({object:{sha:path.endsWith("/main")?shaB:shaA}});
      if(method==="GET" && path.startsWith(api+"/compare/"))
        return Response.json({total_commits:1,ahead_by:1,files:[{filename:changed}]});
      if(method==="GET" && path.startsWith(api+"/pulls?")){
        if(++arrivals===2)release();
        await bothPreflighted;
        return Response.json([]);
      }
      if(method==="POST" && path===api+"/pulls"){
        posts++;
        return Response.json({number:posts+100,html_url:"https://github.com/"+repo+"/pull/synthetic",draft:true},{status:201});
      }
      return Response.json({message:"unexpected request"},{status:404});
    };
    const bridge=new GitHubBridge("synthetic-test",mock as typeof fetch);
    const result=await Promise.all([
      bridge.execute({action:"pr",repo,branch:first,title:"Writer A"}),
      bridge.execute({action:"pr",repo,branch:second,title:"Writer B"})
    ]);
    expect(result).toHaveLength(2);
    expect(arrivals).toBe(2);
    expect(posts).toBe(2); // Known TOCTOU defect; not a claim of safe arbitration.
  });
});

describe("T08 ten independent synthetic branches",()=>{
  test("keeps ten disjoint PR intents separate with no cross-file overlap",async()=>{
    const names=Array.from({length:10},(_,i)=>"opencode/synthetic-t"+String(i).padStart(2,"0"));
    const opened:Array<{number:number;branch:string;file:string}>=[];
    let posts=0;
    const mock=async(url:unknown,init:RequestInit={})=>{
      const u=new URL(String(url)),method=init.method||"GET",path=u.pathname+u.search;
      if(method==="GET" && path===api)return Response.json({default_branch:source});
      if(method==="GET" && path.startsWith(api+"/git/ref/heads/"))
        return Response.json({object:{sha:path.endsWith("/main")?shaB:shaA}});
      if(method==="GET" && path.startsWith(api+"/compare/")){
        const entry=names.find(name=>decodeURIComponent(path).endsWith("..."+name));
        if(!entry)throw new Error("Unexpected compare branch: "+path);
        return Response.json({total_commits:1,ahead_by:1,
          files:[{filename:"docs/f0-c10/synthetic/"+entry.split("/")[1]+".json"}]});
      }
      if(method==="GET" && path.startsWith(api+"/pulls?"))
        return Response.json(opened.map(item=>({number:item.number,base:{ref:source},
          head:{ref:item.branch}})));
      if(method==="GET" && /\/pulls\/\d+\/files\?/.test(path)){
        const number=Number(/\/pulls\/(\d+)\/files/.exec(path)?.[1]);
        const found=opened.find(item=>item.number===number);
        return Response.json(found?[{filename:found.file}]:[]);
      }
      if(method==="POST" && path===api+"/pulls"){
        const payload=JSON.parse(String(init.body));
        const number=200+(++posts);
        opened.push({number,branch:payload.head,
          file:"docs/f0-c10/synthetic/"+payload.head.split("/")[1]+".json"});
        return Response.json({number,html_url:"https://github.com/"+repo+"/pull/"+number,draft:true},{status:201});
      }
      return Response.json({message:"unexpected request"},{status:404});
    };
    const bridge=new GitHubBridge("synthetic-test",mock as typeof fetch);
    const receipts:any[]=[];
    for(const name of names)
      receipts.push(await bridge.execute({action:"pr",repo,branch:name,title:"Synthetic "+name}));
    expect(receipts.map(r=>r.head)).toEqual(names);
    expect(new Set(receipts.map(r=>r.number)).size).toBe(10);
    expect(new Set(opened.map(p=>p.file)).size).toBe(10);
    expect(posts).toBe(10);
  });
});

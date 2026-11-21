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

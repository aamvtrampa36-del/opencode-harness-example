import {describe, expect, test} from "bun:test";
import {GitHubBridge, OPENCODE_STAGING_BASE} from "./github";
import {DurableGitHubPublicationGate, assertSupervisedPublicationScope} from "./github-publication-durable";

const repo="aamvtrampa36-del/opencode-harness-example";
const api="/repos/"+repo;
const seed="b".repeat(40);
const branch=(id:number)=>"opencode/staging-"+id.toString(16).padStart(16,"0");
const uniquePath=(id:number)=>"docs/opencode-agent-lab/r3-t08-"+id+".json";

class TxStorage {
  private data=new Map<string,unknown>();
  private tail:Promise<unknown>=Promise.resolve();
  transaction<T>(action:(tx:TxStorage)=>Promise<T>):Promise<T>{
    const next=this.tail.then(async()=>{
      const staged=new TxStorage();
      staged.data=new Map(structuredClone([...this.data]));
      const result=await action(staged);
      this.data=staged.data;
      return result;
    });
    this.tail=next.catch(()=>{});
    return next;
  }
  async get<T>(k:string):Promise<T|undefined>{return structuredClone(this.data.get(k)) as T|undefined;}
  async put<T>(k:string,value:T){this.data.set(k,structuredClone(value));}
  asDO():DurableObjectStorage{return this as unknown as DurableObjectStorage;}
  receipts(){return [...this.data.keys()].filter(x=>x.includes(":branch:")).length;}
}
function deferred(){
  let release!:()=>void;
  const promise=new Promise<void>(r=>{release=r;});
  return {promise,release};
}
type BlobRow={text:string;sha:string};
type PrRow={number:number;html_url:string;draft:true;state:"open";
  title:string;body:string;head:{ref:string;sha:string;repo:{full_name:string}};
  base:{ref:string;sha:string};files:string[]};
class StatefulGitHub {
  readonly refs=new Map<string,string>([[OPENCODE_STAGING_BASE,seed],["main",seed]]);
  readonly contents=new Map<string,BlobRow>();
  readonly prs:PrRow[]=[];
  readonly trace:Array<{method:string;path:string;effect?:string}>=[];
  branchCreates=0;
  filePuts=0;
  commitEffects=0;
  prPosts=0;
  private counter=1;
  private lostRef=false;
  private lostPut=false;
  private lostPr=false;
  private pausePr=false;
  readonly reachedPost=deferred();
  readonly resumePost=deferred();
  simulateLoss(options:{ref?:boolean;put?:boolean;pr?:boolean}){
    this.lostRef=Boolean(options.ref);
    this.lostPut=Boolean(options.put);
    this.lostPr=Boolean(options.pr);
  }
  holdFirstPr(){this.pausePr=true;}
  private nextSha(){return (this.counter++).toString(16).padStart(40,"0");}
  readonly http=(async (url:unknown,init:RequestInit={})=>{
    const u=new URL(String(url)),method=init.method||"GET",p=u.pathname;
    const log=(effect?:string)=>this.trace.push({method,path:p+u.search,...(effect?{effect}:{})});
    const json=(v:unknown,status=200)=>Response.json(v,{status});
    const fail=(code:number,message:string)=>json({message},code);
    if(method==="GET"&&p===api){log();return json({full_name:repo,default_branch:"main"});}
    if(method==="GET"&&p.startsWith(api+"/git/ref/heads/")){
      log();const name=decodeURIComponent(p.slice((api+"/git/ref/heads/").length));
      const sha=this.refs.get(name);
      return sha?json({object:{sha}}):fail(404,"not found");
    }
    if(method==="POST"&&p===api+"/git/refs"){
      const b=JSON.parse(String(init.body)),name=String(b.ref).replace(/^refs\/heads\//,"");
      if(this.refs.has(name))return fail(422,"already exists");
      if(!this.refs.has(OPENCODE_STAGING_BASE)||b.sha!==seed)return fail(409,"unexpected base");
      this.refs.set(name,b.sha);this.branchCreates++;log("create-ref");
      if(this.lostRef){this.lostRef=false;return fail(503,"reply lost after create");}
      return json({ref:b.ref,object:{sha:b.sha}},201);
    }
    if(p.startsWith(api+"/contents/")){
      const path=decodeURIComponent(p.slice((api+"/contents/").length));
      const name=u.searchParams.get("ref")||"";
      if(method==="GET"){
        log();const item=this.contents.get(name+"::"+path);
        return item?json({type:"file",encoding:"base64",content:btoa(item.text),
          size:new TextEncoder().encode(item.text).length,sha:item.sha}):fail(404,"no file");
      }
      if(method==="PUT"){
        const b=JSON.parse(String(init.body)),ref=String(b.branch);
        const before=this.contents.get(ref+"::"+path);
        if(!this.refs.has(ref))return fail(404,"branch missing");
        if(before?.sha!==b.sha && (before||b.sha))return fail(409,"blob SHA conflict");
        const row={text:atob(b.content),sha:this.nextSha()};
        const commit=this.nextSha();
        this.contents.set(ref+"::"+path,row);
        this.refs.set(ref,commit);
        this.filePuts++;this.commitEffects++;log("contents-put");
        if(this.lostPut){this.lostPut=false;return fail(503,"reply lost after commit");}
        return json({commit:{sha:commit},content:{sha:row.sha}},200);
      }
    }
    if(method==="GET"&&p.startsWith(api+"/compare/")){
      log();const s=decodeURIComponent(p.slice((api+"/compare/").length));
      const [left,right]=s.split("...");
      const files=[...this.contents.keys()].filter(x=>x.startsWith(right+"::"))
        .map(x=>({filename:x.slice(right.length+2),status:"added"}));
      return this.refs.has(left)&&this.refs.has(right)?
        json({ahead_by:files.length,total_commits:files.length,files}):
        fail(404,"unknown compare ref");
    }
    if(method==="GET"&&p===api+"/pulls"){
      log();
      return json(this.prs.filter(x=>(u.searchParams.get("state")==="all"||x.state==="open")&&
        (!u.searchParams.get("base")||u.searchParams.get("base")===x.base.ref)&&
        (!u.searchParams.get("head")||u.searchParams.get("head")===
          "aamvtrampa36-del:"+x.head.ref)));
    }
    if(method==="GET"&&/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.test(p)){
      log();const num=Number(p.split("/").at(-2));
      const found=this.prs.find(x=>x.number===num);
      return found?json(found.files.map(filename=>({filename,status:"added"}))):fail(404,"no PR");
    }
    if(method==="POST"&&p===api+"/pulls"){
      const b=JSON.parse(String(init.body)),sha=this.refs.get(b.head),baseSha=this.refs.get(b.base);
      if(!sha||!baseSha)return fail(404,"unknown branch");
      const number=7000+this.prPosts+1;
      const files=[...this.contents.keys()].filter(x=>x.startsWith(b.head+"::"))
        .map(x=>x.slice(b.head.length+2));
      const obj:PrRow={number,html_url:"https://github.com/"+repo+"/pull/"+number,
        draft:true,state:"open",title:b.title,body:b.body,
        head:{ref:b.head,sha,repo:{full_name:repo}},
        base:{ref:b.base,sha:baseSha},files};
      this.prs.push(obj);this.prPosts++;log("pr-post");
      if(this.pausePr){this.pausePr=false;this.reachedPost.release();await this.resumePost.promise;}
      if(this.lostPr){this.lostPr=false;return fail(503,"reply lost after POST");}
      return json(obj,201);
    }
    log();return fail(404,"unexpected "+method+" "+p);
  }) as typeof fetch;
}
function client(s:TxStorage,h:StatefulGitHub){
  return new GitHubBridge("synthetic-only",h.http,[repo],
    new DurableGitHubPublicationGate(s.asDO()));
}
describe("R3-T08 stateful branch/commit/PR writer isolation (no GitHub network)",()=>{
  test("ten competing requests: 10 isolated branches, file commits, PR receipts; zero cross writes",async()=>{
    const store=new TxStorage(),g=new StatefulGitHub();
    const names=Array.from({length:10},(_,i)=>branch(i+1));
    const branches=await Promise.all(names.map(name=>client(store,g).ensureSupervisorBranch(repo,name)));
    expect(branches.map(x=>x.sha)).toEqual(Array(10).fill(seed));
    expect(g.branchCreates).toBe(10);
    const writes=await Promise.all(names.map((name,i)=>client(store,g).execute({
      action:"write",repo,branch:name,path:uniquePath(i+1),
      content:JSON.stringify({requestId:(i+1).toString(16).padStart(16,"0"),i:i+1})
    })));
    expect(writes).toHaveLength(10);
    expect(g.filePuts).toBe(10);
    expect(g.commitEffects).toBe(10);
    expect(new Set(names.map(name=>g.refs.get(name))).size).toBe(10);
    g.holdFirstPr();
    const one=client(store,g).execute({action:"pr",repo,branch:names[0],title:"Task 1"});
    await g.reachedPost.promise;
    const blocked=await Promise.allSettled(names.slice(1).map((name,i)=>client(store,g).execute({
      action:"pr",repo,branch:name,title:"Task "+(i+2)
    })));
    expect(blocked.filter(x=>x.status==="rejected")).toHaveLength(9);
    for(const x of blocked)if(x.status==="rejected")
      expect(String(x.reason)).toContain("PR_PUBLICATION_BUSY_UNKNOWN");
    expect(g.prPosts).toBe(1);
    g.resumePost.release();
    const receipts:any[]=[await one];
    // These were denied BEFORE their external effect; the same exact
    // intents may be resubmitted after the first publisher completed.
    for(let i=1;i<10;i++)
      receipts.push(await client(store,g).execute({action:"pr",repo,branch:names[i],title:"Task "+(i+1)}));
    expect(g.prPosts).toBe(10);
    expect(g.prs).toHaveLength(10);
    expect(store.receipts()).toBe(10);
    expect(new Set(receipts.map(x=>x.number)).size).toBe(10);
    expect(new Set(g.prs.map(x=>x.head.ref))).toEqual(new Set(names));
    expect(new Set(g.prs.flatMap(x=>x.files)).size).toBe(10);
    for(let i=0;i<10;i++){
      expect(g.prs[i]?.files).toEqual([uniquePath(i+1)]);
      expect(g.prs[i]?.head.sha).toBe(g.refs.get(names[i]));
    }
    expect(g.refs.get("main")).toBe(seed);
    expect(g.refs.get(OPENCODE_STAGING_BASE)).toBe(seed);
    expect(g.trace.filter(x=>x.effect==="create-ref")).toHaveLength(10);
    expect(g.trace.filter(x=>x.effect==="contents-put")).toHaveLength(10);
    expect(g.trace.filter(x=>x.effect==="pr-post")).toHaveLength(10);
  });
  test("identical requestId/branch after lost ref, lost PUT and lost PR never doubles effects",async()=>{
    const s=new TxStorage(),g=new StatefulGitHub(),name=branch(17),path=uniquePath(17);
    g.simulateLoss({ref:true});
    const created=await client(s,g).ensureSupervisorBranch(repo,name);
    expect(created.reused).toBe(true);
    const duplicate=await client(s,g).ensureSupervisorBranch(repo,name);
    expect(duplicate.reused).toBe(true);
    expect(g.branchCreates).toBe(1);
    g.simulateLoss({put:true});
    const payload=JSON.stringify({requestId:"0000000000000011",result:"verified"});
    await expect(client(s,g).execute({action:"write",repo,branch:name,path,content:payload}))
      .rejects.toThrow("GITHUB_TRANSIENT");
    const updated:any=await client(s,g).execute({action:"write",repo,branch:name,path,content:payload});
    expect(updated).toMatchObject({unchanged:true,reconciled:true});
    expect(g.filePuts).toBe(1);expect(g.commitEffects).toBe(1);
    g.simulateLoss({pr:true});
    const request={action:"pr" as const,repo,branch:name,title:"Same requestId",body:"Same payload"};
    await expect(client(s,g).execute(request)).rejects.toThrow("GITHUB_TRANSIENT");
    const receipt:any=await client(s,g).execute(request);
    const again:any=await client(s,g).execute(request);
    expect(receipt.number).toBe(again.number);
    expect(receipt.reconciled).toBe(true);
    expect(g.prPosts).toBe(1);
    expect(g.prs).toHaveLength(1);
    expect(s.receipts()).toBe(1);
    await expect(client(s,g).execute({...request,title:"Different"}))
      .rejects.toThrow("PR_BRANCH_INTENT_CONFLICT");
    expect(g.prPosts).toBe(1);
  });
  test("same destination: competing full-file PUTs cannot overwrite or cross branches",async()=>{
    const s=new TxStorage(),g=new StatefulGitHub(),name=branch(21),path=uniquePath(21);
    await client(s,g).ensureSupervisorBranch(repo,name);
    const pair=await Promise.allSettled(["A","B"].map(content=>
      client(s,g).execute({action:"write",repo,branch:name,path,content})));
    expect(pair.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    expect(pair.filter(x=>x.status==="rejected")).toHaveLength(1);
    expect(g.filePuts).toBe(1);
    expect(g.commitEffects).toBe(1);
    const row=g.contents.get(name+"::"+path);
    expect(["A","B"]).toContain(row?.text);
    expect(g.refs.get("main")).toBe(seed);
    expect(g.refs.get(OPENCODE_STAGING_BASE)).toBe(seed);
  });
  test("authorized branch writes cannot target main, Staging or other repository",async()=>{
    const s=new TxStorage(),g=new StatefulGitHub(),c=client(s,g);
    await expect(c.execute({action:"write",repo,branch:"main",path:"src/safe.ts",content:"hi"}))
      .rejects.toThrow("review branch");
    await expect(c.execute({action:"write",repo,branch:OPENCODE_STAGING_BASE,
      path:"src/safe.ts",content:"hi"})).rejects.toThrow("review branch");
    await expect(c.execute({action:"branch",repo,branch:"main"}))
      .rejects.toThrow("review branch");
    await expect(c.execute({action:"pr",repo,branch:"main",title:"Unauthorized"}))
      .rejects.toThrow("review branch");
    await expect(c.execute({action:"write",repo:"other/repo",branch:branch(1),
      path:"safe.txt",content:"hi"})).rejects.toThrow("authorized GitHub account");
    expect(g.trace).toHaveLength(0);
    expect(g.branchCreates+g.filePuts+g.prPosts).toBe(0);
  });
});

describe("R3-T08 conflict semantics and cross-owner rejection",()=>{
  test("two independent branches modifying the same filename keep blobs but second PR is rejected",async()=>{
    const s=new TxStorage(),g=new StatefulGitHub(),path="docs/shared/output.json";
    const a=branch(31),b=branch(32);
    await Promise.all([a,b].map(name=>client(s,g).ensureSupervisorBranch(repo,name)));
    await Promise.all([[a,"producer A"],[b,"producer B"]].map(([name,content])=>
      client(s,g).execute({action:"write",repo,branch:name,path,content})));
    expect(g.contents.get(a+"::"+path)?.text).toBe("producer A");
    expect(g.contents.get(b+"::"+path)?.text).toBe("producer B");
    expect(g.filePuts).toBe(2);
    expect(g.commitEffects).toBe(2);
    await client(s,g).execute({action:"pr",repo,branch:a,title:"Writer A"});
    await expect(client(s,g).execute({action:"pr",repo,branch:b,title:"Writer B"}))
      .rejects.toThrow("PR_WRITE_SCOPE_CONFLICT");
    expect(g.prPosts).toBe(1);
    expect(g.prs).toHaveLength(1);
    expect(g.prs[0]?.files).toEqual([path]);
  });
  test("supervisor denies foreign session/task/project/branch before publication",()=>{
    const id="0000000000000029",ownerBranch="opencode/staging-"+id;
    const task={id,repository:repo,branch:ownerBranch,project:"supervised-"+id,
      session:"ses_owner",status:"running"};
    const input={repo,branch:ownerBranch,action:"pr"};
    expect(()=>assertSupervisedPublicationScope(input,"ses_owner",task)).not.toThrow();
    expect(()=>assertSupervisedPublicationScope(input,"ses_foreign",task))
      .toThrow("PR_PUBLICATION_SESSION_SCOPE_DENIED");
    expect(()=>assertSupervisedPublicationScope({...input,branch:branch(30)},"ses_owner",task))
      .toThrow("PR_PUBLICATION_SESSION_SCOPE_DENIED");
    expect(()=>assertSupervisedPublicationScope(input,"ses_owner",
      {...task,project:"supervised-another"}))
      .toThrow("PR_PUBLICATION_SESSION_SCOPE_DENIED");
    expect(()=>assertSupervisedPublicationScope({...input,repo:"aamvtrampa36-del/another"},"ses_owner",task))
      .toThrow("PR_PUBLICATION_SESSION_SCOPE_DENIED");
    expect(()=>assertSupervisedPublicationScope(input,"ses_owner",{...task,status:"cancelled"}))
      .toThrow("PR_PUBLICATION_SESSION_SCOPE_DENIED");
  });
});

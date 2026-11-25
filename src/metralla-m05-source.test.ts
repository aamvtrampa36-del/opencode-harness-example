import { test, expect } from "bun:test";
import { GitHubBridge } from "./github";
import { githubSourceArchive, sourceReceiptMatches } from "./github-import";
import { githubRepositoryDownload } from "./github-download";
import { validateProjectScope, bindPinnedGitHubScope, requirePinnedGitHubScope, requireSameScope, assertScopedTool } from "./project-scope";
import { githubRestNoRedirect, githubArchiveResponse, freezeGitHubSourcePin } from "./metralla-m05-source";

const repo="aamvtrampa36-del/opencode-harness-example", commit="a".repeat(40), tree="b".repeat(40);
const branch="opencode/staging-0123456789abcdef", base="staging/source";
const pin=freezeGitHubSourcePin({repo,commit,tree,branch,base,paths:["src/client.ts"]});
const loc="https://codeload.github.com/"+repo+"/legacy.tar.gz/"+commit+"?token=temporary";

test("P16 all REST routes reject redirects before any replay (GET and POST)",async()=>{
  for(const method of ["GET","POST"]) for(const status of [300,301,302,303,304,307,308,399]){
    let calls=0;
    const http=(async(_url:any,init:any)=>{calls++;expect(init.redirect).toBe("manual");expect(init.method).toBe(method);return new Response(null,{status,headers:{Location:"https://foreign.invalid/secret"}})}) as typeof fetch;
    await expect(githubRestNoRedirect(http,"https://api.github.com/test",{method,headers:{Authorization:"Bearer fake"}})).rejects.toThrow("redirect refused");
    expect(calls).toBe(1);
  }
  let calls=0;
  const bridge=new GitHubBridge("fake",(async(_u:any,init:any)=>{calls++;expect(init.redirect).toBe("manual");return new Response(null,{status:302,headers:{Location:"https://foreign.invalid"}})}) as typeof fetch,[repo]);
  await expect(bridge.execute({action:"repo",repo})).rejects.toThrow("redirect refused");
  expect(calls).toBe(1);
});
test("P16 bounded archive handoff checks repo and SHA and strips bearer; second hop rejected",async()=>{
  const calls: any[]=[];
  const http=(async(url:any,init:any)=>{calls.push({url:String(url),init});return calls.length===1?new Response(null,{status:302,headers:{Location:loc}}):new Response("bytes")}) as typeof fetch;
  const r=await githubArchiveResponse(http,repo,"tarball",{Authorization:"Bearer fake"},new AbortController().signal,commit);
  expect(await r.text()).toBe("bytes");expect(calls).toHaveLength(2);
  expect(calls.every(c=>c.init.redirect==="manual")).toBe(true);
  expect(new Headers(calls[1].init.headers).has("Authorization")).toBe(false);
  for(const target of [loc.replace(repo,"aamvtrampa36-del/other"),loc.replace(commit,"c".repeat(40)),loc.replace("codeload.github.com","evil.invalid")]){
    let n=0;const f=(async()=>{n++;return new Response(null,{status:302,headers:{Location:target}})}) as typeof fetch;
    await expect(githubArchiveResponse(f,repo,"tarball",{},new AbortController().signal,commit)).rejects.toThrow("no autorizada");expect(n).toBe(1);
  }
  let n=0;const f=(async()=>{n++;return new Response(null,{status:302,headers:{Location:loc}})}) as typeof fetch;
  await expect(githubArchiveResponse(f,repo,"tarball",{},new AbortController().signal,commit)).rejects.toThrow("archivo temporal");expect(n).toBe(2);
});
test("P16 ZIP never follows a credentialed redirect or crosses repositories",async()=>{
  let n=0;const http=(async(_url:any,init:any)=>{n++;expect(init.redirect).toBe("manual");return new Response(null,{status:302,headers:{Location:"https://evil.invalid/zip"}})}) as typeof fetch;
  const r=await githubRepositoryDownload(repo,"fake",[repo],http);
  expect(r.status).toBe(502);expect(n).toBe(1);expect(r.headers.get("content-disposition")).toBeNull();
});
test("P16 server-owned pin stripped from client, exact scope and no path widening",()=>{
  const scope=validateProjectScope({project:"repo-opencode",repository:repo,githubSource:pin},[repo]);
  expect(scope.githubSource).toBeUndefined();
  expect(()=>requireSameScope(undefined,{...scope,githubSource:pin})).toThrow("SCOPE_MISMATCH");
  const bound=bindPinnedGitHubScope(scope,pin);
  expect(requirePinnedGitHubScope(bound,pin)).toEqual(pin);
  expect(()=>assertScopedTool(bound,{kind:"github",repo,operation:"write",branch,path:"src/client.ts"})).not.toThrow();
  for(const path of ["../src/client.ts","src/other.ts"])expect(()=>assertScopedTool(bound,{kind:"github",repo,operation:"write",branch,path})).toThrow("SCOPE_PATH");
  expect(()=>assertScopedTool(bound,{kind:"github",repo,operation:"write",branch:"main",path:"src/client.ts"})).toThrow("SCOPE_BRANCH");
  expect(()=>requirePinnedGitHubScope(bound,{...pin,tree:"c".repeat(40)})).toThrow("SCOPE_MISMATCH");
});
test("P16 source identity divergent stops before branch POST; unknown stays unknown",async()=>{
  for(const mode of ["tree","base","unknown","lost-confirmed"]){
    let posts=0,reads=0;
    const http=(async(input:any,init:any)=>{const url=String(input);expect(init.redirect).toBe("manual");
      if(url.endsWith("/"+repo))return Response.json({full_name:repo,default_branch:"main"});
      if(url.endsWith("/git/ref/heads/"+encodeURIComponent(base)))return Response.json({object:{sha:mode==="base"?"c".repeat(40):commit}});
      if(url.endsWith("/commits/"+commit))return Response.json({sha:commit,commit:{tree:{sha:mode==="tree"?"c".repeat(40):tree}}});
      if(url.endsWith("/git/ref/heads/"+encodeURIComponent(branch))){reads++;return mode==="lost-confirmed"&&posts?Response.json({object:{sha:commit}}):new Response("{}",{status:404})}
      if(url.endsWith("/git/refs")&&init.method==="POST"){posts++;throw Error("lost response")}
      throw Error("unexpected");
    }) as typeof fetch;
    const bridge=new GitHubBridge("fake",http,[repo],undefined,undefined,pin);
    if(mode==="lost-confirmed"){expect(await bridge.ensureSupervisorBranch(repo,branch)).toMatchObject({sha:commit,reused:true});expect(posts).toBe(1);expect(reads).toBe(2)}
    else {await expect(bridge.ensureSupervisorBranch(repo,branch)).rejects.toThrow(mode==="unknown"?"EFFECT_UNKNOWN":"IDENTITY_DIVERGENT");expect(posts).toBe(mode==="unknown"?1:0)}
  }
});
test("P16 certified import rejects wrong tree and failed download, never certifies stream bytes itself",async()=>{
  for(const mode of ["wrong-tree","failed-archive"]){
    let archives=0;
    const http=(async(input:any)=>{const url=String(input);
      if(url.endsWith("/"+repo))return Response.json({full_name:repo,default_branch:"main"});
      if(url.endsWith("/commits/"+commit))return Response.json({sha:commit,commit:{tree:{sha:mode==="wrong-tree"?"c".repeat(40):tree}}});
      archives++;return new Response("{}",{status:503});
    }) as typeof fetch;
    await expect(githubSourceArchive(repo,"fake",[repo],http,commit,tree)).rejects.toThrow(mode==="wrong-tree"?"árbol de origen":"descargar");
    expect(archives).toBe(mode==="wrong-tree"?0:1);
  }
  expect(sourceReceiptMatches({commit,tree},commit,tree)).toBe(false);
  expect(sourceReceiptMatches({commit,tree},undefined,tree)).toBe(false);
});

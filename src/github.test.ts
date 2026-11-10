import { describe, expect, test } from "bun:test";
import { GitHubBridge } from "./github";

const calls: Array<{url:string; method:string; body?:any; headers:Headers}> = [];
const fake = (async (url: any, init: any = {}) => {
  const route = String(url);
  calls.push({url:route, method:init.method||"GET", body:init.body?JSON.parse(init.body):undefined, headers:new Headers(init.headers||{})});
  let status=200;
  let body:any={};
  if (route.endsWith("/repos/aamvtrampa36-del/cdf-cloud-engine")) {
    body={full_name:"aamvtrampa36-del/cdf-cloud-engine",default_branch:"main",private:true};
  } else if (route.endsWith("/git/ref/heads/main")) {
    body={object:{sha:"basecommit"}};
  } else if (route.endsWith("/git/refs")) {
    status=201;body={ref:"refs/heads/opencode/new-feature",object:{sha:"basecommit"}};
  } else if (route.includes("/contents/docs/test.md?ref=opencode%2Fnew-feature")) {
    status=404;body={message:"Not Found"};
  } else if (route.endsWith("/contents/docs/test.md")) {
    body={commit:{sha:"newcommit"},content:{sha:"filehash"}};
  } else if (route.endsWith("/pulls")) {
    status=201;body={number:12,html_url:"https://github.com/example/pull/12",draft:true};
  } else {
    status=404;body={message:"Not Found"};
  }
  return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
}) as typeof fetch;
const api = new GitHubBridge("dummy-test-key",fake);

describe("GitHub scoped permissions",()=>{
  test("reject unknown repos before any HTTP request",async()=>{
    calls.length=0;
    await expect(api.execute({action:"repo",repo:"other/production"})).rejects.toThrow("authorized GitHub account");
    expect(calls.length).toBe(0);
  });
  test("explicit additional repository is allowed, but only for this owner's account",async()=>{
    calls.length=0;
    const dynamic = new GitHubBridge("dummy-test-key",fake,["aamvtrampa36-del/new-project"]);
    await expect(dynamic.execute({action:"repo",repo:"aamvtrampa36-del/cdf-cloud-engine"}))
      .rejects.toThrow("not authorized");
    await expect(dynamic.execute({action:"repo",repo:"other-account/new-project"}))
      .rejects.toThrow("authorized GitHub account");
    expect(calls.length).toBe(0);
    // The grant bypasses only the local allowlist; GitHub still decides access.
    await expect(dynamic.execute({action:"repo",repo:"aamvtrampa36-del/new-project"}))
      .rejects.toThrow("GitHub API 404");
    expect(calls.length).toBe(1);
  });
  test("block main/master or path traversal on all writes",async()=>{
    calls.length=0;
    await expect(api.execute({action:"write",repo:"aamvtrampa36-del/cdf-cloud-engine",path:"README.md",branch:"main",content:"test"})).rejects.toThrow("review branch");
    await expect(api.execute({action:"write",repo:"aamvtrampa36-del/cdf-cloud-engine",path:"../secret",branch:"opencode/new-feature",content:"test"})).rejects.toThrow("Invalid repository file path");
    expect(calls.length).toBe(0);
  });
  test("protects canonical narrative, workflows and deployment configuration even on review branch",async()=>{
    calls.length=0;
    for(const path of ["canon/c34.md","docs/oficial/BIBLIA.md","content/narrativa/chapter.md",
      ".github/workflows/release.yml","cloudflare/wrangler.jsonc","docs/.env"]) {
      await expect(api.execute({action:"write",repo:"aamvtrampa36-del/cdf-cloud-engine",
        path,branch:"opencode/new-feature",content:"untrusted update"})).rejects.toThrow("Protected");
    }
    expect(calls.length).toBe(0);
  });
  test("create review branch from current default branch, not main write",async()=>{
    calls.length=0;
    const r:any=await api.execute({action:"branch",repo:"aamvtrampa36-del/cdf-cloud-engine",branch:"opencode/new-feature"});
    expect(r.sha).toBe("basecommit");
    expect(calls.at(-1)?.body.ref).toBe("refs/heads/opencode/new-feature");
    expect(calls.at(-1)?.headers.get("Authorization")).toBe("Bearer dummy-test-key");
  });
  test("write UTF-8 content to authorized review branch and open draft PR",async()=>{
    calls.length=0;
    const r:any=await api.execute({action:"write",repo:"aamvtrampa36-del/cdf-cloud-engine",path:"docs/test.md",branch:"opencode/new-feature",content:"¡Hola, código!"});
    expect(r.commitSha).toBe("newcommit");
    const write=calls.find(x=>x.method==="PUT");
    expect(write?.body.branch).toBe("opencode/new-feature");
    const decoded=new TextDecoder().decode(Uint8Array.from(atob(write?.body.content), c=>c.charCodeAt(0)));
    expect(decoded).toBe("¡Hola, código!");
    const pr:any=await api.execute({action:"pr",repo:"aamvtrampa36-del/cdf-cloud-engine",branch:"opencode/new-feature",title:"Test PR"});
    expect(pr.draft).toBe(true);
    expect(calls.at(-1)?.body.base).toBe("main");
    expect(calls.at(-1)?.body.draft).toBe(true);
  });
});

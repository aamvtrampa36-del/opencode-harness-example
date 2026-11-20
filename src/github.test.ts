import { describe, expect, test } from "bun:test";
import { GitHubBridge } from "./github";

const calls: Array<{url:string; method:string; body?:any; headers:Headers}> = [];
const fake = (async (url: any, init: any = {}) => {
  const route = String(url);
  calls.push({url:route, method:init.method||"GET", body:init.body?JSON.parse(init.body):undefined, headers:new Headers(init.headers||{})});
  let status=200;
  let body:any={};
  if (route.endsWith("/repos/aamvtrampa36-del/cdf-cloud-engine") ||
      route.endsWith("/repos/aamvtrampa36-del/opencode-harness-example")) {
    body={full_name:route.split("/repos/")[1],default_branch:"main",private:true};
  } else if (route.includes("/git/ref/heads/feat%2Fstaging-supervisor-control-20261111")) {
    body={object:{sha:"7d1669cba0f3c8ee08626425aaf551c8d5bd4bf7"}};
  } else if (route.endsWith("/git/ref/heads/main")) {
    body={object:{sha:"a".repeat(40)}};
  } else if (route.endsWith("/git/refs")) {
    status=201;
    const create = JSON.parse(String(init.body));
    body={ref:create.ref,object:{sha:create.sha}};
  } else if (route.includes("/contents/src/model-presets.ts")) {
    const source = "export const ECONOMY = 'deepseek';\n";
    body = { type: "file", encoding: "base64", content: btoa(source), size: source.length, sha: "b".repeat(40) };
  } else if (route.includes("/contents/docs/test.md?ref=opencode%2Fnew-feature")) {
    status=404;body={message:"Not Found"};
  } else if (route.endsWith("/contents/docs/test.md")) {
    body={commit:{sha:"newcommit"},content:{sha:"filehash"}};
  } else if (route.includes("/compare/feat%2Fstaging-supervisor-control-20261111...opencode%2Fstaging-a1234567890bcdef") ||
             route.includes("/compare/main...opencode%2Fnew-feature")) {
    body={ahead_by:1,behind_by:0,total_commits:1,files:[{
      filename:"docs/test.md",status:"added",additions:1,deletions:0
    }]};
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
    expect(r.sha).toBe("a".repeat(40));
    expect(calls.at(-1)?.body.ref).toBe("refs/heads/opencode/new-feature");
    expect(calls.at(-1)?.headers.get("Authorization")).toBe("Bearer dummy-test-key");
  });
  test("pins OpenCode self-development to Staging and reviews against that base",async()=>{
    calls.length=0;
    const staged="opencode/staging-a1234567890bcdef";
    const source="feat/staging-supervisor-control-20261111";
    const r:any=await api.execute({action:"branch",repo:"aamvtrampa36-del/opencode-harness-example",branch:staged});
    expect(r.source).toBe(source);
    expect(r.sha).toBe("7d1669cba0f3c8ee08626425aaf551c8d5bd4bf7");
    expect(calls.some(x=>x.url.includes("git/ref/heads/feat%2Fstaging-supervisor-control-20261111"))).toBe(true);
    const review:any=await api.execute({action:"review",repo:"aamvtrampa36-del/opencode-harness-example",branch:staged});
    expect(review.base).toBe(source);
    const pr:any=await api.execute({action:"pr",repo:"aamvtrampa36-del/opencode-harness-example",branch:staged,title:"Staging fix"});
    expect(pr.base).toBe(source);
    expect(calls.at(-1)?.body.base).toBe(source);
    calls.length=0;
    await expect(api.execute({action:"branch",repo:"aamvtrampa36-del/cdf-cloud-engine",branch:staged})).rejects.toThrow("OpenCode-only");
    expect(calls.every(x=>x.method==="GET")).toBe(true);
  });
  test("reads UTF-8 repository files from the default branch without a required ref",async()=>{
    calls.length=0;
    const result:any=await api.execute({action:"read",repo:"aamvtrampa36-del/opencode-harness-example",path:"src/model-presets.ts"});
    expect(result.content).toBe("export const ECONOMY = 'deepseek';\n");
    expect(result.ref).toBe("default");
    expect(result.path).toBe("src/model-presets.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith("/contents/src/model-presets.ts")).toBe(true);
    expect(calls[0]?.method).toBe("GET");
  });
  test("reads an explicit branch only when a ref was supplied",async()=>{
    calls.length=0;
    const result:any=await api.execute({action:"read",repo:"aamvtrampa36-del/opencode-harness-example",
      path:"src/model-presets.ts",ref:"opencode/isolated-test"});
    expect(result.ref).toBe("opencode/isolated-test");
    expect(calls[0]?.url).toContain("ref=opencode%2Fisolated-test");
  });
  test("reads a bounded diff only for the chosen review branch",async()=>{
    calls.length=0;
    const result:any=await api.execute({action:"review",repo:"aamvtrampa36-del/cdf-cloud-engine",branch:"opencode/new-feature"});
    expect(result.base).toBe("main");
    expect(result.files).toEqual([{path:"docs/test.md",status:"added",additions:1,deletions:0}]);
    expect(result.aheadBy).toBe(1);
    expect(calls.every(x=>x.method==="GET")).toBe(true);
    await expect(api.execute({action:"review",repo:"aamvtrampa36-del/cdf-cloud-engine",branch:"main"})).rejects.toThrow("review branch");
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


describe("Authenticated read-only GitHub PR and issue triage", () => {
  const routes: string[] = [];
  const mock = (async (url: unknown, init: RequestInit = {}) => {
    const pathname = new URL(String(url)).pathname;
    const u = new URL(String(url));
    routes.push(u.pathname + u.search);
    const payload: Record<string, unknown> = {
      "/pulls/227": {
        number:227, title:"Synthetic PR", state:"open", draft:true, merged_at:null,
        base:{ref:"main",sha:"a".repeat(40)},head:{ref:"opencode/test",sha:"b".repeat(40)},
        html_url:"https://github.com/example/repo/pull/227",mergeable:false,updated_at:"2026-11-20"
      },
      "/issues/201": { title:"Synthetic incident", state:"open", state_reason:null,
        pull_request:null, html_url:"https://github.com/example/repo/issues/201",
        updated_at:"2026-11-20", comments:3 },
      "/pulls/227/files": [{filename:"src/file.ts",status:"modified",additions:2,deletions:1,sha:"c".repeat(40)}],
      "/pulls/227/reviews": [{id:2,state:"CHANGES_REQUESTED",user:{login:"reviewer"},
        commit_id:"b".repeat(40),submitted_at:"2026-11-20"}],
      ["/commits/"+"b".repeat(40)+"/check-runs"]: {total_count:1,check_runs:[
        {name:"test",status:"completed",conclusion:"success",html_url:"https://github.com/example/check",completed_at:"2026-11-20"}]},
      ["/commits/"+"b".repeat(40)+"/status"]: {state:"success",statuses:[]}
    };
    const suffix=pathname.replace("/repos/aamvtrampa36-del/cdf-cloud-engine","");
    const body=payload[suffix];
    const code=body?200:404;
    return new Response(JSON.stringify(body||{message:"Not Found"}), {
      status:code,headers:{"Content-Type":"application/json"}
    });
  }) as typeof fetch;
  const bridge = new GitHubBridge("unit-test-token",mock);
  test("PR and issue metadata prove draft, merge and current SHA without anonymous fetch", async () => {
    routes.length=0;
    const pr:any=await bridge.execute({action:"pr_info",repo:"aamvtrampa36-del/cdf-cloud-engine",number:227});
    const issue:any=await bridge.execute({action:"issue_info",repo:"aamvtrampa36-del/cdf-cloud-engine",number:201});
    expect(pr).toMatchObject({number:227,state:"open",draft:true,merged:false,base:"main",headSha:"b".repeat(40)});
    expect(issue).toMatchObject({number:201,state:"open",isPullRequest:false});
    expect(routes).toHaveLength(2);
  });
  test("bounded file lists, reviews and exact-SHA checks are read-only", async () => {
    routes.length=0;
    const repo="aamvtrampa36-del/cdf-cloud-engine";
    const files:any=await bridge.execute({action:"pr_files",repo,number:227});
    const reviews:any=await bridge.execute({action:"pr_reviews",repo,number:227,page:1});
    const checks:any=await bridge.execute({action:"pr_checks",repo,sha:"b".repeat(40)});
    expect(files.files).toHaveLength(1);
    expect(files.possibleNextPage).toBeNull();
    expect(reviews.reviews[0]).toMatchObject({state:"CHANGES_REQUESTED"});
    expect(checks).toMatchObject({sha:"b".repeat(40),combinedStatus:"success"});
    expect(checks.checkRuns[0].conclusion).toBe("success");
    expect(routes).toHaveLength(4);
  });
  test("malformed numbers, pages, SHA and unapproved repos never contact GitHub", async () => {
    routes.length=0;
    const repo="aamvtrampa36-del/cdf-cloud-engine";
    await expect(bridge.execute({action:"pr_info",repo,number:0})).rejects.toThrow("number");
    await expect(bridge.execute({action:"issue_info",repo,number:-1})).rejects.toThrow("number");
    await expect(bridge.execute({action:"pr_files",repo,number:227,page:0})).rejects.toThrow("page");
    await expect(bridge.execute({action:"pr_checks",repo,sha:"../main"})).rejects.toThrow("SHA");
    await expect(bridge.execute({action:"pr_info",repo:"other/repo",number:227})).rejects.toThrow("authorized");
    expect(routes).toHaveLength(0);
  });
  test("GitHub HTTP 404 stays explicit, never interpreted as absence in the corpus", async () => {
    routes.length=0;
    await expect(bridge.execute({action:"pr_info",repo:"aamvtrampa36-del/cdf-cloud-engine",number:999}))
      .rejects.toThrow("GitHub API 404");
    expect(routes).toHaveLength(1);
  });
});


describe("GitHub private read error classes and safe retry boundaries", () => {
  const repo="aamvtrampa36-del/cdf-cloud-engine";
  for (const [status,kind] of [
    [401,"GITHUB_AUTH_REQUIRED"],
    [403,"GITHUB_PERMISSION_OR_RATE_LIMIT"],
    [404,"GITHUB_NOT_ACCESSIBLE"],
    [429,"GITHUB_TRANSIENT"],
    [503,"GITHUB_TRANSIENT"]
  ] as const) {
    test("classifies HTTP " + status + " with no automatic retries", async () => {
      let calls=0;
      const fake=(async (_url: unknown, init: RequestInit) => {
        calls++;
        expect(init.method).toBe("GET");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer unit-only");
        return new Response(JSON.stringify({message:"Synthetic unavailable"}), {
          status,headers:{"Content-Type":"application/json","Retry-After":"3"}
        });
      }) as typeof fetch;
      const bridge=new GitHubBridge("unit-only",fake);
      await expect(bridge.execute({action:"pr_info",repo,number:227}))
        .rejects.toThrow("GitHub API " + status + " [" + kind + "]");
      expect(calls).toBe(1);
    });
  }
  test("do not convert HTTP 404 private access failure into a null PR", async () => {
    const bridge=new GitHubBridge("unit-only",(async () =>
      new Response(JSON.stringify({message:"Not Found"}), {status:404})) as typeof fetch);
    await expect(bridge.execute({action:"pr_info",repo,number:227}))
      .rejects.toThrow("GITHUB_NOT_ACCESSIBLE");
  });
});

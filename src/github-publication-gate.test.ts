import { describe, expect, test } from "bun:test";
import { GitHubBridge } from "./github";
import { GitHubPublicationGate, type PublicationTransaction } from "./github-publication-gate";

const repo = "aamvtrampa36-del/opencode-harness-example";
const base = "staging/opencode-g1-rpc-safe-20261120";
const branchA = "opencode/staging-aaaaaaaaaaaaaaaa";
const branchB = "opencode/staging-bbbbbbbbbbbbbbbb";
const baseSha = "a".repeat(40), headSha = "b".repeat(40), movedSha = "c".repeat(40);

/** Transactional test store, shared by all agent bridge instances. */
class TransactionalStore {
  readonly records = new Map<string, unknown>();
  private queue: Promise<unknown> = Promise.resolve();
  transaction<T>(run: (tx: PublicationTransaction) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const draft = new Map(this.records);
      const tx: PublicationTransaction = {
        get: async <V>(key: string) => draft.get(key) as V | undefined,
        put: async (key: string, value: unknown) => { draft.set(key, value); }
      };
      const outcome = await run(tx);
      this.records.clear();
      for (const [key, value] of draft) this.records.set(key, value);
      return outcome;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

function fixture(opts: {
  firstCompareHold?: boolean;
  lostResponse?: "after" | "before";
  moveHeadAtLastRead?: boolean;
  shared?: TransactionalStore;
} = {}) {
  const store = opts.shared || new TransactionalStore();
  const prs: any[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  let posts = 0, headReads = 0;
  let releaseCompare!: () => void, signalCompare!: () => void;
  const blockedCompare = new Promise<void>(resolve => { releaseCompare = resolve; });
  const enteredCompare = new Promise<void>(resolve => { signalCompare = resolve; });
  let held = false;

  const mock = (async (url: unknown, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const method = init.method || "GET", path = parsed.pathname + parsed.search;
    requests.push({method, path});
    if (method === "GET" && parsed.pathname === "/repos/" + repo)
      return Response.json({full_name:repo, default_branch:"main"});
    if (method === "GET" && path.includes("/git/ref/heads/")) {
      if (decodeURIComponent(path).endsWith("/" + base))
        return Response.json({object:{sha:baseSha}});
      headReads++;
      const sha = opts.moveHeadAtLastRead && headReads >= 2 ? movedSha : headSha;
      return Response.json({object:{sha}});
    }
    if (method === "GET" && path.includes("/compare/")) {
      if (opts.firstCompareHold && !held) {
        held = true; signalCompare(); await blockedCompare;
      }
      const name = decodeURIComponent(parsed.pathname).split("...").at(-1) || branchA;
      const pathOf = name === branchB ? "src/shared.ts" :
        name.includes("synthetic") ? "docs/" + name.split("/").at(-1) + ".json" : "src/shared.ts";
      return Response.json({total_commits:1,ahead_by:1,files:[{filename:pathOf}]});
    }
    if (method === "GET" && parsed.pathname.endsWith("/pulls")) {
      const state = parsed.searchParams.get("state") || "open";
      const values = prs.filter(p => state === "all" || p.state === "open");
      return Response.json(values);
    }
    if (method === "GET" && /\/pulls\/\d+\/files$/.test(parsed.pathname)) {
      const number = Number(parsed.pathname.match(/\/pulls\/(\d+)\/files$/)?.[1]);
      const item = prs.find(p => p.number === number);
      const itemPath = item.head.ref.includes("synthetic") ? "docs/" +
        item.head.ref.split("/").at(-1) + ".json" : "src/shared.ts";
      return Response.json(item ? [{filename:itemPath}] : []);
    }
    if (method === "POST" && parsed.pathname.endsWith("/pulls")) {
      posts++;
      if (opts.lostResponse === "before")
        return Response.json({message:"Unknown gateway failure"},{status:503});
      const data = JSON.parse(String(init.body));
      const number = 500 + posts;
      const receipt = {number,html_url:"https://github.com/"+repo+"/pull/"+number,
        title:data.title,body:data.body,draft:true,state:"open",
        head:{ref:data.head,sha:headSha,repo:{full_name:repo}},
        base:{ref:data.base,sha:baseSha}};
      prs.push(receipt);
      if (opts.lostResponse === "after")
        return Response.json({message:"Response vanished"},{status:503});
      return Response.json(receipt,{status:201});
    }
    return Response.json({message:"Unexpected "+method+" "+path},{status:404});
  }) as typeof fetch;

  const bridge = (gate = new GitHubPublicationGate(store)) =>
    new GitHubBridge("synthetic-token", mock, [repo], gate, true);
  return {store,bridge,prs,requests,posts:()=>posts,enteredCompare,releaseCompare};
}

describe("R2 T08 durable GitHub draft publication", () => {
  test("strict mode rejects absent shared gate before any PR POST",async () => {
    const h = fixture();
    const missing = new GitHubBridge("synthetic-token", (() => {
      return Response.json({full_name:repo,default_branch:"main"});
    }) as typeof fetch, [repo], undefined, true);
    await expect(missing.execute({action:"pr",repo,branch:branchA,title:"No gate"}))
      .rejects.toThrow("PR_PUBLICATION_GATE_REQUIRED");
    expect(h.posts()).toBe(0);
  });

  test("two competing writers, one atomic owner, one PR; later overlap rejected",async () => {
    const h = fixture({firstCompareHold:true});
    const a = h.bridge(), b = h.bridge();
    const first = a.execute({action:"pr",repo,branch:branchA,title:"A"});
    await h.enteredCompare;
    await expect(b.execute({action:"pr",repo,branch:branchB,title:"B"}))
      .rejects.toThrow("PR_PUBLICATION_BUSY_OR_UNKNOWN");
    expect(h.posts()).toBe(0);
    h.releaseCompare();
    const receipt:any = await first;
    expect(receipt.number).toBe(501);
    await expect(b.execute({action:"pr",repo,branch:branchB,title:"B"}))
      .rejects.toThrow("PR_WRITE_SCOPE_CONFLICT");
    expect(h.posts()).toBe(1);
  });

  test("ten synthetic branches with disjoint files publish independently, never touch main", async () => {
    const h = fixture();
    const receipts:any[]=[];
    for(let i=0;i<10;i++) {
      const name = "opencode/synthetic-"+String(i).padStart(2,"0");
      receipts.push(await h.bridge().execute({action:"pr",repo,branch:name,title:"Change "+i}));
    }
    expect(new Set(receipts.map(x=>x.number)).size).toBe(10);
    expect(h.posts()).toBe(10);
    expect(h.requests.every(x=>!(/POST|PUT|PATCH/.test(x.method) && x.path.includes("/git/ref/heads/main")))).toBe(true);
  });

  test("lost successful POST reconciles from durable unknown without another POST",async () => {
    const h = fixture({lostResponse:"after"});
    await expect(h.bridge().execute({action:"pr",repo,branch:branchA,title:"Same",body:"Exactly"}))
      .rejects.toThrow("GITHUB_TRANSIENT");
    expect(h.posts()).toBe(1);
    // New gate instance simulates a Worker restart; same durable ledger.
    const value:any=await h.bridge().execute({action:"pr",repo,branch:branchA,title:"Same",body:"Exactly"});
    expect(value).toMatchObject({number:501,reconciled:true});
    expect(h.posts()).toBe(1);
    const again:any=await h.bridge().execute({action:"pr",repo,branch:branchA,title:"Same",body:"Exactly"});
    expect(again.number).toBe(501);
    expect(h.posts()).toBe(1);
  });

  test("lost POST with no visible receipt stays UNKNOWN; no blind retry",async () => {
    const h=fixture({lostResponse:"before"});
    await expect(h.bridge().execute({action:"pr",repo,branch:branchA,title:"Unknown"}))
      .rejects.toThrow("GITHUB_TRANSIENT");
    await expect(h.bridge().execute({action:"pr",repo,branch:branchA,title:"Unknown"}))
      .rejects.toThrow("PR_PUBLICATION_UNKNOWN");
    await expect(h.bridge().execute({action:"pr",repo,branch:branchB,title:"Other"}))
      .rejects.toThrow("PR_PUBLICATION_BUSY_OR_UNKNOWN");
    expect(h.posts()).toBe(1);
  });

  test("divergent payload after unknown is blocked rather than reconciled",async () => {
    const h=fixture({lostResponse:"after"});
    await expect(h.bridge().execute({action:"pr",repo,branch:branchA,title:"Original"}))
      .rejects.toThrow("GITHUB_TRANSIENT");
    await expect(h.bridge().execute({action:"pr",repo,branch:branchA,title:"Changed"}))
      .rejects.toThrow("PR_PUBLICATION_BUSY_OR_UNKNOWN");
    expect(h.posts()).toBe(1);
  });

  test("moving branch HEAD rejects preflight without effect and frees the gate",async () => {
    const h=fixture({moveHeadAtLastRead:true});
    await expect(h.bridge().execute({action:"pr",repo,branch:branchA,title:"Stale"}))
      .rejects.toThrow("PR_PREFLIGHT_STALE");
    expect(h.posts()).toBe(0);
    expect(Array.from(h.store.records.values()).some((v:any)=>v?.phase==="free")).toBe(true);
  });

  test("invalid repo and protected branch denied before publication",async () => {
    const h=fixture();
    const b=h.bridge();
    await expect(b.execute({action:"pr",repo:"other/repo",branch:branchA,title:"Escape"}))
      .rejects.toThrow("authorized GitHub account");
    await expect(b.execute({action:"pr",repo,branch:"main",title:"Escape"}))
      .rejects.toThrow("review branch");
    expect(h.requests).toHaveLength(0);
  });
});


describe("R2 T08 ambiguous exact replacement ref update",()=>{
  for(const applied of [true,false]){
    test(applied ? "PATCH applied but HTTP reply lost returns one reconciled commit"
      : "PATCH not applied but HTTP reply lost remains UNKNOWN without replay",async()=>{
      const branch="opencode/staging-a1234567890bcdef",head="d".repeat(40);
      const tree="e".repeat(40),sub="4".repeat(40),blob="f".repeat(40);
      const newTree="1".repeat(40),commit="2".repeat(40);
      let patchCount=0,refReads=0;
      const source="export const value = 1;\n";
      const http=(async(url:unknown,init:RequestInit={})=>{
        const route=String(url).toLowerCase(),method=init.method || "GET";
        if(method==="GET" && route.includes("/git/ref/heads/")){
          refReads++;
          return Response.json({object:{sha:refReads>1 && applied?commit:head}});
        }
        if(method==="GET" && route.includes("/contents/src/value.ts?ref="))
          return Response.json({type:"file",encoding:"base64",content:btoa(source),size:source.length});
        if(method==="GET" && route.endsWith("/git/commits/"+head))
          return Response.json({tree:{sha:tree}});
        if(method==="GET" && route.endsWith("/git/trees/"+tree))
          return Response.json({tree:[{path:"src",type:"tree",sha:sub}]});
        if(method==="GET" && route.endsWith("/git/trees/"+sub))
          return Response.json({tree:[{path:"value.ts",type:"blob",mode:"100644"}]});
        if(method==="POST" && route.endsWith("/git/blobs"))
          return Response.json({sha:blob},{status:201});
        if(method==="POST" && route.endsWith("/git/trees"))
          return Response.json({sha:newTree},{status:201});
        if(method==="POST" && route.endsWith("/git/commits"))
          return Response.json({sha:commit},{status:201});
        if(method==="PATCH" && route.includes("/git/refs/heads/")){
          patchCount++;
          return Response.json({message:"lost response after PATCH"},{status:503});
        }
        return Response.json({message:"Unexpected request "+route},{status:404});
      }) as typeof fetch;
      const op={action:"write" as const,repo,branch,path:"src/value.ts",
        expectedHead:head,oldText:"value = 1",newText:"value = 2"};
      const bridge=new GitHubBridge("synthetic-token",http);
      if(applied){
        const result:any=await bridge.execute(op);
        expect(result).toMatchObject({commitSha:commit,reconciled:true});
      }else{
        await expect(bridge.execute(op)).rejects.toThrow("GITHUB_REF_UPDATE_UNKNOWN");
      }
      expect(patchCount).toBe(1);
      expect(refReads).toBe(2);
    });
  }
});

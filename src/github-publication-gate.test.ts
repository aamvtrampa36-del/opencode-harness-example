import { describe, expect, test } from "bun:test";
import { GitHubBridge, type GitHubPrPublicationGate, type GitHubPrPublicationScope } from "./github";

const repo = "aamvtrampa36-del/opencode-harness-example";
const base = "/repos/" + repo;
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const branchA = "opencode/synthetic-a", branchB = "opencode/synthetic-b";

/**
 * Synthetic T03 contract adapter. Queueing, ledger and fencing are IN MEMORY
 * here for deterministic tests only. Do NOT use this as a production lease.
 */
class MemoryGate implements GitHubPrPublicationGate {
  private tails = new Map<string, Promise<void>>();
  private unknown = new Map<string, string>();
  private generation = 0;
  invalidateOnBegin = false;
  async withExclusive<T>(intent: GitHubPrPublicationScope, fn: (permit: {
    fencingToken: string; retryOnly: boolean; beginExternalEffect(): Promise<void>
  }) => Promise<T>): Promise<T> {
    const scope = intent.repo + "\n" + intent.base;
    const intentKey = JSON.stringify(intent);
    const prev = this.tails.get(scope) ?? Promise.resolve();
    let unlock!: () => void;
    const next = new Promise<void>(r => { unlock = r; });
    this.tails.set(scope, prev.then(() => next));
    await prev;
    let begun = false;
    const unknown = this.unknown.get(scope);
    if (unknown && unknown !== intentKey) {
      unlock();
      throw Error("PR_PUBLICATION_BUSY_UNKNOWN: different payload cannot overtake ambiguous POST");
    }
    const token = String(++this.generation);
    const retryOnly = unknown === intentKey;
    try {
      const result = await fn({
        fencingToken: token, retryOnly,
        beginExternalEffect: async () => {
          if (retryOnly) throw Error("PR_PUBLISH_UNKNOWN");
          if (this.invalidateOnBegin) throw Error("PR_FENCE_STALE");
          begun = true; // model of a durable journal *before* external POST
          this.unknown.set(scope, intentKey);
        }
      });
      this.unknown.delete(scope);
      return result;
    } catch (err) {
      if (!begun && !retryOnly) this.unknown.delete(scope);
      throw err;
    } finally { unlock(); }
  }
}

function server(options: { samePath?: boolean; loseFirstPost?: boolean; moveHead?: boolean } = {}) {
  const opened: Array<any> = [];
  let posts = 0, refReads = 0;
  const filename = (head: string) => options.samePath
    ? "src/shared.ts" : "docs/test/" + head.split("/").at(-1) + ".txt";
  const http = (async (url: unknown, init: RequestInit = {}) => {
    const uri = new URL(String(url)), method = init.method || "GET";
    const path = uri.pathname + uri.search;
    if (method === "GET" && path === base)
      return Response.json({ full_name: repo, default_branch: "main" });
    if (method === "GET" && path.startsWith(base + "/git/ref/heads/")) {
      refReads++;
      return Response.json({ object: { sha: path.endsWith("/main") ? B
        : options.moveHead && refReads >= 3 ? C : A } });
    }
    if (method === "GET" && path.startsWith(base + "/compare/")) {
      const head = decodeURIComponent(path.split("...").at(-1) ?? "");
      return Response.json({ total_commits: 1, ahead_by: 1, files: [
        { filename: filename(head), status: "added" }
      ] });
    }
    if (method === "GET" && path.startsWith(base + "/pulls?"))
      return Response.json(opened);
    if (method === "GET" && /\/pulls\/\d+\/files\?/.test(path)) {
      const number = Number(/\/pulls\/(\d+)\//.exec(path)?.[1]);
      const match = opened.find(item => item.number === number);
      return Response.json(match ? [{ filename: filename(match.head.ref) }] : []);
    }
    if (method === "POST" && path === base + "/pulls") {
      posts++;
      const body = JSON.parse(String(init.body));
      const number = 900 + posts;
      opened.push({ number, html_url: "https://github.com/" + repo + "/pull/" + number,
        base: { ref: body.base, sha: B },
        head: { ref: body.head, sha: A, repo: { full_name: repo } },
        title: body.title, body: body.body, draft: true });
      if (options.loseFirstPost && posts === 1)
        return Response.json({ message: "response lost after successful POST" }, { status: 503 });
      return Response.json({ number, html_url: opened.at(-1).html_url, draft: true }, { status: 201 });
    }
    return Response.json({ message: "unexpected route " + method + " " + path }, { status: 404 });
  }) as typeof fetch;
  return { http, opened, posts: () => posts };
}

describe("F0-C10 R2 T08 publication gate interface — synthetic only", () => {
  test("two competing branches with the same file produce one POST and a conflict", async () => {
    const gate = new MemoryGate(), github = server({ samePath: true });
    const bridgeA = new GitHubBridge("synthetic", github.http, undefined, gate);
    const bridgeB = new GitHubBridge("synthetic", github.http, undefined, gate);
    const results = await Promise.allSettled([
      bridgeA.execute({ action: "pr", repo, branch: branchA, title: "A" }),
      bridgeB.execute({ action: "pr", repo, branch: branchB, title: "B" })
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(String(failed.reason)).toContain("PR_WRITE_SCOPE_CONFLICT");
    expect(github.posts()).toBe(1);
    expect(github.opened).toHaveLength(1);
  });

  test("ten distinct branches and paths can publish under one shared gate", async () => {
    const gate = new MemoryGate(), github = server();
    const branches = Array.from({ length: 10 }, (_, i) =>
      "opencode/synthetic-" + String(i).padStart(2, "0"));
    const receipts: any[] = await Promise.all(branches.map((head, i) =>
      new GitHubBridge("synthetic", github.http, undefined, gate)
        .execute({ action: "pr", repo, branch: head, title: "Task " + i })));
    expect(receipts.map(x => x.head)).toEqual(branches);
    expect(new Set(receipts.map(x => x.number)).size).toBe(10);
    expect(github.posts()).toBe(10);
  });

  test("HTTP 503 after successful POST: retry performs readback only; divergent payload blocked", async () => {
    const gate = new MemoryGate(), github = server({ loseFirstPost: true });
    const bridge = new GitHubBridge("synthetic", github.http, undefined, gate);
    const intent = { action: "pr" as const, repo, branch: branchA, title: "Same", body: "Payload-A" };
    await expect(bridge.execute(intent)).rejects.toThrow("GITHUB_TRANSIENT");
    await expect(bridge.execute({ ...intent, body: "Payload-B" }))
      .rejects.toThrow("PR_PUBLICATION_BUSY_UNKNOWN");
    const receipt: any = await bridge.execute(intent);
    expect(receipt).toMatchObject({ number: 901, reconciled: true, headSha: A });
    expect(github.posts()).toBe(1);
  });

  test("previously attempted POST with no exact readback stays unknown, never sends another POST", async () => {
    const gate = new MemoryGate(); let postCount = 0;
    const h = server({ loseFirstPost: true });
    const http = (async (u: unknown, init: RequestInit = {}) => {
      const result = await h.http(u as any, init);
      if ((init.method || "GET") === "POST") { postCount++; return result; }
      if ((init.method || "GET") === "GET" && String(u).includes("/pulls?"))
        return Response.json([]); // index temporarily missing or stale
      return result;
    }) as typeof fetch;
    const bridge = new GitHubBridge("synthetic", http, undefined, gate);
    const intent = { action: "pr" as const, repo, branch: branchA, title: "Missing receipt" };
    await expect(bridge.execute(intent)).rejects.toThrow("GITHUB_TRANSIENT");
    await expect(bridge.execute(intent)).rejects.toThrow("PR_PUBLISH_UNKNOWN");
    expect(postCount).toBe(1);
  });

  test("modified HEAD during preflight is rejected before POST", async () => {
    const gate = new MemoryGate(), github = server({ moveHead: true });
    const bridge = new GitHubBridge("synthetic", github.http, undefined, gate);
    await expect(bridge.execute({ action: "pr", repo, branch: branchA, title: "Stale" }))
      .rejects.toThrow("PR_PREFLIGHT_STALE");
    expect(github.posts()).toBe(0);
  });

  test("revoked generation before GitHub effect rejects stale fencing token", async () => {
    const gate = new MemoryGate(), github = server();
    gate.invalidateOnBegin = true;
    await expect(new GitHubBridge("synthetic", github.http, undefined, gate)
      .execute({ action: "pr", repo, branch: branchA, title: "Stale lease" }))
      .rejects.toThrow("PR_FENCE_STALE");
    expect(github.posts()).toBe(0);
  });

  test("scope checks still reject non-owned repository and protected branch", async () => {
    let calls = 0;
    const http = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    const bridge = new GitHubBridge("synthetic", http, undefined, new MemoryGate());
    await expect(bridge.execute({ action: "pr", repo: "other/repo", branch: branchA, title: "Bad" }))
      .rejects.toThrow("authorized GitHub account");
    await expect(bridge.execute({ action: "pr", repo, branch: "main", title: "Bad" }))
      .rejects.toThrow("review branch");
    expect(calls).toBe(0);
  });
});

describe("F0-C10 R2 T08 exact replacement response loss", () => {
  for (const applied of [true, false]) {
    test(applied ? "PATCH applied + HTTP 503: exact HEAD readback reconciles once"
      : "PATCH not applied + HTTP 503: UNKNOWN, never retries PATCH", async () => {
      const branch = "opencode/staging-a1234567890bcdef", head = "d".repeat(40),
        tree = "e".repeat(40), sub = "4".repeat(40), blob = "f".repeat(40),
        newTree = "1".repeat(40), commit = "2".repeat(40);
      const source = "const answer = 1;\n";
      let patches = 0, refReads = 0;
      const http = (async (url: unknown, init: RequestInit = {}) => {
        const path = String(url).toLowerCase(), method = init.method ?? "GET";
        if (method === "GET" && path.includes("/git/ref/heads/")) {
          refReads++;
          return Response.json({ object: { sha: refReads > 1 && applied ? commit : head } });
        }
        if (method === "GET" && path.includes("/contents/src/answer.ts?ref="))
          return Response.json({ type: "file", encoding: "base64",
            content: btoa(source), size: source.length });
        if (method === "GET" && path.endsWith("/git/commits/" + head))
          return Response.json({ tree: { sha: tree } });
        if (method === "GET" && path.endsWith("/git/trees/" + tree))
          return Response.json({ tree: [{ path: "src", type: "tree", sha: sub }] });
        if (method === "GET" && path.endsWith("/git/trees/" + sub))
          return Response.json({ tree: [{ path: "answer.ts", type: "blob", mode: "100644" }] });
        if (method === "POST" && path.endsWith("/git/blobs")) return Response.json({ sha: blob }, { status: 201 });
        if (method === "POST" && path.endsWith("/git/trees")) return Response.json({ sha: newTree }, { status: 201 });
        if (method === "POST" && path.endsWith("/git/commits")) return Response.json({ sha: commit }, { status: 201 });
        if (method === "PATCH" && path.includes("/git/refs/heads/")) {
          patches++;
          return Response.json({ message: "gateway lost PATCH reply" }, { status: 503 });
        }
        return Response.json({ message: "unhandled" }, { status: 404 });
      }) as typeof fetch;
      const bridge = new GitHubBridge("synthetic", http);
      const request = { action: "write" as const, repo, branch, path: "src/answer.ts",
        expectedHead: head, oldText: "answer = 1", newText: "answer = 2" };
      if (applied) {
        const result: any = await bridge.execute(request);
        expect(result).toMatchObject({ commitSha: commit, reconciled: true });
      } else {
        await expect(bridge.execute(request)).rejects.toThrow("GITHUB_REF_UPDATE_UNKNOWN");
      }
      expect(patches).toBe(1);
    });
  }
});

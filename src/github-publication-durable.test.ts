import { describe, expect, test } from "bun:test";
import { GitHubBridge, OPENCODE_STAGING_BASE } from "./github";
import { DurableGitHubPublicationGate, assertSupervisedPublicationScope } from "./github-publication-durable";

const repo = "aamvtrampa36-del/opencode-harness-example";
const api = "/repos/" + repo;
const baseSha = "b".repeat(40), headSha = "a".repeat(40);
const branch = (n: number) => "opencode/staging-" + n.toString(16).padStart(16, "0");
const intent = (n: number, title = "Task " + n) => ({
  action: "pr" as const, repo, branch: branch(n), title, body: "Verified fixture"
});

class FakeStorage {
  private rows = new Map<string, unknown>();
  private tail = Promise.resolve();
  async transaction<T>(fn: (tx: FakeStorage) => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(r => { release = r; });
    await prev;
    const staged = new FakeStorage();
    staged.rows = new Map(structuredClone([...this.rows]));
    try {
      const result = await fn(staged);
      this.rows = staged.rows;
      return result;
    } finally { release(); }
  }
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.rows.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.rows.set(key, structuredClone(value));
  }
  snapshot(): [string, unknown][] { return structuredClone([...this.rows]); }
  restore(rows: [string, unknown][]) { this.rows = new Map(structuredClone(rows)); }
  asDO(): DurableObjectStorage { return this as unknown as DurableObjectStorage; }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}

function mockGitHub(options: { samePath?: boolean; lost?: "applied" | "not-applied";
  pausePost?: boolean; mutateHeadAfterFinalRead?: boolean } = {}) {
  const opened: any[] = [];
  const arrivals = deferred(), unblock = deferred();
  let posts = 0, branchHead = headSha;
  const headReads = new Map<string, number>();
  const moveHead = () => { branchHead = "c".repeat(40); for (const pr of opened) pr.head.sha = branchHead; };
  const filename = (b: string) => options.samePath ? "src/shared.ts" :
    "docs/fixtures/" + b.slice(-16) + ".md";
  const http = (async (url: unknown, init: RequestInit = {}) => {
    const uri = new URL(String(url));
    const path = uri.pathname + uri.search;
    const method = init.method ?? "GET";
    if (method === "GET" && path === api)
      return Response.json({ default_branch: "main" });
    if (method === "GET" && path.startsWith(api + "/git/ref/heads/")) {
      const ref = decodeURIComponent(path.slice((api + "/git/ref/heads/").length));
      if (ref === OPENCODE_STAGING_BASE) return Response.json({ object: { sha: baseSha } });
      const count = (headReads.get(ref) ?? 0) + 1;
      headReads.set(ref, count);
      const observed = branchHead;
      if (options.mutateHeadAfterFinalRead && count === 2) moveHead();
      return Response.json({ object: { sha: observed } });
    }
    if (method === "GET" && path.startsWith(api + "/compare/")) {
      const ref = decodeURIComponent(path.split("...").at(-1) ?? "");
      return Response.json({ total_commits: 1, ahead_by: 1,
        files: [{ filename: filename(ref), status: "added" }] });
    }
    if (method === "GET" && path.startsWith(api + "/pulls?")) return Response.json(opened);
    if (method === "GET" && /\/pulls\/\d+\/files\?/.test(path)) {
      const number = Number(/\/pulls\/(\d+)\//.exec(path)?.[1]);
      const p = opened.find(x => x.number === number);
      return Response.json(p ? [{ filename: filename(p.head.ref) }] : []);
    }
    if (method === "POST" && path === api + "/pulls") {
      posts++;
      if (options.pausePost) { arrivals.release(); await unblock.promise; }
      const payload = JSON.parse(String(init.body));
      if (options.lost === "not-applied")
        return Response.json({ message: "timeout, not applied" }, { status: 503 });
      const number = 6000 + posts;
      const url = "https://github.com/" + repo + "/pull/" + number;
      opened.push({ number, html_url: url, draft: true, base: { ref: OPENCODE_STAGING_BASE, sha: baseSha },
        head: { ref: payload.head, sha: branchHead, repo: { full_name: repo } },
        title: payload.title, body: payload.body });
      if (options.lost === "applied")
        return Response.json({ message: "reply lost after commit" }, { status: 503 });
      return Response.json({ number, html_url: url, draft: true,
        head: { ref: payload.head, sha: branchHead }, base: { ref: payload.base, sha: baseSha } }, { status: 201 });
    }
    return Response.json({ message: "Unexpected route " + method + " " + path }, { status: 404 });
  }) as typeof fetch;
  return { http, opened, posts: () => posts, arrivals, unblock, moveHead };
}
function bridge(storage: FakeStorage, h: ReturnType<typeof mockGitHub>) {
  return new GitHubBridge("synthetic-secret", h.http, undefined,
    new DurableGitHubPublicationGate(storage.asDO()));
}

describe("F0-C10 R2-T08 durable publication: transactional ledger and real bridge (offline)", () => {
  test("two writers compete across distinct bridge instances; only one POST", async () => {
    const s = new FakeStorage(), h = mockGitHub({ samePath: true, pausePost: true });
    const first = bridge(s, h).execute(intent(1));
    await h.arrivals.promise;
    await expect(bridge(s, h).execute(intent(2))).rejects.toThrow("PR_PUBLICATION_BUSY_UNKNOWN");
    h.unblock.release();
    const receipt: any = await first;
    expect(receipt.number).toBe(6001);
    expect(h.posts()).toBe(1);
    await expect(bridge(s, h).execute(intent(2))).rejects.toThrow("PR_WRITE_SCOPE_CONFLICT");
    expect(h.posts()).toBe(1);
  });
  test("ten branches with disjoint files remain isolated; ten unique draft receipts", async () => {
    const s = new FakeStorage(), h = mockGitHub();
    const receipts: any[] = [];
    for (let n = 1; n <= 10; n++) receipts.push(await bridge(s, h).execute(intent(n)));
    expect(new Set(receipts.map(x => x.number)).size).toBe(10);
    expect(new Set(receipts.map(x => x.head)).size).toBe(10);
    expect(h.posts()).toBe(10);
    expect(s.snapshot().filter(([k]) => k.includes(":branch:"))).toHaveLength(10);
  });
  test("503 after successful POST: quarantine, exact readback, no second POST", async () => {
    const s = new FakeStorage(), h = mockGitHub({ lost: "applied" });
    await expect(bridge(s, h).execute(intent(1))).rejects.toThrow("GITHUB_TRANSIENT");
    await expect(bridge(s, h).execute(intent(2))).rejects.toThrow("PR_PUBLICATION_BUSY_UNKNOWN");
    const receipt: any = await bridge(s, h).execute(intent(1));
    expect(receipt).toMatchObject({ number: 6001, reconciled: true, headSha, baseSha });
    expect(h.posts()).toBe(1);
    const replay: any = await bridge(s, h).execute(intent(1));
    expect(replay.number).toBe(6001);
    expect(h.posts()).toBe(1);
  });
  test("503 without confirmed PR: restart remains UNKNOWN; no blind second POST", async () => {
    const storage = new FakeStorage(), h = mockGitHub({ lost: "not-applied" });
    await expect(bridge(storage, h).execute(intent(1))).rejects.toThrow("GITHUB_TRANSIENT");
    const restarted = new FakeStorage();
    restarted.restore(storage.snapshot());
    await expect(bridge(restarted, h).execute(intent(1))).rejects.toThrow("PR_PUBLISH_UNKNOWN");
    await expect(bridge(restarted, h).execute(intent(2))).rejects.toThrow("PR_PUBLICATION_BUSY_UNKNOWN");
    expect(h.posts()).toBe(1);
    expect(restarted.snapshot().some(([_,v]) =>
      typeof v === "object" && v !== null && (v as any).active?.phase === "unknown")).toBe(true);
  });
  test("divergent title or body after unknown cannot escape quarantined intent", async () => {
    const s = new FakeStorage(), h = mockGitHub({ lost: "applied" });
    await expect(bridge(s, h).execute(intent(1))).rejects.toThrow("GITHUB_TRANSIENT");
    await expect(bridge(s, h).execute({ ...intent(1), title: "Different" }))
      .rejects.toThrow("PR_PUBLICATION_BUSY_UNKNOWN");
    expect(h.posts()).toBe(1);
  });
  test("divergent payload after successful receipt is blocked permanently for that branch", async () => {
    const s = new FakeStorage(), h = mockGitHub();
    await bridge(s, h).execute(intent(1));
    await expect(bridge(s, h).execute({ ...intent(1), body: "different body" }))
      .rejects.toThrow("PR_BRANCH_INTENT_CONFLICT");
    expect(h.posts()).toBe(1);
  });
  test("expired pre-effect owner is fenced; second owner can acquire", async () => {
    const s = new FakeStorage();
    let now = 1000;
    const gate = new DurableGitHubPublicationGate(s.asDO(), () => now);
    const req = { repo, base: OPENCODE_STAGING_BASE, branch: branch(1), title: "X", body: "" };
    const entered = deferred(), resume = deferred();
    const a = gate.withExclusive(req, async permit => {
      entered.release();
      await resume.promise;
      await permit.beginExternalEffect();
      throw Error("unexpected");
    });
    await entered.promise;
    now = 62_000;
    await expect(gate.withExclusive({ ...req, branch: branch(2) }, async permit => {
      // The newer epoch is valid, but no external side effect is needed here.
      expect(permit.retryOnly).toBe(false);
      throw Error("synthetic release before POST");
    })).rejects.toThrow("synthetic release before POST");
    resume.release();
    await expect(a).rejects.toThrow("PR_PUBLICATION_FENCE_REJECTED");
  });
  test("task revoked during preflight is rejected in the publishing transaction", async () => {
    const s = new FakeStorage(), entered = deferred(), resume = deferred();
    const gate = new DurableGitHubPublicationGate(s.asDO(), Date.now, async (tx) => {
      const current = await tx.get<{ status: string }>("synthetic-owner");
      if (current?.status !== "running") throw Error("PR_PUBLICATION_SESSION_SCOPE_DENIED");
    });
    await s.put("synthetic-owner", { status: "running" });
    const request = { repo, base: OPENCODE_STAGING_BASE, branch: branch(1), title: "X", body: "" };
    const old = gate.withExclusive(request, async permit => {
      entered.release();
      await resume.promise;
      await permit.beginExternalEffect();
      throw Error("should never send HTTP");
    });
    await entered.promise;
    await s.put("synthetic-owner", { status: "cancelled" });
    resume.release();
    await expect(old).rejects.toThrow("PR_PUBLICATION_SESSION_SCOPE_DENIED");
    expect(s.snapshot().some(([key, v]) =>
      key.startsWith("github:pr-publisher:v1:") &&
      (v as any)?.active !== undefined)).toBe(false);
  });
  test("an uncoordinated staging draft is rejected before API reads", async () => {
    let calls = 0;
    const http = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    const client = new GitHubBridge("test", http);
    await expect(client.execute(intent(1))).rejects.toThrow("PR_PUBLICATION_COORDINATOR_REQUIRED");
    expect(calls).toBe(0);
  });
  test("corrupted ledger fails closed before any PR POST", async () => {
    const s = new FakeStorage(), h = mockGitHub();
    await s.put("github:pr-publisher:v1:".concat("bad"), { version: 999 });
    // The corrupted key above is NOT in the derived scope; test corrupt the actual key.
    await bridge(s, h).execute(intent(1));
    const key = s.snapshot().map(([k]) => k).find(k => k.startsWith("github:pr-publisher:v1:") &&
      !k.includes(":branch:") && !k.endsWith(":bad"))!;
    await s.put(key, { version: 999 });
    await expect(bridge(s, h).execute(intent(2))).rejects.toThrow("PR_LEDGER_INVALID");
    expect(h.posts()).toBe(1);
  });
  test("supervisor server-side session, project and task branch must match", () => {
    const id = "1".padStart(16, "0");
    const task = { id, repository: repo, branch: branch(1), project: "supervised-" + id,
      session: "sesVerified1", status: "running" };
    expect(() => assertSupervisedPublicationScope(intent(1), "sesVerified1", task)).not.toThrow();
    for (const bad of [
      { s: "sesOther", task },
      { s: "sesVerified1", task: { ...task, branch: branch(2) } },
      { s: "sesVerified1", task: { ...task, project: "supervised-foreign" } },
      { s: "sesVerified1", task: { ...task, status: "cancelled" } },
      { s: "sesVerified1", task: { ...task, repository: "aamvtrampa36-del/other-repo" } }
    ]) expect(() => assertSupervisedPublicationScope(intent(1), bad.s, bad.task))
      .toThrow("PR_PUBLICATION_SESSION_SCOPE_DENIED");
  });
});


describe("R3 RED: actual GitHub PR HEAD must match the fenced write-ahead proof", () => {
  test("external HEAD moves after final preflight GET but before POST: must not commit a false receipt", async () => {
    const s = new FakeStorage(), h = mockGitHub({ mutateHeadAfterFinalRead: true });
    await expect(bridge(s, h).execute(intent(1))).rejects.toThrow("PR_PUBLICATION_HEAD_CHANGED");
    expect(h.posts()).toBe(1); // POST took place, but verified completion must be denied.
    expect(h.opened[0]?.head.sha).toBe("c".repeat(40));
    const active = s.snapshot().find(([k]) => k.startsWith("github:pr-publisher:v1:") && !k.includes(":branch:"))?.[1] as any;
    expect(active?.active?.phase).toBe("unknown");
    await expect(bridge(s,h).execute(intent(1))).rejects.toThrow("PR_PUBLICATION_HEAD_CHANGED");
    expect(h.posts()).toBe(1);
  });
  test("POST applied, HTTP 503 lost, then branch HEAD moves: replay must not accept different commit", async () => {
    const s = new FakeStorage(), h = mockGitHub({ lost: "applied" });
    await expect(bridge(s, h).execute(intent(1))).rejects.toThrow("GITHUB_TRANSIENT");
    h.moveHead();
    await expect(bridge(s, h).execute(intent(1))).rejects.toThrow("PR_PUBLICATION_HEAD_CHANGED");
    expect(h.posts()).toBe(1);
  });
});

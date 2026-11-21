import { describe, expect, test } from "bun:test";
import { GitHubBridge } from "./github";
import { executeBoundRepositoryAction } from "./scoped-github";
import { assertScopedTool } from "./project-scope";

const repo = "aamvtrampa36-del/cdf-cloud-engine";
const candidate = (number: number, r = repo) => ({
  number, title: "Synthetic F-27 candidate", state: "open",
  updated_at: "2026-11-20T00:00:00Z", html_url: "https://github.com/" + r + "/pull/" + number,
  repository_url: "https://api.github.com/repos/" + r,
  pull_request: { url: "https://api.github.com/repos/" + r + "/pulls/" + number }
});

function fixture(items: unknown[], total = items.length, incomplete = false) {
  let calls = 0;
  const fake = (async (url: unknown, init: RequestInit = {}) => {
    calls++;
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-test");
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/search/issues");
    expect(parsed.searchParams.get("q")).toBe("repo:" + repo + " is:pr F-27");
    return new Response(JSON.stringify({
      items, total_count: total, incomplete_results: incomplete
    }), { status: 200 });
  }) as typeof fetch;
  return { bridge: new GitHubBridge("synthetic-test", fake), calls: () => calls };
}

describe("Private PR candidate discovery stays repository-scoped", () => {
  test("authorized search returns bounded candidates requiring exact PR verification", async () => {
    const { bridge, calls } = fixture([candidate(227)]);
    const data: any = await bridge.execute({ action: "pr_search", repo, query: "F-27" });
    expect(data).toMatchObject({ repo, query: "F-27", source: "SEARCH_INDEX_VERIFY_WITH_PR_INFO",
      totalCount: 1, incomplete: false, possibleNextPage: null });
    expect(data.matches.map((m: any) => m.number)).toEqual([227]);
    expect(calls()).toBe(1);
  });

  test("rejects untrusted query operators and malformed pagination before network", async () => {
    let calls = 0;
    const fake = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
    const bridge = new GitHubBridge("synthetic-test", fake);
    for (const query of ["", "A", "F-27 OR stranger", "repo:foreign", "F-27\nanother",
      "F-27)", "AND example"]) {
      await expect(bridge.execute({ action: "pr_search", repo, query }))
        .rejects.toThrow("Invalid PR discovery query");
    }
    await expect(bridge.execute({ action: "pr_search", repo, query: "F-27", page: 11 }))
      .rejects.toThrow("GitHub page");
    await expect(bridge.execute({ action: "pr_search", repo: "other/repo", query: "F-27" }))
      .rejects.toThrow("authorized");
    expect(calls).toBe(0);
  });

  test("rejects cross-repository or missing provenance", async () => {
    for (const item of [
      candidate(1, "another/repo"),
      { ...candidate(1), repository_url: undefined },
      { ...candidate(1), pull_request: undefined }
    ]) {
      const { bridge } = fixture([item]);
      await expect(bridge.execute({ action: "pr_search", repo, query: "F-27" }))
        .rejects.toThrow("GitHub PR search");
    }
  });

  test("search results are paginated, incomplete state preserved and bounded at page ten", async () => {
    const { bridge } = fixture(Array.from({ length: 20 }, (_, index) => candidate(index + 1)), 300, true);
    const first: any = await bridge.execute({ action: "pr_search", repo, query: "F-27", page: 1 });
    const last: any = await bridge.execute({ action: "pr_search", repo, query: "F-27", page: 10 });
    expect(first).toMatchObject({ possibleNextPage: 2, incomplete: true });
    expect(last.possibleNextPage).toBeNull();
  });

  test("Plan discovery resolves repository from session rather than model", async () => {
    const requests: unknown[] = [];
    await executeBoundRepositoryAction(
      "ses_test", "plan", { action: "pr_search", query: "F-27" },
      async () => repo,
      async (_session, selected) => assertScopedTool(
        { project: "cdf", repository: repo }, { kind: "github", repo: selected }),
      async action => { requests.push(action); return { source: "SEARCH_INDEX_VERIFY_WITH_PR_INFO" }; }
    );
    expect(requests).toEqual([{ action: "pr_search", query: "F-27", repo }]);
    await expect(executeBoundRepositoryAction(
      "ses_test", "plan", { action: "pr_search", query: "F-27" },
      async () => "aamvtrampa36-del/CDF-WorkBench-",
      async (_session, selected) => assertScopedTool(
        { project: "cdf", repository: repo }, { kind: "github", repo: selected }),
      async () => { throw new Error("should not execute"); }
    )).rejects.toThrow("bloqueado");
  });
});

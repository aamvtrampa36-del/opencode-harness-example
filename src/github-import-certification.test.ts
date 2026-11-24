import { describe, expect, test } from "bun:test";
import { githubSourceArchive, sourceReceiptMatches, RAW_TREE_CERTIFICATION } from "./github-import";
import { GitHubBridge } from "./github";

const repo = "aamvtrampa36-del/opencode-harness-example";
const commit = "a".repeat(40);
const tree = "b".repeat(40);

describe("certified source receipt and redirects", () => {
  test("uncertified or old tree receipt cannot satisfy a certified request", () => {
    expect(sourceReceiptMatches({commit, tree}, commit, tree)).toBe(false);
    expect(sourceReceiptMatches({commit, tree, certification: RAW_TREE_CERTIFICATION}, commit, tree)).toBe(true);
    expect(sourceReceiptMatches({commit, tree, certification: RAW_TREE_CERTIFICATION}, commit, "c".repeat(40))).toBe(false);
    expect(sourceReceiptMatches({commit}, commit, undefined)).toBe(true);
    expect(sourceReceiptMatches({commit}, undefined, undefined)).toBe(true);
  });

  test("follows one HTTPS codeload redirect without forwarding Authorization", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      calls.push({url: value, init});
      if (value.endsWith("/" + repo)) return Response.json({full_name: repo, default_branch: "main"});
      if (value.endsWith("/commits/" + commit)) return Response.json({sha: commit, commit: {tree: {sha: tree}}});
      if (value.endsWith("/tarball/" + commit)) return new Response(null, {status: 302, headers: {
        Location: "https://codeload.github.com/" + repo + "/legacy.tar.gz/" + commit + "?token=temporary"
      }});
      return new Response("archive");
    }) as typeof fetch;
    const result = await githubSourceArchive(repo, "test-token", [repo], http, commit, tree);
    expect(result.tree).toBe(tree);
    expect(await new Response(result.stream).text()).toBe("archive");
    expect(calls).toHaveLength(4);
    expect(calls.every(x => x.init?.redirect === "manual")).toBe(true);
    expect(new Headers(calls[2].init?.headers).get("Authorization")).toBe("Bearer test-token");
    expect(new Headers(calls[3].init?.headers).has("Authorization")).toBe(false);
  });

  test("refuses external archive redirects and redirected identity before sending another request", async () => {
    let count = 0;
    const http = (async (url: string | URL | Request) => {
      count++;
      if (String(url).endsWith("/" + repo)) return Response.json({full_name: repo, default_branch: "main"});
      return new Response(null, {status: 302, headers: {Location: "https://example.invalid/archive"}});
    }) as typeof fetch;
    await expect(githubSourceArchive(repo, "test-token", [repo], http, commit)).rejects.toThrow("no autorizada");
    expect(count).toBe(2);
    count = 0;
    const identity = (async (_url: string | URL | Request, init?: RequestInit) => {
      count++;
      expect(init?.redirect).toBe("manual");
      return new Response(null, {status: 302, headers: {Location: "https://example.invalid/repo"}});
    }) as typeof fetch;
    await expect(new GitHubBridge("test-token", identity, [repo]).resolveReadOnlySource(repo, commit, tree)).rejects.toThrow("redirect refused");
    expect(count).toBe(1);
  });
});

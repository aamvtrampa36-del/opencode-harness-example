import { describe, expect, test } from "bun:test";
import { githubSourceArchive } from "./github-import";

describe("private GitHub source preparation", () => {
  test("rejects unapproved repositories before using the token", async () => {
    let requests = 0;
    const http = (async () => { requests++; throw Error("unexpected"); }) as typeof fetch;
    await expect(githubSourceArchive("aamvtrampa36-del/other", "secret", [], http))
      .rejects.toThrow("autorizado");
    expect(requests).toBe(0);
  });
  test("pins an immutable GitHub commit and returns only source bytes", async () => {
    const urls: string[] = [];
    const sha = "a".repeat(40);
    const http = (async (url: string | URL | Request) => {
      const value = String(url); urls.push(value);
      if (value.endsWith("/cdf-cloud-engine")) return Response.json({
        full_name: "aamvtrampa36-del/cdf-cloud-engine", default_branch: "main"
      });
      if (value.endsWith("/commits/main")) return Response.json({ sha });
      return new Response("archive bytes");
    }) as typeof fetch;
    const source = await githubSourceArchive("aamvtrampa36-del/cdf-cloud-engine", "secret",
      ["aamvtrampa36-del/cdf-cloud-engine"], http);
    expect(source.commit).toBe(sha);
    expect(urls.at(-1)).toEndWith("/tarball/" + sha);
    expect(await new Response(source.stream).text()).toBe("archive bytes");
    expect(JSON.stringify({repo: source.repo, commit: source.commit})).not.toContain("secret");
  });
});

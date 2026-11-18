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

  test("imports the supervisor's exact Staging base commit instead of the default branch", async () => {
    const urls: string[] = [];
    const sha = "b".repeat(40);
    const http = (async (url: string | URL | Request) => {
      const value = String(url); urls.push(value);
      if (value.endsWith("/opencode-harness-example")) return Response.json({
        full_name: "aamvtrampa36-del/opencode-harness-example", default_branch: "main"
      });
      if (value.endsWith("/tarball/" + sha)) return new Response("staging archive");
      throw Error("Unexpected GitHub request: " + value);
    }) as typeof fetch;
    const source = await githubSourceArchive("aamvtrampa36-del/opencode-harness-example", "secret",
      ["aamvtrampa36-del/opencode-harness-example"], http, sha);
    expect(source.commit).toBe(sha);
    expect(urls).toHaveLength(2);
    expect(urls.at(-1)).toEndWith("/tarball/" + sha);
    expect(await new Response(source.stream).text()).toBe("staging archive");
  });

  test("rejects an invalid pinned commit before making a GitHub request", async () => {
    let requests = 0;
    const http = (async () => { requests++; throw Error("unexpected"); }) as typeof fetch;
    await expect(githubSourceArchive("aamvtrampa36-del/opencode-harness-example", "secret",
      ["aamvtrampa36-del/opencode-harness-example"], http, "main"))
      .rejects.toThrow("Commit de origen inválido");
    expect(requests).toBe(0);
  });
});

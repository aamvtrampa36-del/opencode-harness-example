import { describe, expect, test } from "bun:test";
import { archiveDownloadResponse } from "./download-response";
import { githubRepositoryDownload } from "./github-download";
import { sessionExportResponse } from "./session-export";

describe("download boundary is valid for failures and binary archives", () => {
  test("upstream missing project is a readable 404, never a fake gzip attachment", async () => {
    const output = await archiveDownloadResponse("cdf-cloud-engine",
      new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } }), "tar.gz");
    expect(output.status).toBe(404);
    expect(output.headers.get("content-type")).toContain("application/json");
    expect(output.headers.get("content-disposition")).toBeNull();
    expect((await output.json() as { error: string }).error).toContain("GitHub");
  });

  test("a failed archive is a safe 502 with no download header", async () => {
    const failed = await archiveDownloadResponse("foo",
      new Response("tar failed", { status: 500, headers: { "content-disposition": "attachment; filename=bad.gz" } }), "tar.gz");
    expect(failed.status).toBe(502);
    expect(failed.headers.get("content-disposition")).toBeNull();
    expect((await failed.json() as { error: string }).error).toContain("HTTP 500");
  });

  test("successful tar.gz streams exact bytes and known length", async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]);
    const upstream = new Response(bytes, {
      headers: { "Content-Type": "application/gzip", "Content-Length": "8",
        "Connection": "keep-alive", "Transfer-Encoding": "chunked", "Content-Encoding": "gzip" }
    });
    const out = await archiveDownloadResponse("app-test", upstream, "tar.gz");
    expect(out.status).toBe(200);
    expect(out.headers.get("content-disposition")).toBe('attachment; filename="app-test.tar.gz"');
    expect(out.headers.get("content-length")).toBe("8");
    expect(out.headers.get("transfer-encoding")).toBeNull();
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(bytes);
  });

  test("GitHub ZIP is read-only, authorized and never carries token to browser", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]);
    const requests: Array<{ url: string; auth?: string; method?: string }> = [];
    const http = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") ?? undefined,
        method: init?.method });
      return new Response(zip, { status: 200, headers: { "Content-Type": "application/zip", "Content-Length": "6" } });
    };
    const response = await githubRepositoryDownload("aamvtrampa36-del/cdf-cloud-engine", "private-secret",
      ["aamvtrampa36-del/cdf-cloud-engine"], http as typeof fetch);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("cdf-cloud-engine-github.zip");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify([...response.headers])).not.toContain("private-secret");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(zip);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://api.github.com/repos/aamvtrampa36-del/cdf-cloud-engine/zipball",
      auth: "Bearer private-secret", method: "GET"
    });
    const blocked = await githubRepositoryDownload("aamvtrampa36-del/CDF-WorkBench-", "private-secret",
      ["aamvtrampa36-del/cdf-cloud-engine"], http as typeof fetch);
    expect(blocked.status).toBe(403);
    expect(requests).toHaveLength(1);
  });

  test("GitHub failure produces proper JSON and does not leak provider body", async () => {
    const http = async (): Promise<Response> => new Response('{"message":"private details"}', { status: 403 });
    const response = await githubRepositoryDownload("aamvtrampa36-del/cdf-cloud-engine", "private-secret",
      ["aamvtrampa36-del/cdf-cloud-engine"], http as typeof fetch);
    expect(response.status).toBe(502);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.text()).not.toContain("private details");
  });

  test("existing conversation export still returns JSON attachment", async () => {
    const response = sessionExportResponse("ses_valid", [{ type: "user", content: "hello" }]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain("opencode-session-ses_valid.json");
    expect((await response.json() as { messages: unknown[] }).messages).toHaveLength(1);
  });
});

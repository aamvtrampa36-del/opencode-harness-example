import { describe, expect, test } from "bun:test";
import { readPublicWebPage } from "./public-web";

describe("public web reader", () => {
  test("follows a safe redirect and returns bounded readable HTML without scripts", async () => {
    const requested: string[] = [];
    const result = await readPublicWebPage("https://search.example.org/start", async input => {
      requested.push(input.toString());
      if (requested.length === 1) return new Response(null, {
        status: 302, headers: { location: "https://docs.example.org/page?section=privacy" }
      });
      return new Response("<html><title>Guía &amp; ejemplos</title><script>ignorar este secreto</script><h1>Hola</h1><p>Mundo&nbsp;real</p></html>", {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    expect(requested).toEqual(["https://search.example.org/start", "https://docs.example.org/page?section=privacy"]);
    expect(result.title).toBe("Guía & ejemplos");
    expect(result.text).toContain("Hola");
    expect(result.text).toContain("Mundo real");
    expect(result.text).not.toContain("ignorar este secreto");
    expect(result.url).toContain("section=privacy");
    expect(result.truncated).toBe(false);
  });

  test("blocks private and credential-bearing URL forms before making a request", async () => {
    let requests = 0;
    const fetcher: typeof fetch = async () => { requests++; return new Response("ok"); };
    for (const url of [
      "http://example.com/", "https://localhost/", "https://127.0.0.1/",
      "https://2130706433/", "https://router.local/", "https://user:pass@example.com/",
      "https://example.com:8443/", "https://example.com/?api_key=private"
    ]) {
      await expect(readPublicWebPage(url, fetcher)).rejects.toThrow();
    }
    expect(requests).toBe(0);
  });

  test("validates every redirect and does not fetch a private destination", async () => {
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    };
    await expect(readPublicWebPage("https://example.com/", fetcher)).rejects.toThrow("públicas HTTPS");
    expect(requests).toBe(1);
  });

  test("rejects binary downloads and reports upstream HTTP failures clearly", async () => {
    await expect(readPublicWebPage("https://example.com/file", async () => new Response("", {
      headers: { "content-type": "application/octet-stream" }
    }))).rejects.toThrow("no es texto legible");
    await expect(readPublicWebPage("https://example.com/", async () => new Response("", { status: 503 })))
      .rejects.toThrow("HTTP 503");
  });

  test("caps the text returned to the model", async () => {
    const result = await readPublicWebPage("https://example.org/long", async () => new Response("x".repeat(20_000), {
      headers: { "content-type": "text/plain" }
    }));
    expect(result.text).toHaveLength(12_000);
    expect(result.truncated).toBe(true);
  });
});

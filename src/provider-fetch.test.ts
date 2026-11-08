import { describe, expect, test } from "bun:test";
import { guardedProviderFetch } from "./provider-fetch";

describe("OpenRouter credential revocation", () => {
  const calls: Request[] = [];
  const transport = (async (input: RequestInfo | URL) => {
    const req = new Request(input);
    calls.push(req);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  test("deny calls with a removed key even from a resumed agent", async () => {
    calls.length = 0;
    const guarded = guardedProviderFetch(async () => [], transport);
    const result = await guarded("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-or-revoked", "Content-Type": "application/json" },
      body: "{}"
    });
    expect(result.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("accept only the newly connected key", async () => {
    calls.length = 0;
    const guarded = guardedProviderFetch(async () => ["sk-or-new"], transport);
    const old = await guarded("https://openrouter.ai/api/v1/responses", {
      headers: { Authorization: "Bearer sk-or-old" }
    });
    const fresh = await guarded("https://openrouter.ai/api/v1/responses", {
      headers: { Authorization: "Bearer sk-or-new" }
    });
    expect(old.status).toBe(403);
    expect(fresh.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("block paid inference without authentication, allow public catalog", async () => {
    calls.length = 0;
    const guarded = guardedProviderFetch(async () => [], transport);
    const paid = await guarded("https://openrouter.ai/api/v1/chat/completions");
    const catalog = await guarded("https://openrouter.ai/api/v1/models");
    expect(paid.status).toBe(403);
    expect(catalog.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("never intercept Workers AI or unrelated HTTPS requests", async () => {
    calls.length = 0;
    const guarded = guardedProviderFetch(async () => [], transport);
    expect((await guarded("https://api.cloudflare.com/client/v4/user")).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

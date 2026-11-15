import { describe, expect, test } from "bun:test";
import { generateOpenRouterImage, parseOpenRouterImageModels } from "./openrouter-images";

describe("OpenRouter image models", () => {
  test("keeps concrete generation models and rejects automatic routers or malformed IDs", () => {
    expect(parseOpenRouterImageModels({ data: [
      { id: "provider/imagen-4", name: "Imagen 4" },
      { id: "openrouter/auto", name: "Auto" },
      { id: "provider/imagen-4:batch", name: "Batch" },
      { id: "invalid", name: "Invalid" }
    ] })).toEqual([{ id: "provider/imagen-4", name: "Imagen 4" }]);
  });

  test("routes generation through the selected model and keeps the key server-side", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/images/models")) return new Response(JSON.stringify({ data: [
        { id: "provider/imagen-4", name: "Imagen 4" }
      ] }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=", media_type: "image/png" }],
        usage: { cost: 0.002 } }), { status: 200 });
    };
    const result = await generateOpenRouterImage({ apiKey: "private-test-key", model: "provider/imagen-4",
      prompt: "Un paisaje sencillo", references: [{ mime: "image/jpeg", data: "aGVsbG8=" }] }, request);
    expect(result).toEqual({ data: "aGVsbG8=", mime: "image/png", cost: 0.002 });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer private-test-key");
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe("Bearer private-test-key");
    const body = JSON.parse(String(calls[1].init?.body)) as { model: string; prompt: string };
    expect(body).toEqual({ model: "provider/imagen-4", prompt: "Un paisaje sencillo" });
  });

  test("preserves an SVG image returned by an image model", async () => {
    const request: typeof fetch = async (input) => String(input).endsWith("/images/models")
      ? new Response(JSON.stringify({ data: [{ id: "provider/vector" }] }), { status: 200 })
      : new Response(JSON.stringify({ data: [{ b64_json: "PHN2Zz4=", media_type: "image/svg+xml" }] }), { status: 200 });
    const result = await generateOpenRouterImage({ apiKey: "private-test-key", model: "provider/vector", prompt: "A blue circle" }, request);
    expect(result.mime).toBe("image/svg+xml");
  });

  test("rejects models outside the image catalogue before generation", async () => {
    const calls: string[] = [];
    const request: typeof fetch = async () => new Response(JSON.stringify({ data: [
      { id: "provider/imagen-4" }
    ] }), { status: 200 });
    const tracked: typeof fetch = async (input, init) => { calls.push(String(input)); return request(input, init); };
    await expect(generateOpenRouterImage({ apiKey: "private-test-key", model: "other/model", prompt: "x" }, tracked)).rejects.toThrow("no está disponible");
    expect(calls).toEqual(["https://openrouter.ai/api/v1/images/models"]);
  });
});

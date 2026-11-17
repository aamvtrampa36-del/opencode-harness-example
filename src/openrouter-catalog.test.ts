import { describe, expect, test } from "bun:test";
import { isModelSelection, resolveModelSelection } from "./model-presets";
import { isOpenRouterFreeModel, OPENROUTER_FREE, parseOpenRouterCatalogue } from "./openrouter-catalog";

describe("OpenRouter model selection", () => {
  test("preserves simple presets and accepts official routers", () => {
    expect(isModelSelection("economy")).toBe(true);
    expect(resolveModelSelection("economy")).toEqual({
      providerID: "cloudflare", id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017"
    });
    expect(isModelSelection("openrouter:openrouter/auto")).toBe(true);
    expect(isModelSelection("openrouter:openrouter/auto-code")).toBe(true);
    expect(resolveModelSelection("openrouter:openrouter/auto-code"))
      .toEqual({ providerID: "openrouter", id: "openrouter/auto-code" });
    expect(isModelSelection("openrouter:openrouter/free")).toBe(true);
    expect(resolveModelSelection("openrouter:openrouter/free"))
      .toEqual({ providerID: "openrouter", id: OPENROUTER_FREE });
  });
  test("rejects malformed and injected model identifiers", () => {
    for (const value of ["openrouter:", "openrouter:invalid", "openrouter:https://evil.test",
      "openrouter:provider/model?key=1", "openrouter:provider/model\nmalicious",
      "openrouter:provider/../../etc", "x".repeat(200)]) {
      expect(isModelSelection(value)).toBe(false);
    }
  });
  test("lists only models with tools and does not invent fixed router costs", () => {
    const models = parseOpenRouterCatalogue({ data: [
      { id: "sample/chat", name: "Plain chat", supported_parameters: [] },
      { id: "sample/coder", name: "Coding Model", context_length: 32768,
        supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "sample/vision-coder", name: "Vision Coder", supported_parameters: ["tools"],
        architecture: { input_modalities: ["text", "image"] } },
      { id: "google/gemini-4-hydrogen", name: "Google: Gemini 4 Hydrogen",
        supported_parameters: ["tools"] },
      { id: "google/gemini-4-hydrogen:batch", name: "Google: Gemini 4 Hydrogen (batch)",
        supported_parameters: ["tools"] },
      { id: "sample/free", name: "Free model", supported_parameters: ["tools"],
        pricing: { prompt: "0", completion: "0" } },
      { id: "sample/unknown-price", name: "Unknown price", supported_parameters: ["tools"] }
    ] });
    expect(models.find(x => x.id === "sample/chat")).toBeUndefined();
    expect(models.find(x => x.id === "google/gemini-4-hydrogen")).toBeDefined();
    expect(models.find(x => x.id === "google/gemini-4-hydrogen:batch")).toBeUndefined();
    expect(models.find(x => x.id === "sample/coder")).toMatchObject({
      contextLength: 32768, promptPerMillion: 1, completionPerMillion: 2, tools: true
    });
    expect(models.find(x => x.id === "sample/vision-coder")?.imageInput).toBe(true);
    expect(models.find(x => x.id === "openrouter/auto")?.promptPerMillion).toBeNull();
    expect(models.find(x => x.id === "openrouter/auto-code")?.completionPerMillion).toBeNull();
    expect(isOpenRouterFreeModel(models.find(x => x.id === "sample/free")!)).toBe(true);
    expect(isOpenRouterFreeModel(models.find(x => x.id === "sample/unknown-price")!)).toBe(false);
    expect(isOpenRouterFreeModel(models.find(x => x.id === OPENROUTER_FREE)!)).toBe(true);
  });
});

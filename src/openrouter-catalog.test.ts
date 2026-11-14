import { describe, expect, test } from "bun:test";
import { isModelSelection, resolveModelSelection } from "./model-presets";
import { parseOpenRouterCatalogue } from "./openrouter-catalog";

describe("OpenRouter model selection", () => {
  test("preserves simple presets and accepts official routers", () => {
    expect(isModelSelection("economy")).toBe(true);
    expect(resolveModelSelection("economy").id).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(isModelSelection("openrouter:openrouter/auto")).toBe(true);
    expect(isModelSelection("openrouter:openrouter/auto-code")).toBe(true);
    expect(resolveModelSelection("openrouter:openrouter/auto-code"))
      .toEqual({ providerID: "openrouter", id: "openrouter/auto-code" });
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
        supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } }
    ] });
    expect(models.find(x => x.id === "sample/chat")).toBeUndefined();
    expect(models.find(x => x.id === "sample/coder")).toMatchObject({
      contextLength: 32768, promptPerMillion: 1, completionPerMillion: 2, tools: true
    });
    expect(models.find(x => x.id === "openrouter/auto")?.promptPerMillion).toBeNull();
    expect(models.find(x => x.id === "openrouter/auto-code")?.completionPerMillion).toBeNull();
  });
});

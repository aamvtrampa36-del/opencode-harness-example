import { describe, expect, test } from "bun:test";
import { MODEL_PRESETS, NATIVE_WORKERS_AI_MODELS, isModelPreset, isModelSelection, isOpenRouterSelection, resolveModelSelection, usableModelSelection } from "./model-presets";

describe("model authorization", () => {
  test("recognizes only allowlisted identifiers", () => {
    for (const id of Object.keys(MODEL_PRESETS)) {
      expect(isModelPreset(id)).toBe(true);
    }
    expect(isModelPreset("unknown")).toBe(false);
    expect(isModelPreset("__proto__")).toBe(false);
    expect(isModelPreset({})).toBe(false);
  });

  test("the baseline can run without an OpenRouter secret", () => {
    expect(MODEL_PRESETS.cloudflare.providerID).toBe("cloudflare");
    expect(MODEL_PRESETS.cloudflare.tier).toBe("baseline");
    expect(MODEL_PRESETS.cloudflare.id).toBe("@cf/zai-org/glm-4.7-flash");
  });

  test("registers all native models explicitly, without registering OpenRouter models", () => {
    expect(NATIVE_WORKERS_AI_MODELS).toEqual([
      "@cf/zai-org/glm-4.7-flash",
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017"
    ]);
  });

  test("economical DeepSeek runs natively through Cloudflare without an OpenRouter key", () => {
    const selected = resolveModelSelection("economy");
    expect(selected.providerID).toBe("cloudflare");
    expect(selected.id).toBe("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
    expect(MODEL_PRESETS.economy.tier).toBe("economy");
  });

  test("the remaining optional presets still use OpenRouter", () => {
    for (const [id, preset] of Object.entries(MODEL_PRESETS)) {
      if (id === "cloudflare" || id === "economy") continue;
      expect(preset.providerID).toBe("openrouter");
      expect(preset.id).toContain("/");
      expect(preset.id).not.toContain("sk-");
    }
  });

  test("a native DeepSeek choice remains selected without any OpenRouter credential", () => {
    expect(usableModelSelection("economy", false)).toBe("economy");
    expect(usableModelSelection("cloudflare", false)).toBe("cloudflare");
    expect(usableModelSelection("economy", true)).toBe("economy");
  });

  test("only OpenRouter choices fall back when their provider is unavailable", () => {
    expect(usableModelSelection("review", false)).toBe("cloudflare");
    expect(usableModelSelection("openrouter:openrouter/auto", false)).toBe("cloudflare");
    expect(usableModelSelection("review", true)).toBe("review");
    expect(usableModelSelection("openrouter:openrouter/auto", true)).toBe("openrouter:openrouter/auto");
  });

  test("premium inference is never the default preset", () => {
    expect(MODEL_PRESETS.reasoning.tier).toBe("premium");
    expect(Object.keys(MODEL_PRESETS)[0]).toBe("cloudflare");
  });
});


describe("catalogue selection syntax (not availability)", () => {
  test("preserves a provider model variant with colon suffix", () => {
    const id = "openrouter:vendor/model:free";
    expect(isOpenRouterSelection(id)).toBe(true);
    expect(resolveModelSelection(id)).toEqual({providerID:"openrouter",id:"vendor/model:free"});
  });
  test("rejects URLs, whitespace and missing provider segment", () => {
    for(const value of ["openrouter:https://x/y","openrouter:vendor/a b","openrouter:model","openrouter:/model"]){
      expect(isModelSelection(value)).toBe(false);
    }
  });
  test("enforces the full selection length boundary", () => {
    const prefix="openrouter:vendor/";
    expect(isOpenRouterSelection(prefix+"a".repeat(160-prefix.length))).toBe(true);
    expect(isOpenRouterSelection(prefix+"a".repeat(161-prefix.length))).toBe(false);
  });
  test("rejects inherited preset names instead of resolving them", () => {
    expect(isModelSelection("constructor")).toBe(false);
    expect(isModelSelection("toString")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { MODEL_PRESETS, isModelPreset, resolveModelSelection } from "./model-presets";

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

  test("premium inference is never the default preset", () => {
    expect(MODEL_PRESETS.reasoning.tier).toBe("premium");
    expect(Object.keys(MODEL_PRESETS)[0]).toBe("cloudflare");
  });
});

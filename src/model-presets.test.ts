import { describe, expect, test } from "bun:test";
import { MODEL_PRESETS, isModelPreset } from "./model-presets";

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
    expect(MODEL_PRESETS.cloudflare.id).toStartWith("@cf/");
  });

  test("every optional model is a native OpenRouter model", () => {
    for (const [id, preset] of Object.entries(MODEL_PRESETS)) {
      if (id === "cloudflare") continue;
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

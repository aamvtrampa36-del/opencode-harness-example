/**
 * Intentional small allowlist. A model here is NOT automatically available:
 * OpenRouter options require a configured OPENROUTER_API_KEY and a successful
 * native-provider registration. Keep provider model IDs pinned to actual models.
 */
export const MODEL_PRESETS = {
  cloudflare: {
    label: "Cloudflare · GPT-OSS 20B",
    providerID: "cloudflare",
    id: "@cf/openai/gpt-oss-20b",
    tier: "baseline"
  },
  economy: {
    label: "Económico · DeepSeek Flash",
    providerID: "openrouter",
    id: "deepseek/deepseek-v4.1-flash-1017",
    tier: "economy"
  },
  reasoning: {
    label: "Avanzado · Gemini 4 Argon",
    providerID: "openrouter",
    id: "google/gemini-4-argon",
    tier: "premium"
  },
  creative: {
    label: "Creativo · Gemini 3.8 Flash",
    providerID: "openrouter",
    id: "google/gemini-3.8-flash",
    tier: "creative"
  },
  review: {
    label: "Revisión · GLM 5.3 Flash",
    providerID: "openrouter",
    id: "z-ai/glm-5.3-flash",
    tier: "review"
  }
} as const;

export type ModelPresetID = keyof typeof MODEL_PRESETS;

export function isModelPreset(value: unknown): value is ModelPresetID {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MODEL_PRESETS, value);
}

/** Keep the simple presets, but permit a model verified by the OpenRouter catalogue. */
export type ModelSelectionID = ModelPresetID | `openrouter:${string}`;

export const OPENROUTER_AUTO = ["openrouter/auto", "openrouter/auto-code"] as const;

export function isOpenRouterSelection(value: unknown): value is `openrouter:${string}` {
  return typeof value === "string" && value.length <= 160 &&
    /^openrouter:[a-z0-9][a-z0-9._:+/-]*/[a-z0-9][a-z0-9._:+/-]*$/i.test(value);
}

export function isModelSelection(value: unknown): value is ModelSelectionID {
  return isModelPreset(value) || isOpenRouterSelection(value);
}

export function resolveModelSelection(selection: ModelSelectionID): {
  providerID: "cloudflare" | "openrouter"; id: string
} {
  if (isModelPreset(selection)) return MODEL_PRESETS[selection];
  if (isOpenRouterSelection(selection)) return {
    providerID: "openrouter", id: selection.slice("openrouter:".length)
  };
  throw new Error("Selección de modelo inválida");
}


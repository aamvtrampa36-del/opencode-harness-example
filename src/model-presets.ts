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

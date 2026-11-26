/**
 * Intentional small allowlist. A model here is NOT automatically available:
 * OpenRouter options require a configured OPENROUTER_API_KEY and a successful
 * native-provider registration. Keep provider model IDs pinned to actual models.
 */
export const MODEL_PRESETS = {
  cloudflare: {
    label: "Cloudflare · GLM-4.7 Flash",
    providerID: "cloudflare",
    id: "@cf/zai-org/glm-4.7-flash",
    tier: "baseline"
  },
  economy: {
    // Cloudflare-hosted inference uses the existing AI binding, not an OpenRouter API key.
    label: "Cloudflare · DeepSeek V4.1 Flash",
    providerID: "cloudflare",
    id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
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

/** Explicit provider registration is required before OpenCode can select these models. */
export const NATIVE_WORKERS_AI_MODELS = Object.values(MODEL_PRESETS)
  .filter(preset => preset.providerID === "cloudflare")
  .map(preset => preset.id);

export type ModelPresetID = keyof typeof MODEL_PRESETS;

export function isModelPreset(value: unknown): value is ModelPresetID {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MODEL_PRESETS, value);
}

/** Keep the simple presets, but permit a model verified by the OpenRouter catalogue. */
export type ModelSelectionID = ModelPresetID | `openrouter:${string}`;

export const OPENROUTER_AUTO = ["openrouter/auto", "openrouter/auto-code"] as const;

export function isOpenRouterSelection(value: unknown): value is `openrouter:${string}` {
  return typeof value === "string" && value.length <= 160 &&
    new RegExp("^openrouter:[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._:+-]*$", "i").test(value);
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

/** Never silently replace a native Workers AI preset when OpenRouter is disconnected. */
export function usableModelSelection(selection: ModelSelectionID, openRouterAvailable: boolean): ModelSelectionID {
  return !openRouterAvailable && resolveModelSelection(selection).providerID === "openrouter"
    ? "cloudflare" : selection;
}


/** Metered tasks must use explicit, fresh provider capability evidence.
 * The legacy UI convenience fallback above is not an authorization. */
export function resolveAuthorizedMeteredSelection(selection:ModelSelectionID,evidence:{
  providerID:string;modelID:string;registered:boolean;tools:boolean;validUntil:number;evidenceId:string
},now=Date.now()){
  const resolved=resolveModelSelection(selection);
  if(!evidence||evidence.providerID!==resolved.providerID||evidence.modelID!==resolved.id||
    evidence.registered!==true||evidence.tools!==true||!Number.isSafeInteger(evidence.validUntil)||
    evidence.validUntil<=now||!(/^[a-f0-9]{64}$/).test(evidence.evidenceId))throw Error("METERED_MODEL_CAPABILITY_UNVERIFIED");
  return resolved;
}

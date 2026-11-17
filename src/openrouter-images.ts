import { isOpenRouterSelection } from "./model-presets";

export type OpenRouterImageModel = {
  id: string;
  name: string;
};

export type GeneratedImage = {
  data: string;
  mime: string;
  cost: number | null;
};

const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/images/models";
const GENERATE_ENDPOINT = "https://openrouter.ai/api/v1/images";
const MAX_PROMPT_LENGTH = 8_000;
const MAX_IMAGE_BASE64_LENGTH = 10_000_000;
const CACHE_MS = 10 * 60_000;
const defaultFetch = fetch;
let cached: { at: number; models: OpenRouterImageModel[] } | null = null;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function parseOpenRouterImageModels(payload: unknown): OpenRouterImageModel[] {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) throw new Error("Catálogo de modelos de imagen inválido");
  const models = new Map<string, OpenRouterImageModel>();
  for (const item of data) {
    const entry = record(item);
    if (!entry) continue;
    const id = entry?.id;
    if (typeof id !== "string" || !isOpenRouterSelection("openrouter:" + id) ||
        id === "openrouter/auto" || id === "openrouter/auto-code" || id.endsWith(":batch")) continue;
    models.set(id, { id, name: typeof entry.name === "string" ? entry.name.slice(0, 130) : id });
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getOpenRouterImageModels(
  apiKey: string,
  request: typeof fetch = fetch
): Promise<OpenRouterImageModel[]> {
  if (!apiKey) throw new Error("Conecta OpenRouter para consultar los modelos de imagen.");
  if (request === defaultFetch && cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const response = await request(MODELS_ENDPOINT, {
    headers: { Accept: "application/json", Authorization: "Bearer " + apiKey },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("No se pudo consultar el catálogo de imágenes (" + response.status + ")");
  const models = parseOpenRouterImageModels(await response.json());
  if (request === defaultFetch) cached = { at: Date.now(), models };
  return models;
}

export async function assertOpenRouterImageModel(
  model: string,
  apiKey: string,
  request: typeof fetch = fetch
): Promise<void> {
  if (!isOpenRouterSelection("openrouter:" + model) ||
      model === "openrouter/auto" || model === "openrouter/auto-code") {
    throw new Error("Selecciona un modelo concreto para generar imágenes.");
  }
  const models = await getOpenRouterImageModels(apiKey, request);
  if (!models.some(entry => entry.id === model)) {
    throw new Error("El modelo de imagen no está disponible en OpenRouter. Elige otro del catálogo.");
  }
}

export async function generateOpenRouterImage(input: {
  apiKey: string;
  model: string;
  prompt: string;
}, request: typeof fetch = fetch): Promise<GeneratedImage> {
  const prompt = input.prompt.trim();
  if (!input.apiKey) throw new Error("Conecta OpenRouter antes de generar imágenes.");
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error("La descripción debe tener entre 1 y 8000 caracteres.");
  await assertOpenRouterImageModel(input.model, input.apiKey, request);
  const response = await request(GENERATE_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer " + input.apiKey
    },
    body: JSON.stringify({ model: input.model, prompt }),
    signal: AbortSignal.timeout(120_000)
  });
  const payload = record(await response.json().catch(() => undefined));
  if (!response.ok) {
    const error = record(payload?.error);
    throw new Error(typeof error?.message === "string"
      ? "OpenRouter: " + error.message.slice(0, 300)
      : "OpenRouter no pudo generar la imagen (" + response.status + ").");
  }
  const first = Array.isArray(payload?.data) ? record(payload.data[0]) : undefined;
  const data = first?.b64_json;
  if (typeof data !== "string" || data.length > MAX_IMAGE_BASE64_LENGTH ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error("OpenRouter no devolvió una imagen base64 válida.");
  }
  const usage = record(payload?.usage);
  const cost = typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
    ? usage.cost : null;
  return {
    data,
    mime: typeof first?.media_type === "string" && /^image\/(png|jpeg|webp|svg\+xml)$/.test(first.media_type)
      ? first.media_type : "image/png",
    cost
  };
}

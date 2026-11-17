import { OPENROUTER_AUTO, isOpenRouterSelection } from "./model-presets";

export type OpenRouterCatalogModel = {
  id: string;
  name: string;
  contextLength: number | null;
  promptPerMillion: number | null;
  completionPerMillion: number | null;
  tools: true;
  imageInput: boolean;
};

/** OpenRouter's meta-router chooses only models marked free by its catalogue. */
export const OPENROUTER_FREE = "openrouter/free" as const;

/** Public catalogue: no API credential is returned to the browser. */
const ENDPOINT = "https://openrouter.ai/api/v1/models";
const TTL_MS = 10 * 60_000;
const defaultFetch = fetch;
let cache: { at: number; models: OpenRouterCatalogModel[] } | null = null;

const price = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : null;
};

export function parseOpenRouterCatalogue(payload: unknown): OpenRouterCatalogModel[] {
  if (!payload || typeof payload !== "object" || !("data" in payload) ||
      !Array.isArray(payload.data)) throw new Error("Catálogo OpenRouter inválido");
  const byId = new Map<string, OpenRouterCatalogModel>();
  for (const entry of payload.data) {
    if (!entry || typeof entry !== "object") continue;
    const data = entry as Record<string, unknown>;
    const id = data.id;
    if (typeof id !== "string" || !isOpenRouterSelection("openrouter:" + id)) continue;
    // OpenCode resolves the trailing colon as a model variant. OpenRouter's
    // :batch catalogue entry currently reaches that resolver as
    // `...gemini-4-hydrogen:batch` and fails before inference, so don't offer
    // batch variants until the harness can resolve them correctly.
    if (id.endsWith(":batch")) continue;
    const declared = data.supported_parameters;
    const supportsTools = OPENROUTER_AUTO.some(auto => auto === id) ||
      (Array.isArray(declared) && declared.includes("tools"));
    if (!supportsTools) continue;
    const pricing = (data.pricing && typeof data.pricing === "object")
      ? data.pricing as Record<string, unknown> : {};
    const architecture = data.architecture && typeof data.architecture === "object"
      ? data.architecture as Record<string, unknown> : {};
    const inputModalities = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities : [];
    byId.set(id, {
      id,
      name: typeof data.name === "string" ? data.name.slice(0, 130) : id,
      contextLength: typeof data.context_length === "number" && data.context_length > 0
        ? data.context_length : null,
      promptPerMillion: OPENROUTER_AUTO.some(auto => auto === id)
        ? null : price(pricing.prompt),
      completionPerMillion: OPENROUTER_AUTO.some(auto => auto === id)
        ? null : price(pricing.completion),
      tools: true,
      imageInput: inputModalities.includes("image")
    });
  }
  // Auto and Auto Code have official stable identifiers; the catalogue
  // sometimes omits router metadata while an inventory is being refreshed.
  for (const id of OPENROUTER_AUTO) {
    if (!byId.has(id)) byId.set(id, {
      id, name: id === "openrouter/auto" ? "Auto Router" : "Auto Code",
      contextLength: null, promptPerMillion: null, completionPerMillion: null,
      tools: true, imageInput: false
    });
  }
  // This official meta-router is occasionally absent while the public inventory refreshes.
  // Keep the explicit free-only choice available, with its documented zero price.
  if (!byId.has(OPENROUTER_FREE)) byId.set(OPENROUTER_FREE, {
    id: OPENROUTER_FREE, name: "Free Models Router · siempre gratis",
    contextLength: null, promptPerMillion: 0, completionPerMillion: 0,
    tools: true, imageInput: false
  });
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Unknown or partially listed prices are deliberately not treated as free. */
export function isOpenRouterFreeModel(model: Pick<OpenRouterCatalogModel,
  "promptPerMillion" | "completionPerMillion">): boolean {
  return model.promptPerMillion === 0 && model.completionPerMillion === 0;
}

export async function getOpenRouterCatalogue(
  request: typeof fetch = fetch
): Promise<OpenRouterCatalogModel[]> {
  if (request === defaultFetch && cache && Date.now() - cache.at < TTL_MS) return cache.models;
  const response = await request(ENDPOINT, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("No se pudo consultar OpenRouter (" + response.status + ")");
  const payload: unknown = await response.json();
  const models = parseOpenRouterCatalogue(payload);
  if (request === defaultFetch) cache = { at: Date.now(), models };
  return models;
}

export async function assertOpenRouterModelSupportsTools(id: string): Promise<void> {
  if (OPENROUTER_AUTO.some(router => router === id) || id === OPENROUTER_FREE) return;
  const models = await getOpenRouterCatalogue();
  if (!models.some(item => item.id === id))
    throw new Error("Modelo OpenRouter no disponible o sin soporte de herramientas. Elige otro modelo.");
}

export async function assertOpenRouterModelSupportsImageInput(
  id: string,
  request: typeof fetch = fetch
): Promise<void> {
  const models = await getOpenRouterCatalogue(request);
  if (!models.some(item => item.id === id && item.imageInput)) {
    throw new Error("Este modelo no acepta imágenes. Elige uno compatible con imágenes en OpenRouter.");
  }
}

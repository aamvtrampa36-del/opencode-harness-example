import { OPENROUTER_AUTO, isOpenRouterSelection } from "./model-presets";

export type OpenRouterCatalogModel = {
  id: string;
  name: string;
  contextLength: number | null;
  promptPerMillion: number | null;
  completionPerMillion: number | null;
  tools: true;
};

/** Public catalogue: no API credential is returned to the browser. */
const ENDPOINT = "https://openrouter.ai/api/v1/models";
const TTL_MS = 10 * 60_000;
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
    const declared = data.supported_parameters;
    const supportsTools = OPENROUTER_AUTO.some(auto => auto === id) ||
      (Array.isArray(declared) && declared.includes("tools"));
    if (!supportsTools) continue;
    const pricing = (data.pricing && typeof data.pricing === "object")
      ? data.pricing as Record<string, unknown> : {};
    byId.set(id, {
      id,
      name: typeof data.name === "string" ? data.name.slice(0, 130) : id,
      contextLength: typeof data.context_length === "number" && data.context_length > 0
        ? data.context_length : null,
      promptPerMillion: OPENROUTER_AUTO.some(auto => auto === id)
        ? null : price(pricing.prompt),
      completionPerMillion: OPENROUTER_AUTO.some(auto => auto === id)
        ? null : price(pricing.completion),
      tools: true
    });
  }
  // Auto and Auto Code have official stable identifiers; the catalogue
  // sometimes omits router metadata while an inventory is being refreshed.
  for (const id of OPENROUTER_AUTO) {
    if (!byId.has(id)) byId.set(id, {
      id, name: id === "openrouter/auto" ? "Auto Router" : "Auto Code",
      contextLength: null, promptPerMillion: null, completionPerMillion: null, tools: true
    });
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getOpenRouterCatalogue(
  request: typeof fetch = fetch
): Promise<OpenRouterCatalogModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  const response = await request(ENDPOINT, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("No se pudo consultar OpenRouter (" + response.status + ")");
  const payload: unknown = await response.json();
  const models = parseOpenRouterCatalogue(payload);
  cache = { at: Date.now(), models };
  return models;
}

export async function assertOpenRouterModelSupportsTools(id: string): Promise<void> {
  if (OPENROUTER_AUTO.some(router => router === id)) return;
  const models = await getOpenRouterCatalogue();
  if (!models.some(item => item.id === id))
    throw new Error("Modelo OpenRouter no disponible o sin soporte de herramientas. Elige otro modelo.");
}

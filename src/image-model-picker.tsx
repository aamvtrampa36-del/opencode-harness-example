import { useEffect, useId, useState } from "react";
import type { OpenRouterImageModel } from "./openrouter-images";

export function ImageModelPicker({ value, onChange, routerReady, disabled = false }:
  { value: string; onChange: (value: string) => void; routerReady: boolean; disabled?: boolean }) {
  const [models, setModels] = useState<OpenRouterImageModel[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const searchId = useId();
  const valueInCatalog = models.some(model => model.id === value);
  const query = search.trim().toLowerCase();
  const filteredModels = models.filter(model => !query || model.name.toLowerCase().includes(query) ||
    model.id.toLowerCase().includes(query));
  const selectedModel = models.find(model => model.id === value);
  const selectedFilteredOut = Boolean(selectedModel && !filteredModels.some(model => model.id === value));
  useEffect(() => {
    if (!routerReady || models.length) return;
    let active = true;
    setLoading(true);
    void fetch("/api/settings/openrouter/image-models", { cache: "no-store" })
      .then(async response => {
        const body = await response.json() as { models?: OpenRouterImageModel[]; error?: string };
        if (!response.ok || !Array.isArray(body.models)) throw new Error(body.error || "Catálogo de imágenes no disponible");
        if (active) { setModels(body.models); setMessage(""); }
      })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : "Catálogo no disponible"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [routerReady, models.length]);

  return (
    <div className="space-y-2 text-xs">
      <label className="block space-y-1" htmlFor={searchId}>
        Buscar modelo de imagen
        <input id={searchId} type="search" value={search} onChange={event => setSearch(event.target.value)}
          disabled={disabled || !routerReady || loading} placeholder="Nombre o identificador"
          autoComplete="off" className="w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        Modelo de generación de imágenes
      <select className="w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm"
        value={value} disabled={disabled || !routerReady || loading}
        onChange={event => onChange(event.target.value)}>
        <option value="">Sin modelo de imagen</option>
        {value && !valueInCatalog ? <option value={value}>{value} · ya configurado</option> : null}
        {selectedFilteredOut ? <option value={value}>{selectedModel!.name} · seleccionado</option> : null}
        {filteredModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
      </select>
      </label>
      {!routerReady ? <span className="block text-kumo-subtle">Conecta OpenRouter para usar esta opción.</span> : null}
      {loading ? <span className="block text-kumo-subtle">Cargando modelos de imagen…</span> : null}
      {routerReady && !loading && query && filteredModels.length === 0
        ? <span className="block text-kumo-subtle">No hay modelos que coincidan.</span> : null}
      {message ? <span role="alert" className="block text-kumo-danger">{message}</span> : null}
      <span className="block text-kumo-subtle">El modelo solo se usa cuando solicitas crear una imagen.</span>
    </div>
  );
}

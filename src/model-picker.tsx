import { useEffect, useMemo, useState } from "react";
import {
  MODEL_PRESETS, OPENROUTER_AUTO, isModelPreset,
  type ModelSelectionID
} from "./model-presets";
import type { OpenRouterCatalogModel } from "./openrouter-catalog";

type PickerProps = {
  value: ModelSelectionID;
  onChange: (value: ModelSelectionID) => void;
  routerReady: boolean;
  disabled?: boolean;
};

const routerName = (id: string) =>
  id === "openrouter/auto" ? "Auto Router · general" :
  id === "openrouter/auto-code" ? "Auto Code · programación" : id;

const money = (n: number | null) =>
  n === null ? "Precio variable o no publicado" : "$" + n.toFixed(n < 0.01 ? 4 : 2);

export function ModelPicker({ value, onChange, routerReady, disabled = false }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<"simple" | "advanced">("simple");
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<OpenRouterCatalogModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");

  useEffect(() => {
    if (!open || level !== "advanced" || !routerReady || models.length) return;
    let ignore = false;
    setLoading(true);
    void fetch("/api/settings/openrouter/models", { cache: "no-store" })
      .then(async response => {
        const body = await response.json() as { models?: OpenRouterCatalogModel[]; error?: string };
        if (!response.ok || !Array.isArray(body.models))
          throw new Error(body.error || "No se pudo consultar el catálogo");
        if (!ignore) { setModels(body.models); setCatalogError(""); }
      })
      .catch(error => {
        if (!ignore) setCatalogError(error instanceof Error ? error.message : "Catálogo no disponible");
      })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [open, level, routerReady, models.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter(m => !q || m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)).slice(0, 80);
  }, [models, search]);

  const current = isModelPreset(value) ? MODEL_PRESETS[value].label :
    models.find(m => "openrouter:" + m.id === value)?.name ||
    routerName(value.slice("openrouter:".length));

  const pick = (next: ModelSelectionID) => { onChange(next); setOpen(false); };

  return (
    <div className="shrink-0">
      <button type="button" disabled={disabled} aria-label={`Elegir modelo de IA: ${current}`}
        aria-haspopup="dialog" aria-expanded={open}
        className="flex min-h-10 max-w-[42vw] items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-sm font-medium hover:bg-kumo-elevated disabled:opacity-50 sm:max-w-[240px]"
        onClick={() => { setLevel(isModelPreset(value) ? "simple" : "advanced"); setOpen(true); }}>
        <span className="truncate">{current}</span>
        <span aria-hidden="true" className="text-kumo-subtle">⌄</span>
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/45 sm:items-center sm:p-4"
          onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-label="Seleccionar modelo"
            className="flex max-h-[86dvh] w-full max-w-[460px] flex-col overflow-hidden rounded-t-[28px] border border-kumo-line bg-kumo-base p-4 pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-[28px] sm:pb-4">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Elegir modelo</h2>
              <button type="button" aria-label="Cerrar selector" className="rounded-xl px-3 py-2 hover:bg-kumo-elevated"
                onClick={() => setOpen(false)}>Cerrar</button>
            </div>
            <div className="mb-3 grid grid-cols-2 rounded-xl bg-kumo-elevated p-1 text-sm">
              <button type="button" onClick={() => setLevel("simple")}
                aria-pressed={level === "simple"}
                className={`rounded-lg px-3 py-2 ${level === "simple" ? "bg-kumo-base font-semibold shadow-sm" : ""}`}>
                Simple
              </button>
              <button type="button" onClick={() => setLevel("advanced")}
                aria-pressed={level === "advanced"}
                className={`rounded-lg px-3 py-2 ${level === "advanced" ? "bg-kumo-base font-semibold shadow-sm" : ""}`}>
                OpenRouter
              </button>
            </div>
            {level === "simple" ? (
              <div className="min-h-0 space-y-1 overflow-y-auto" role="listbox" aria-label="Perfiles sencillos">
                {Object.entries(MODEL_PRESETS).map(([id, preset]) => (
                  <button key={id} type="button" role="option" aria-selected={value === id}
                    disabled={preset.providerID === "openrouter" && !routerReady}
                    className={`flex min-h-12 w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm hover:bg-kumo-elevated disabled:opacity-40 ${value === id ? "bg-kumo-elevated font-semibold" : ""}`}
                    onClick={() => pick(id as ModelSelectionID)}>
                    <span>{preset.label}</span><span aria-hidden="true">{value === id ? "✓" : ""}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex min-h-0 flex-col gap-3">
                {!routerReady ? (
                  <p className="rounded-xl bg-kumo-elevated p-3 text-sm">Conecta tu clave de OpenRouter en Configuración para utilizar estos modelos.</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {OPENROUTER_AUTO.map(id => (
                        <button key={id} type="button"
                          aria-pressed={value === "openrouter:" + id}
                          className={`min-h-14 rounded-xl border p-2 text-left text-sm hover:bg-kumo-elevated ${value === "openrouter:" + id ? "border-kumo-accent bg-kumo-elevated" : "border-kumo-line"}`}
                          onClick={() => pick(("openrouter:" + id) as ModelSelectionID)}>
                          <strong className="block">{routerName(id)}</strong>
                          <span className="text-xs text-kumo-subtle">Costo según el modelo elegido</span>
                        </button>
                      ))}
                    </div>
                    <label htmlFor="or-model-search" className="text-xs text-kumo-subtle">
                      Buscar modelos con soporte de herramientas
                    </label>
                    <input id="or-model-search" type="search" autoComplete="off"
                      value={search} onChange={event => setSearch(event.target.value)}
                      placeholder="Nombre o identificador del modelo"
                      className="min-h-11 w-full rounded-xl border border-kumo-line bg-kumo-base px-3 text-sm outline-none focus:ring-2 focus:ring-kumo-ring" />
                    <div className="min-h-0 space-y-1 overflow-y-auto overscroll-contain" role="listbox"
                      aria-label="Modelos OpenRouter" style={{ maxHeight: "42dvh" }}>
                      {loading ? <p className="p-3 text-sm">Cargando catálogo…</p> : null}
                      {catalogError ? <p role="alert" className="p-3 text-sm text-kumo-danger">{catalogError}</p> : null}
                      {filtered.map(model => (
                        <button key={model.id} type="button" role="option" aria-selected={value === "openrouter:" + model.id}
                          className={`block w-full rounded-xl px-3 py-2.5 text-left hover:bg-kumo-elevated ${value === "openrouter:" + model.id ? "bg-kumo-elevated" : ""}`}
                          onClick={() => pick(("openrouter:" + model.id) as ModelSelectionID)}>
                          <span className="block truncate text-sm font-medium">{model.name}</span>
                          <span className="block truncate text-xs text-kumo-subtle">{model.id}</span>
                          <span className="block text-xs text-kumo-subtle">
                            {model.contextLength ? Math.round(model.contextLength / 1000) + "k contexto · " : ""}
                            {model.promptPerMillion === null ? "Costo variable" :
                              money(model.promptPerMillion) + " entrada / " +
                              money(model.completionPerMillion) + " salida por millón de tokens"}
                          </span>
                        </button>
                      ))}
                      {!loading && !catalogError && filtered.length === 0
                        ? <p className="p-3 text-sm text-kumo-subtle">Sin modelos coincidentes.</p> : null}
                    </div>
                    {filtered.length === 80 ? <p className="text-xs text-kumo-subtle">Mostrando 80 resultados. Escribe más para filtrar.</p> : null}
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

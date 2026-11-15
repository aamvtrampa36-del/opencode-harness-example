import { AgentCheckPanel } from "./agent-check-panel";
import { McpPanel } from "./mcp-panel";
import { SpecializationsPanel } from "./specializations-panel";
import { ConnectorPanel } from "./connector-panel";
import { useEffect, useState } from "react";
import { MODEL_PRESETS } from "./model-presets";
import { ImageModelPicker } from "./image-model-picker";

type ConnectionState = {
  openRouterConfigured: boolean;
  githubConfigured: boolean;
};
type ProviderName = "openrouter" | "github";
type Usage = {
  label?: string;
  usage?: number;
  usage_daily?: number;
  usage_monthly?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
};

export function SettingsPanel({
  workspace,
  onClose,
  onChanged,
  onImageModelSaved
}: {
  workspace: string;
  onClose: () => void;
  onChanged: () => void;
  onImageModelSaved: (model: string) => void;
}) {
  const [tab, setTab] = useState<"models" | "connections" | "tools">("models");
  const [connected, setConnected] = useState<ConnectionState | null>(null);
  const [provider, setProvider] = useState<ProviderName>("openrouter");
  const [key, setKey] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [newRepository, setNewRepository] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [imageSaving, setImageSaving] = useState(false);
  const [imageNotice, setImageNotice] = useState("");

  async function load() {
    const response = await fetch("/api/settings", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo consultar la configuración.");
    setConnected(await response.json() as ConnectionState);
  }
  async function loadRepositories() {
    const response = await fetch("/api/settings/repositories", { cache: "no-store" });
    if (response.ok) {
      const body = await response.json() as { repositories: string[] };
      setRepositories(body.repositories);
    }
  }
  useEffect(() => {
    void load().catch((err: unknown) => setNotice(String(err)));
    void loadRepositories();
    void fetch("/api/settings/image-model", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("No se pudo cargar el modelo de imagen.");
        const result = await response.json() as { imageModel?: string };
        setImageModel(result.imageModel ?? "");
      })
      .catch(error => setImageNotice(error instanceof Error ? error.message : "No se pudo cargar el modelo."));
  }, []);
  async function saveImageModel(model: string) {
    if (imageSaving || model === imageModel) return;
    setImageSaving(true);
    setImageNotice("");
    try {
      const response = await fetch("/api/settings/image-model", {
        method: model ? "POST" : "DELETE",
        ...(model ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageModel: model }) } : {})
      });
      const result = await response.json() as { imageModel?: string | null; error?: string };
      if (!response.ok) throw new Error(result.error ?? "No se pudo guardar el modelo.");
      const saved = result.imageModel ?? "";
      setImageModel(saved);
      setImageNotice(saved ? "Guardado y listo para usar en esta conversación." : "Modelo de imagen desactivado.");
      onImageModelSaved(saved);
    } catch (error) {
      setImageNotice(error instanceof Error ? error.message : "No se pudo guardar el modelo.");
    } finally {
      setImageSaving(false);
    }
  }
  async function changeRepository(action: "POST" | "DELETE", repository: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/settings/repositories", {
        method: action,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "No se pudo actualizar el repositorio.");
      setNewRepository("");
      setNotice(action === "POST" ? "Acceso autorizado y verificado con GitHub." : "Autorización retirada.");
      await loadRepositories();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Error actualizando repositorios.");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!key.trim() || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/settings/" + provider, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, workspace })
      });
      const result = await response.json() as { error?: string; activeOnCurrentHost?: boolean; usage?: Usage };
      if (!response.ok) throw new Error(result.error ?? "La conexión no se pudo guardar.");
      setKey("");
      setNotice("Credencial verificada y almacenada en el servidor.");
      if (provider === "openrouter") {
        setReloadNeeded(true);
        setUsage(result.usage ?? null);
      }
      await load();
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Error de conexión.");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/settings/" + provider, {
        method: "DELETE"
      });
      if (!response.ok) throw new Error("No se pudo desconectar el proveedor.");
      setKey("");
      setUsage(null);
      setNotice("Desactivado en OpenCode Cloud. Revoca también el token desde la web del proveedor para invalidarlo definitivamente.");
      setReloadNeeded(true);
      await load();
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function checkUsage() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
      if (!response.ok) throw new Error("No fue posible obtener el consumo.");
      const result = await response.json() as { usage: Usage | null };
      setUsage(result.usage);
      setNotice(result.usage ? "" : "Conecta OpenRouter primero.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const ready = connected?.[provider === "openrouter" ? "openRouterConfigured" : "githubConfigured"];
  const fieldStyle = "w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default";
  const buttonStyle = "min-h-10 rounded-xl border border-kumo-line px-3 py-2 text-sm font-medium hover:bg-kumo-elevated disabled:opacity-50";
  const tabStyle = "min-h-10 flex-1 rounded-xl px-3 text-sm font-medium transition-colors";
  return (
    <section role="dialog" aria-modal="true" aria-label="Configuración de OpenCode"
      className="w-full rounded-t-[24px] border border-kumo-line bg-kumo-base p-4 sm:rounded-2xl sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Ajustes</h2>
          <p className="mt-0.5 text-xs text-kumo-subtle">Modelos, conexiones y herramientas</p>
        </div>
        <button type="button" className={buttonStyle} onClick={onClose}>Cerrar</button>
      </div>
      <nav role="tablist" aria-label="Secciones de ajustes" className="mt-4 grid grid-cols-3 gap-1 rounded-2xl bg-kumo-elevated p-1">
        {([
          ["models", "Modelos"], ["connections", "Conexiones"], ["tools", "Herramientas"]
        ] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
            className={tabStyle + (tab === id ? " bg-kumo-base shadow-sm" : " text-kumo-subtle")}
            onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      {tab === "models" ? <div role="tabpanel" className="mt-4 max-h-[68dvh] overflow-y-auto overscroll-contain pr-1">
        <div className="rounded-2xl border border-kumo-line p-4">
          <h3 className="text-sm font-semibold">Generación de imágenes</h3>
          <p className="mt-1 text-xs text-kumo-subtle">Elige un modelo una vez. Se guarda automáticamente y queda disponible con “Generar imagen”.</p>
          <div className="mt-3">
            <ImageModelPicker value={imageModel} onChange={value => void saveImageModel(value)}
              routerReady={Boolean(connected?.openRouterConfigured)} disabled={imageSaving} />
          </div>
          {imageSaving ? <p role="status" className="mt-2 text-xs text-kumo-subtle">Guardando…</p> : null}
          {imageNotice ? <p role={imageNotice.includes("no se pudo") || imageNotice.includes("Conecta") ? "alert" : "status"}
            className="mt-2 text-xs text-kumo-subtle">{imageNotice}</p> : null}
          {imageModel ? <p className="mt-2 break-all text-xs text-kumo-subtle">Activo: {imageModel}. Puede tener costo según OpenRouter.</p> : null}
        </div>
        <SpecializationsPanel onChanged={onChanged} routerReady={Boolean(connected?.openRouterConfigured)} />
      </div> : null}

      {tab === "connections" ? <div role="tabpanel" className="mt-4 max-h-[68dvh] space-y-3 overflow-y-auto overscroll-contain pr-1">
        <p className="text-sm text-kumo-subtle">Conecta una vez para todos tus dispositivos. Las claves se guardan en el Worker y no se vuelven a mostrar.</p>
        <div className="flex gap-2">
        {(["openrouter", "github"] as const).map((name) => (
          <button key={name} type="button" className={buttonStyle + (provider === name ? " bg-kumo-elevated" : "")}
            onClick={() => { setProvider(name); setKey(""); setNotice(""); }}>
            {name === "openrouter" ? "OpenRouter" : "GitHub"}
            {connected?.[name === "openrouter" ? "openRouterConfigured" : "githubConfigured"] ? " ✓" : ""}
          </button>
        ))}
        </div>
        <p className="text-sm">{ready ? "Conectado" : "Sin conectar"}</p>
        <label htmlFor="provider-key" className="block text-sm font-medium">
        {provider === "openrouter" ? "Clave API de OpenRouter" : "Token personal de GitHub (fine-grained)"}
        </label>
        <input id="provider-key" type="password" value={key} onChange={(e) => setKey(e.target.value)}
        autoComplete="off" spellCheck={false} className={fieldStyle} placeholder="Introduce tu clave privada" />
        <div className="flex flex-wrap gap-2">
        <button className={buttonStyle} type="button" disabled={busy || !key.trim()} onClick={() => void save()}>
          {busy ? "Comprobando…" : ready ? "Reemplazar clave" : "Conectar y validar"}
        </button>
        {ready ? (
          <button className={buttonStyle} type="button" disabled={busy} onClick={() => void remove()}>
            Desactivar conexión
          </button>
        ) : null}
        {provider === "openrouter" && ready ? (
          <button className={buttonStyle} type="button" disabled={busy} onClick={() => void checkUsage()}>
            Consultar consumo
          </button>
        ) : null}
        {reloadNeeded ? <button className={buttonStyle} type="button" onClick={() => location.reload()}>Actualizar OpenCode</button> : null}
        </div>
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      {provider === "openrouter" ? (
        <div className="space-y-2 rounded-2xl border border-kumo-line p-4">
          {usage ? (
            <p className="text-sm text-kumo-subtle">
              Consumo acumulado: ${(usage.usage ?? 0).toFixed(3)} USD · Este mes: ${(usage.usage_monthly ?? 0).toFixed(3)} USD
              {usage.limit != null ? ` · Tope por clave: $${usage.limit.toFixed(2)} USD` : " · Sin tope por clave confirmado"}
              {usage.limit_remaining != null ? ` · Restante: $${usage.limit_remaining.toFixed(2)} USD` : ""}
            </p>
          ) : null}
          <p className="text-xs text-kumo-subtle">
            Para evitar cargos inesperados, establece un límite real al crear la clave en OpenRouter. Los avisos en esta página no bloquean la facturación.
            {" "}<a className="underline" href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Administrar claves y presupuesto</a>
          </p>
          <p className="text-xs text-kumo-subtle">Modelos preparados: {Object.values(MODEL_PRESETS).filter(m => m.providerID === "openrouter").map(m => m.label).join(" · ")}.</p>
        </div>
      ) : (
        <div className="space-y-3 rounded-2xl border border-kumo-line p-4 text-xs text-kumo-subtle">
          Crea un token de acceso limitado a tus repositorios con permisos de lectura/escritura de contenido y Pull requests.
          {" "}<a className="underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Crear token seguro de GitHub</a>
          {ready ? (
            <span className="mt-3 block space-y-2">
              <span className="block font-medium">Repositorios autorizados</span>
              {repositories.map(name => (
                <span key={name} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 break-all">{name}</span>
                  {["aamvtrampa36-del/cdf-cloud-engine", "aamvtrampa36-del/CDF-WorkBench-", "aamvtrampa36-del/opencode-harness-example"].some(base => base.toLowerCase() === name.toLowerCase())
                    ? null : <button className={buttonStyle} type="button" disabled={busy}
                        onClick={() => void changeRepository("DELETE", name)}>Retirar</button>}
                </span>
              ))}
              <label htmlFor="repository-name" className="block">Añadir otro repositorio propio</label>
              <input id="repository-name" className={fieldStyle} value={newRepository}
                placeholder="aamvtrampa36-del/mi-proyecto" onChange={e => setNewRepository(e.target.value)} />
              <button className={buttonStyle} type="button" disabled={busy || !newRepository.trim()}
                onClick={() => void changeRepository("POST", newRepository)}>Autorizar y verificar</button>
              <span className="block">GitHub debe permitir el acceso a ese repositorio con el token conectado.</span>
            </span>
          ) : null}
        </div>
      )}
      </div> : null}

      {tab === "tools" ? <div role="tabpanel" className="mt-4 max-h-[68dvh] space-y-4 overflow-y-auto overscroll-contain pr-1">
      <ConnectorPanel workspace={workspace} />
      <McpPanel workspace={workspace} />
      <AgentCheckPanel workspace={workspace} />
      </div> : null}
    </section>
  );
}

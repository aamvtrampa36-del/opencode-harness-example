import { AgentCheckPanel } from "./agent-check-panel";
import { McpPanel } from "./mcp-panel";
import { SpecializationsPanel } from "./specializations-panel";
import { useEffect, useState } from "react";
import { MODEL_PRESETS } from "./model-presets";

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
  onChanged
}: {
  workspace: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [connected, setConnected] = useState<ConnectionState | null>(null);
  const [provider, setProvider] = useState<ProviderName>("openrouter");
  const [key, setKey] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [newRepository, setNewRepository] = useState("");

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
  }, []);
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
  const buttonStyle = "rounded-md border border-kumo-line px-3 py-2 text-sm font-medium hover:bg-kumo-elevated disabled:opacity-50";
  return (
    <section role="dialog" aria-modal="true" aria-label="Configuración de proveedores"
      className="w-full rounded-t-[24px] border border-kumo-line bg-kumo-base p-4 sm:rounded-2xl sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Configuración de OpenCode</h2>
        <button type="button" className={buttonStyle} onClick={onClose}>Cerrar</button>
      </div>
      <p className="mt-2 text-sm text-kumo-subtle">
        Conecta los servicios una sola vez para todos tus dispositivos. Las claves se envían directamente al Worker y nunca se muestran de nuevo.
      </p>
      <div className="mt-3 flex gap-2">
        {(["openrouter", "github"] as const).map((name) => (
          <button key={name} type="button" className={buttonStyle + (provider === name ? " bg-kumo-elevated" : "")}
            onClick={() => { setProvider(name); setKey(""); setNotice(""); }}>
            {name === "openrouter" ? "OpenRouter" : "GitHub"}
            {connected?.[name === "openrouter" ? "openRouterConfigured" : "githubConfigured"] ? " ✓" : ""}
          </button>
        ))}
      </div>
      <p className="mt-3 text-sm">{ready ? "Conectado" : "Sin conectar"}</p>
      <label htmlFor="provider-key" className="mt-3 block text-sm font-medium">
        {provider === "openrouter" ? "Clave API de OpenRouter" : "Token personal de GitHub (fine-grained)"}
      </label>
      <input id="provider-key" type="password" value={key} onChange={(e) => setKey(e.target.value)}
        autoComplete="off" spellCheck={false} className={fieldStyle} placeholder="Introduce tu clave privada" />
      <div className="mt-3 flex flex-wrap gap-2">
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
      {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
      {provider === "openrouter" ? (
        <div className="mt-4 space-y-2">
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
        <p className="mt-4 text-xs text-kumo-subtle">
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
        </p>
      )}
      <SpecializationsPanel onChanged={onChanged} />
      <McpPanel workspace={workspace} />
      <AgentCheckPanel workspace={workspace} />
    </section>
  );
}

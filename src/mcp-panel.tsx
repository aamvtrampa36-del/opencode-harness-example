import { useEffect, useState } from "react";
import type { PublicMcpConfig } from "./mcp-config";

/** Remote-only MCP registry. Credential values never come back to React. */
export function McpPanel({ workspace }: { workspace: string }) {
  const [servers, setServers] = useState<PublicMcpConfig[]>([]);
  const [id, setId] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [authMode, setAuthMode] = useState<"none" | "bearer" | "oauth">("none");
  const [scope, setScope] = useState("");
  const [toolAllowlist, setToolAllowlist] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [connectingId, setConnectingId] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    const response = await fetch("/api/settings/mcp", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo leer la lista MCP");
    const result = await response.json() as { servers: PublicMcpConfig[] };
    setServers(result.servers);
  }
  useEffect(() => { void refresh().catch(e => setMessage(String(e))); }, []);

  async function change(method: "POST" | "DELETE", body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/mcp", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, workspace })
      });
      const result = await response.json() as { error?: string; refreshedCurrentHost?: boolean };
      if (!response.ok) throw new Error(result.error ?? "No se pudo guardar el MCP");
      await refresh();
      setMessage(result.refreshedCurrentHost
        ? "Configuración aplicada. Comprueba herramientas desde la conversación."
        : "Configuración guardada. Se aplicará cuando se inicie otra sesión de OpenCode.");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Error MCP");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function connect(server: PublicMcpConfig) {
    setConnectingId(server.id);
    setMessage("Abriendo la autorización del servidor…");
    try {
      const response = await fetch("/api/settings/mcp/oauth/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: server.id, scope: server.scope, workspace })
      });
      const result = await response.json() as { error?: string; authorizationUrl?: string };
      if (!response.ok || !result.authorizationUrl) throw new Error(result.error ?? "No se pudo iniciar OAuth");
      const authorization = new URL(result.authorizationUrl);
      if (authorization.protocol !== "https:") throw new Error("La dirección de autorización no es HTTPS");
      window.location.assign(authorization.toString());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Error de autorización");
      setConnectingId("");
    }
  }
  const button = "rounded-md border border-kumo-line px-3 py-1.5 text-xs hover:bg-kumo-elevated disabled:opacity-50";
  const input = "w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default";
  function selectCdf(kind: "cloud" | "workbench") {
    if (kind === "cloud") {
      setId("cdf-cloud-production");
      setUrl("https://cdf-cloud-engine-gateway.cdf-cloud-mvp-20261019.workers.dev/mcp");
      setScope("cdf:access");
      setToolAllowlist(["cdf_status", "cdf_manifest", "cdf_documents", "cdf_document", "cdf_history", "cdf_diff",
        "cdf_read_batch", "cdf_original", "cdf_library_search", "cdf_editorial_search", "cdf_narrative_search",
        "cdf_package", "cdf_context", "cdf_context_batch", "cdf_search"]);
    } else {
      setId("cdf-workbench-staging");
      setUrl("https://cdf-workbench-mirror.cdf-cloud-mvp-20261019.workers.dev/mcp");
      setScope("workbench:read offline_access");
      setToolAllowlist(["workbench_status", "workbench_catalog", "workbench_read"]);
    }
    setAuthMode("oauth");
    setToken("");
  }

  return (
    <section className="mt-5 space-y-3 border-t border-kumo-line pt-4" aria-label="Servidores MCP">
      <h3 className="text-sm font-semibold">Herramientas MCP</h3>
      <p className="text-xs text-kumo-subtle">
        Conecta servidores MCP remotos mediante HTTPS, con Bearer u OAuth. Las herramientas se descubren
        directamente desde OpenCode; el acceso OAuth se guarda en tu configuración privada.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={button} type="button" disabled={busy} onClick={() => selectCdf("cloud")}>
          Preparar CDF CLOUD Producción · solo lectura
        </button>
        <button className={button} type="button" disabled={busy} onClick={() => selectCdf("workbench")}>
          Preparar CDF WorkBench Staging
        </button>
      </div>
      {servers.map(server => (
        <div key={server.id} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 break-all">{server.id} · {server.url}
            {server.auth === "oauth" ? (server.connected ? " · OAuth conectado" : " · necesita autorización") :
              server.hasToken ? " · clave privada guardada" : ""}
            {server.toolAllowlist ? ` · solo lectura (${server.toolAllowlist.length} herramientas)` : ""}
            {server.enabled ? " · habilitado" : " · desactivado"}
          </span>
          {server.auth === "oauth" ? <button className={button} disabled={busy || Boolean(connectingId)} type="button"
            onClick={() => void connect(server)}>{connectingId === server.id ? "Conectando…" : server.connected ? "Reconectar" : "Conectar"}</button> : null}
          <button className={button} disabled={busy} type="button"
            onClick={() => void change("POST", { id: server.id, url: server.url, enabled: !server.enabled,
              auth: server.auth, scope: server.scope, toolAllowlist: server.toolAllowlist,
              hasToken: server.hasToken, connected: server.connected })}>
            {server.enabled ? "Desactivar" : "Activar"}
          </button>
          <button className={button} disabled={busy} type="button"
            onClick={() => void change("DELETE", { id: server.id })}>Quitar</button>
        </div>
      ))}
      <label className="block text-xs font-medium" htmlFor="mcp-name">Nombre del MCP</label>
      <input id="mcp-name" className={input} value={id} placeholder="mi-servidor"
        maxLength={40} onChange={e => setId(e.target.value.toLowerCase())} />
      <label className="block text-xs font-medium" htmlFor="mcp-url">URL HTTPS del servidor</label>
      <input id="mcp-url" className={input} value={url} placeholder="https://ejemplo.com/mcp"
        onChange={e => setUrl(e.target.value)} />
      <label className="block text-xs font-medium" htmlFor="mcp-auth">Autenticación</label>
      <select id="mcp-auth" className={input} value={authMode} onChange={e => setAuthMode(e.target.value as typeof authMode)}>
        <option value="none">Sin autenticación</option><option value="bearer">Token Bearer</option><option value="oauth">OAuth (abrirá autorización)</option>
      </select>
      {authMode === "bearer" ? <>
        <label className="block text-xs font-medium" htmlFor="mcp-token">Token Bearer</label>
        <input id="mcp-token" type="password" className={input} value={token} autoComplete="off"
          placeholder="Se guarda de forma privada y no se vuelve a mostrar" onChange={e => setToken(e.target.value)} />
      </> : null}
      {authMode === "oauth" ? <>
        <label className="block text-xs font-medium" htmlFor="mcp-scope">Scopes solicitados</label>
        <input id="mcp-scope" className={input} value={scope} placeholder="workbench:read offline_access"
          onChange={e => setScope(e.target.value)} />
        {toolAllowlist.length ? <p className="text-[11px] text-kumo-subtle">Este perfil expondrá solo herramientas de lectura conocidas ({toolAllowlist.length}).</p> : null}
      </> : null}
      <button className={button} disabled={busy || !id.trim() || !url.trim() || (authMode === "bearer" && !token.trim())} type="button"
        onClick={() => void change("POST", { id, url, token: authMode === "bearer" ? token : undefined,
          auth: authMode, scope: authMode === "oauth" ? scope : undefined,
          ...(toolAllowlist.length ? { toolAllowlist } : {}), enabled: true }).then(async ok => {
          if (ok) { setId(""); setUrl(""); setToken(""); setScope(""); setAuthMode("none"); setToolAllowlist([]); await refresh(); }
        })}>Guardar servidor MCP</button>
      {message ? <p role="status" className="text-xs">{message}</p> : null}
    </section>
  );
}

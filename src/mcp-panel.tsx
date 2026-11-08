import { useEffect, useState } from "react";
import type { PublicMcpConfig } from "./mcp-config";

/** Remote-only MCP registry. Credential values never come back to React. */
export function McpPanel({ workspace }: { workspace: string }) {
  const [servers, setServers] = useState<PublicMcpConfig[]>([]);
  const [id, setId] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
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
  const button = "rounded-md border border-kumo-line px-3 py-1.5 text-xs hover:bg-kumo-elevated disabled:opacity-50";
  const input = "w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default";

  return (
    <section className="mt-5 space-y-3 border-t border-kumo-line pt-4" aria-label="Servidores MCP">
      <h3 className="text-sm font-semibold">Herramientas MCP</h3>
      <p className="text-xs text-kumo-subtle">
        Conecta servidores MCP remotos mediante HTTPS. OpenCode descubrirá sus herramientas.
        Activa solamente los necesarios para reducir consumo de contexto. Las conexiones que requieran OAuth
        interactivo o comandos locales necesitan una integración adicional.
      </p>
      {servers.map(server => (
        <div key={server.id} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 break-all">{server.id} · {server.url}
            {server.hasToken ? " · clave privada guardada" : ""}
            {server.enabled ? " · habilitado" : " · desactivado"}
          </span>
          <button className={button} disabled={busy} type="button"
            onClick={() => void change("POST", { id: server.id, url: server.url, enabled: !server.enabled })}>
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
      <label className="block text-xs font-medium" htmlFor="mcp-token">Token Bearer (opcional)</label>
      <input id="mcp-token" type="password" className={input} value={token} autoComplete="off"
        placeholder="No se mostrará tras guardarlo" onChange={e => setToken(e.target.value)} />
      <button className={button} disabled={busy || !id.trim() || !url.trim()} type="button"
        onClick={() => void change("POST", { id, url, token, enabled: true }).then(ok => {
          if (ok) { setId(""); setUrl(""); setToken(""); }
        })}>Guardar servidor MCP</button>
      {message ? <p role="status" className="text-xs">{message}</p> : null}
    </section>
  );
}

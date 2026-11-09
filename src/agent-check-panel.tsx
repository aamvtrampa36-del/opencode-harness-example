import { useEffect, useState } from "react";
import { AGENT_CHECK_MODELS, isAgentCheckModel, type AgentCheckModel } from "./agent-check";
import { MODEL_PRESETS } from "./model-presets";

type AgentStatus = {
  status: string;
  project?: string;
  toolCalls?: number;
  fileVerified?: boolean;
  reason?: string;
  error?: string;
  message?: string;
  model?: string;
};

/** Explicit owner-initiated test: no cron and no arbitrary user shell. */
export function AgentCheckPanel({ workspace }: { workspace: string }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<AgentCheckModel>("cloudflare");
  const [error, setError] = useState("");

  const refresh = async () => {
    const res = await fetch("/api/dev/agent-check?workspace=" + encodeURIComponent(workspace), {
      cache: "no-store"
    });
    if (!res.ok) throw new Error("No se pudo consultar el estado de la autoprueba");
    setStatus(await res.json() as AgentStatus);
  };

  useEffect(() => {
    void refresh().catch(err => setError(String(err)));
  }, [workspace]);
  useEffect(() => {
    if (!["started", "running", "queued"].includes(status?.status ?? "")) return;
    const timer = setInterval(() => { void refresh().catch(err => setError(String(err))); }, 5_000);
    return () => clearInterval(timer);
  }, [status?.status, workspace]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/dev/agent-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, model })
      });
      if (!response.ok) throw new Error("El servidor rechazó la autoprueba");
      const body = await response.json() as AgentStatus;
      setStatus(body.status === "existing" ? { ...body, status: "queued" } : body);
      if (body.status === "started" || body.status === "existing") await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de autoprueba");
    } finally {
      setBusy(false);
    }
  };
  const stateText = status?.status === "passed" ? "Verificado: OpenCode ejecutó Linux y conservó el archivo."
    : status?.status === "failed" ? "Falló: no se comprobó el ciclo del agente."
    : status?.status === "running" ? "Agente en ejecución…"
    : status?.status === "queued" ? "Tarea pendiente de ejecución…"
    : status?.status === "daily-limit" ? "Límite diario de autopruebas alcanzado."
    : status?.status === "started" ? "Autoprueba iniciada…"
    : "Todavía no se ha ejecutado la autoprueba.";
  return (
    <section className="mt-5 space-y-2 border-t border-kumo-line pt-4" aria-label="Autoprueba del agente">
      <h3 className="text-sm font-semibold">Comprobar autonomía real</h3>
      <p className="text-xs text-kumo-subtle">
        Una prueba opcional, limitada a dos intentos diarios. OpenCode usará el modelo elegido,
        intentará crear un archivo en Linux y comprobará su persistencia real.
        Consume una pequeña cantidad de inferencia; no programa comprobaciones repetidas.
      </p>
      <label className="block text-xs" htmlFor="agent-check-model">Modelo de prueba</label>
      <select id="agent-check-model" value={model} disabled={busy || ["started", "running", "queued"].includes(status?.status ?? "")}
        onChange={event => { if (isAgentCheckModel(event.target.value)) setModel(event.target.value); }}
        className="rounded-md border border-kumo-line bg-transparent px-2 py-2 text-xs">
        {AGENT_CHECK_MODELS.map(id => <option key={id} value={id}>{MODEL_PRESETS[id].label}</option>)}
      </select>
      <p className="text-xs text-kumo-subtle">Los modelos de OpenRouter requieren conectarlo en Configuración.</p>
      <button type="button" disabled={busy || ["started", "running", "queued"].includes(status?.status ?? "")}
        className="rounded-md border border-kumo-line px-3 py-2 text-xs disabled:opacity-50"
        onClick={() => void start()}>Ejecutar autoprueba</button>
      <button type="button" className="ml-2 rounded-md border border-kumo-line px-3 py-2 text-xs"
        onClick={() => void refresh().catch(err => setError(String(err)))}>Actualizar resultado</button>
      <p role="status" className="text-xs">{stateText}
        {typeof status?.toolCalls === "number" ? " · Llamadas a herramientas: " + status.toolCalls : ""}
        {status?.fileVerified ? " · Archivo comprobado" : ""}
      </p>
      {status?.model && isAgentCheckModel(status.model)
        ? <p className="text-xs text-kumo-subtle">Modelo ejecutado: {MODEL_PRESETS[status.model].label}</p> : null}
      {status?.reason || status?.message
        ? <p className="text-xs text-kumo-subtle">{status.reason ?? status.message}</p> : null}
      {error ? <p role="alert" className="text-xs">{error}</p> : null}
    </section>
  );
}

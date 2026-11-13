import { useEffect, useState } from "react";
import { AGENT_CHECK_MODELS, isAgentCheckModel, AGENT_CHECK_KINDS, isAgentCheckKind, type AgentCheckKind, type AgentCheckModel } from "./agent-check";
import { MODEL_PRESETS } from "./model-presets";
import type { IncidentRecord } from "./incident-diagnostics";

type AgentStatus = {
  status: string;
  project?: string;
  toolCalls?: number;
  fileVerified?: boolean;
  reason?: string;
  error?: string;
  message?: string;
  model?: string;
  kind?: string;
  observedFailingTest?: boolean;
};

/** Explicit owner-initiated test: no cron and no arbitrary user shell. */
export function AgentCheckPanel({ workspace }: { workspace: string }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<AgentCheckModel>("cloudflare");
  const [kind, setKind] = useState<AgentCheckKind>("repair");
  const [error, setError] = useState("");
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const [incidentError, setIncidentError] = useState("");
  const [smokeBusy, setSmokeBusy] = useState(false);
  const [smokeResult, setSmokeResult] = useState("");
  const loadIncidents = async () => {
    const response = await fetch("/api/dev/incidents", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo consultar el registro de incidentes");
    const data = await response.json() as { incidents?: IncidentRecord[] };
    setIncidents(data.incidents ?? []);
    setIncidentError("");
    return data.incidents ?? [];
  };

  /** One explicit safe failing Linux command. No LLM calls, no file edits. */
  async function runIncidentSmoke() {
    setSmokeBusy(true);
    setSmokeResult("");
    setIncidentError("");
    try {
      const response = await fetch("/api/dev/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: "g7-diagnostics",
          command: 'node -e "process.exit(19)"'
        })
      });
      const output = await response.json() as { exitCode?: number; error?: string };
      if (!response.ok || output.exitCode !== 19) {
        throw new Error(output.error ?? "La prueba Linux no devolvió el exitCode esperado (19)");
      }
      const recorded = await loadIncidents();
      const entry = recorded.find(row => row.project === "g7-diagnostics"
        && row.source === "linux" && row.code === "SHELL_FAILED" && row.exitCode === 19);
      if (!entry) throw new Error("Linux devolvió 19, pero el incidente no aparece en el registro persistente");
      setSmokeResult("Verificado: Linux devolvió exitCode 19 y el fallo se registró sin utilizar IA.");
    } catch (error) {
      setIncidentError(error instanceof Error ? error.message : "No se completó la prueba de incidentes");
    } finally {
      setSmokeBusy(false);
    }
  }

  const refresh = async () => {
    const res = await fetch("/api/dev/agent-check?workspace=" + encodeURIComponent(workspace), {
      cache: "no-store"
    });
    if (!res.ok) throw new Error("No se pudo consultar el estado de la autoprueba");
    setStatus(await res.json() as AgentStatus);
  };

  useEffect(() => {
    void refresh().catch(err => setError(String(err)));
    void loadIncidents().catch(err => setIncidentError(String(err)));
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
        body: JSON.stringify({ workspace, model, kind })
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
  const stateText = status?.status === "passed" ? (status?.kind === "repair" ? "Verificado: el agente observó el fallo, corrigió código y superó la prueba." : "Verificado: OpenCode ejecutó Linux y conservó el archivo.")
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
        Una prueba opcional, limitada a dos intentos diarios. El modo Reparación exige que la IA
        corrija un programa con una prueba fallida; el servidor comprobará el resultado sin confiar en su respuesta.
        Consume una pequeña cantidad de inferencia; no programa comprobaciones repetidas.
      </p>
      <label className="block text-xs" htmlFor="agent-check-kind">Qué comprobar</label>
      <select id="agent-check-kind" value={kind} disabled={busy || ["started", "running", "queued"].includes(status?.status ?? "")}
        onChange={event => { if (isAgentCheckKind(event.target.value)) setKind(event.target.value); }}
        className="rounded-md border border-kumo-line bg-transparent px-2 py-2 text-xs">
        {AGENT_CHECK_KINDS.map(id => <option key={id} value={id}>{id === "repair" ? "Reparación real de código" : "Herramienta Linux básica"}</option>)}
      </select>
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
        {status?.kind === "repair" && typeof status.observedFailingTest === "boolean"
          ? status.observedFailingTest ? " · Fallo inicial observado" : " · Sin observación de fallo" : ""}
        {status?.fileVerified ? " · Archivo comprobado" : ""}
      </p>
      {status?.kind ? <p className="text-xs text-kumo-subtle">Prueba ejecutada: {status.kind === "repair" ? "Reparación" : "Linux básico"}</p> : null}
      {status?.model && isAgentCheckModel(status.model)
        ? <p className="text-xs text-kumo-subtle">Modelo ejecutado: {MODEL_PRESETS[status.model].label}</p> : null}
      {status?.reason || status?.message
        ? <p className="text-xs text-kumo-subtle">{status.reason ?? status.message}</p> : null}
      {error ? <p role="alert" className="text-xs">{error}</p> : null}
      <div className="mt-5 space-y-2 border-t border-kumo-line pt-4" aria-label="Registro de incidentes G7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Incidentes técnicos</h3>
          <button className="rounded-md border border-kumo-line px-3 py-1.5 text-xs"
            onClick={() => void loadIncidents().catch(err => setIncidentError(String(err)))}
            type="button">Actualizar incidentes</button>
        </div>
        <p className="text-xs text-kumo-subtle">
          Registro automático de errores reales de Linux y del agente. Agrupa incidentes repetidos,
          indica cómo actuar y evita reintentos automáticos equivalentes. No guarda prompts, comandos,
          respuestas ni credenciales.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={smokeBusy}
            className="rounded-md border border-kumo-line px-3 py-2 text-xs disabled:opacity-50"
            onClick={() => void runIncidentSmoke()}>
            {smokeBusy ? "Verificando…" : "Comprobar registro con un fallo real"}
          </button>
          <span className="text-xs text-kumo-subtle">
            Prueba opcional: ejecuta un comando Linux que falla intencionalmente (exitCode 19).
            No gasta tokens de IA ni modifica proyectos existentes; puede iniciar un Container facturable.
          </span>
        </div>
        {smokeResult ? <p role="status" className="text-xs">{smokeResult}</p> : null}
        {incidents.length === 0 ? (
          <p className="text-xs text-kumo-subtle">No hay fallos registrados desde la activación de G7.</p>
        ) : incidents.slice(0, 8).map(item => (
          <div key={item.id} className="rounded-md border border-kumo-line p-2 text-xs">
            <p className="font-semibold">{item.code} · {item.count} {item.count === 1 ? "incidente" : "incidentes"}
              {item.status === "blocked" ? " · Sin reintento automático" : ""}
            </p>
            <p>{item.suspectedCause}</p>
            <p className="text-kumo-subtle">{item.action}</p>
            <p className="text-kumo-subtle">
              {item.source}{item.project ? " · " + item.project : ""}
              {item.exitCode === undefined ? "" : " · exitCode " + item.exitCode}
              {" · Último " + item.lastAt}
            </p>
          </div>
        ))}
        {incidentError ? <p role="alert" className="text-xs">{incidentError}</p> : null}
      </div>
    </section>
  );
}

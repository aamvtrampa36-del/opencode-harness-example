import { useEffect, useState } from "react";

type AgentStatus = {
  status: string;
  project?: string;
  toolCalls?: number;
  fileVerified?: boolean;
  reason?: string;
  error?: string;
};

/** Explicit owner-initiated test: no cron and no arbitrary user shell. */
export function AgentCheckPanel({ workspace }: { workspace: string }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
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
        body: JSON.stringify({ workspace })
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
        Una prueba opcional y limitada a dos intentos diarios. OpenCode utilizará Workers AI,
        intentará crear un archivo mediante Linux y comprobará que persiste realmente.
        Consume una pequeña cantidad de inferencia; no programa comprobaciones repetidas.
      </p>
      <button type="button" disabled={busy || ["started", "running", "queued"].includes(status?.status ?? "")}
        className="rounded-md border border-kumo-line px-3 py-2 text-xs disabled:opacity-50"
        onClick={() => void start()}>Ejecutar autoprueba</button>
      <button type="button" className="ml-2 rounded-md border border-kumo-line px-3 py-2 text-xs"
        onClick={() => void refresh().catch(err => setError(String(err)))}>Actualizar resultado</button>
      <p role="status" className="text-xs">{stateText}
        {typeof status?.toolCalls === "number" ? " · Llamadas a herramientas: " + status.toolCalls : ""}
        {status?.fileVerified ? " · Archivo comprobado" : ""}
      </p>
      {status?.reason ? <p className="text-xs text-kumo-subtle">{status.reason}</p> : null}
      {error ? <p role="alert" className="text-xs">{error}</p> : null}
    </section>
  );
}

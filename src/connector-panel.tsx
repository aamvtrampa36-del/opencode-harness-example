import { useEffect, useState } from "react";

type State = {
  tokenEconomizerEnabled: boolean;
  tokenEconomizerLastHook?: { name: string; at: number; succeeded: boolean };
  tokenEconomizerLastContext?: { at: number; characters: number };
};

export function ConnectorPanel({ workspace }: { workspace: string }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => {
    const response = await fetch("/api/settings/connectors", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo consultar el estado de los conectores.");
    setState(await response.json() as State);
  };
  useEffect(() => {
    void load().catch(error => setMessage(String(error)));
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 6_000);
    return () => window.clearInterval(timer);
  }, []);

  const update = async (action: "install" | "disable") => {
    setBusy(true);
    setMessage(action === "install" ? "Instalando el conector en su Container aislado…" : "Desactivando el conector…");
    try {
      const response = await fetch("/api/settings/connectors/token-economizer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, workspace })
      });
      const result = await response.json() as State & { error?: string; commit?: string };
      if (!response.ok) throw new Error(result.error || "No se pudo actualizar TokenEconomizer.");
      setState(current => ({
        tokenEconomizerEnabled: result.tokenEconomizerEnabled,
        ...(current?.tokenEconomizerLastHook ? { tokenEconomizerLastHook: current.tokenEconomizerLastHook } : {}),
        ...(current?.tokenEconomizerLastContext ? { tokenEconomizerLastContext: current.tokenEconomizerLastContext } : {})
      }));
      setMessage(action === "install"
        ? `TokenEconomizer instalado (${result.commit?.slice(0, 12)}). Usa solo los hechos de entorno sin llamadas adicionales de modelo.`
        : "TokenEconomizer desactivado. Sus archivos aprendidos permanecen en el Container aislado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Error actualizando el conector.");
      await load().catch(() => undefined);
    } finally { setBusy(false); }
  };

  return (
    <section className="mt-5 space-y-2 border-t border-kumo-line pt-4" aria-label="Conectores">
      <h3 className="text-sm font-semibold">Conectores y hooks</h3>
      <p className="text-xs text-kumo-subtle">
        TokenEconomizer se instala desde el repositorio oficial, fijado a un commit, en un Container separado.
        Esta adaptación usa sus hechos de entorno sin llamadas adicionales de modelo ni cambios en las herramientas disponibles.
        El estado de los hooks se actualiza mientras esta pantalla está abierta.
      </p>
      <button type="button" disabled={busy || state === null}
        onClick={() => void update(state?.tokenEconomizerEnabled ? "disable" : "install")}
        className="min-h-10 rounded-lg border border-kumo-line px-3 py-2 text-sm hover:bg-kumo-elevated disabled:opacity-50">
        {busy ? "Procesando…" : state?.tokenEconomizerEnabled ? "Desactivar TokenEconomizer" : "Instalar y activar TokenEconomizer"}
      </button>
      {state?.tokenEconomizerEnabled ? (
        <p role="status" aria-live="polite" className="text-xs text-kumo-subtle">
          {state.tokenEconomizerLastHook
            ? `Último hook: ${state.tokenEconomizerLastHook.name} · ${state.tokenEconomizerLastHook.succeeded ? "ejecutado" : "falló; el chat sigue disponible"} · ${new Date(state.tokenEconomizerLastHook.at).toLocaleTimeString()}. ${state.tokenEconomizerLastContext ? `Último contexto devuelto: ${state.tokenEconomizerLastContext.characters} caracteres · ${new Date(state.tokenEconomizerLastContext.at).toLocaleTimeString()}.` : "Todavía no se devolvió contexto reutilizable; la evidencia se acumula entre tareas."}`
            : "Activado, pero todavía no se registran hooks. Envía una tarea para comprobarlo."}
        </p>
      ) : null}
      {message ? <p role="status" className="text-xs text-kumo-subtle">{message}</p> : null}
    </section>
  );
}

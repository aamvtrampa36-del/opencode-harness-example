import { useEffect, useState } from "react";
import type { Specialization } from "./specializations";

type ApiList = { specializations: Specialization[] };

function slug(name: string): string {
  const value = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return value.length < 2 ? "perfil-" + Date.now().toString(36) : value;
}

export function SpecializationsPanel({ onChanged }: { onChanged: () => void }) {
  const [profiles, setProfiles] = useState<Specialization[]>([]);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = async () => {
    const response = await fetch("/api/settings/specializations", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudieron leer las especializaciones");
    const result = await response.json() as ApiList;
    setProfiles(result.specializations);
    onChanged();
  };
  useEffect(() => { void refresh().catch(e => setMessage(String(e))); }, []);

  async function request(method: "POST" | "DELETE", body: unknown): Promise<boolean> {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/specializations", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "No se pudo guardar");
      await refresh();
      setMessage(method === "POST" ? "Especialización guardada." : "Especialización retirada.");
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Error en la configuración");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const button = "rounded-md border border-kumo-line px-3 py-1.5 text-xs hover:bg-kumo-elevated disabled:opacity-50";
  const input = "w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default";

  return (
    <section className="mt-5 space-y-3 border-t border-kumo-line pt-4" aria-label="Especializaciones opcionales">
      <h3 className="text-sm font-semibold">Especializaciones</h3>
      <p className="text-xs text-kumo-subtle">
        Crea instrucciones reutilizables para tareas distintas. No requieren modificar código ni desplegar OpenCode.
        Estas instrucciones no otorgan permisos de herramientas ni autorizan operaciones productivas.
      </p>
      {profiles.map(profile => (
        <div key={profile.id} className="flex items-start gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <strong>{profile.name}</strong>
            <p className="text-xs text-kumo-subtle">{profile.enabled ? "Habilitada" : "Desactivada"}</p>
          </div>
          <button className={button} disabled={busy} type="button"
            onClick={() => void request("POST", { ...profile, enabled: !profile.enabled })}>
            {profile.enabled ? "Desactivar" : "Activar"}
          </button>
          <button className={button} disabled={busy} type="button"
            onClick={() => void request("DELETE", { id: profile.id })}>Quitar</button>
        </div>
      ))}
      <label className="block text-xs font-medium" htmlFor="specialization-name">Nueva especialización</label>
      <input id="specialization-name" className={input} maxLength={80} value={name}
        placeholder="Ejemplo: Escritura narrativa" onChange={e => setName(e.target.value)} />
      <label className="block text-xs font-medium" htmlFor="specialization-instructions">Instrucciones</label>
      <textarea id="specialization-instructions" className={input} rows={4} maxLength={4000}
        placeholder="Describe qué debe hacer el agente, cómo revisar los resultados y qué límites mantener. Nunca pegues claves API."
        value={instructions} onChange={e => setInstructions(e.target.value)} />
      <button className={button} type="button" disabled={busy || !name.trim() || !instructions.trim()}
        onClick={() => void request("POST", { id: slug(name), name, instructions, enabled: true }).then(saved => { if (saved) { setName(""); setInstructions(""); } })}>
        Guardar especialización
      </button>
      {message ? <p role="status" className="text-xs">{message}</p> : null}
    </section>
  );
}

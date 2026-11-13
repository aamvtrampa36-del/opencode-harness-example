import { useEffect, useState } from "react";
import {
  isDefaultSpecialization, type Specialization
} from "./specializations";
import type { AgentMode } from "./protocol";
import { MODEL_PRESETS, isModelPreset, type ModelPresetID } from "./model-presets";

type ApiList = { specializations: Specialization[] };

function slug(name: string): string {
  const value = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return value.length < 2 ? "perfil-" + Date.now().toString(36) : value;
}
function uniqueId(name: string, profiles: readonly Specialization[]): string {
  const base = slug(name);
  const existing = new Set(profiles.map(profile => profile.id));
  if (!existing.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = "-" + n;
    const candidate = base.slice(0, 40 - suffix.length) + suffix;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("No hay identificador libre para la plantilla");
}

export function SpecializationsPanel({ onChanged }: { onChanged: () => void }) {
  const [profiles, setProfiles] = useState<Specialization[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState<AgentMode>("build");
  const [model, setModel] = useState<ModelPresetID>("economy");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = async () => {
    const response = await fetch("/api/settings/specializations", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudieron leer las plantillas");
    const result = await response.json() as ApiList;
    setProfiles(result.specializations);
    onChanged();
  };
  useEffect(() => { void refresh().catch(e => setMessage(String(e))); }, []);

  function clear() {
    setEditingId(null);
    setName("");
    setInstructions("");
    setMode("build");
    setModel("economy");
  }
  function edit(profile: Specialization, copy = false) {
    setEditingId(copy ? null : profile.id);
    setName(copy ? profile.name + " copia" : profile.name);
    setInstructions(profile.instructions);
    setMode(profile.mode ?? "build");
    setModel(profile.model ?? "cloudflare");
    setMessage(copy ? "Copia preparada: modifica y guarda para crear otra plantilla." : "Editando plantilla.");
  }

  async function request(method: "POST" | "DELETE", body: unknown): Promise<boolean> {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/specializations", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "No se pudo guardar");
      await refresh();
      setMessage(method === "POST" ? "Plantilla guardada. Se aplicará a la siguiente tarea sin desplegar código."
        : "Plantilla restablecida o eliminada.");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Error de configuración");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    try {
      const id = editingId ?? uniqueId(name, profiles);
      const ok = await request("POST", { id, name, instructions, mode, model, enabled: true });
      if (ok) clear();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo crear la plantilla");
    }
  }
  const button = "rounded-md border border-kumo-line px-3 py-1.5 text-xs hover:bg-kumo-elevated disabled:opacity-50";
  const input = "w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default";

  return (
    <section className="mt-5 space-y-3 border-t border-kumo-line pt-4" aria-label="Plantillas configurables">
      <h3 className="text-sm font-semibold">Plantillas de trabajo</h3>
      <p className="text-xs text-kumo-subtle">
        Selecciona una plantilla desde la barra principal. Puedes editar, copiar o restablecer las siete
        predeterminadas. Las instrucciones se guardan sin desplegar código y nunca conceden nuevos permisos.
      </p>
      {profiles.map(profile => (
        <div key={profile.id} className="rounded-md border border-kumo-line p-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <strong>{profile.name}</strong>
              <p className="text-xs text-kumo-subtle">
                {profile.enabled ? "Disponible" : "Desactivada"} · {profile.mode ?? "build"} · {MODEL_PRESETS[profile.model ?? "cloudflare"].label}
                {isDefaultSpecialization(profile.id) ? " · Predeterminada" : ""}
              </p>
            </div>
            <button className={button} type="button" disabled={busy} onClick={() => edit(profile)}>Editar</button>
            <button className={button} type="button" disabled={busy} onClick={() => edit(profile, true)}>Copiar</button>
            <button className={button} type="button" disabled={busy}
              onClick={() => void request("POST", { ...profile, enabled: !profile.enabled })}>
              {profile.enabled ? "Desactivar" : "Activar"}
            </button>
            <button className={button} type="button" disabled={busy}
              onClick={() => void request("DELETE", { id: profile.id }).then(ok => {
                if (ok && editingId === profile.id) clear();
              })}>
              {isDefaultSpecialization(profile.id) ? "Restablecer" : "Eliminar"}
            </button>
          </div>
        </div>
      ))}
      <div className="space-y-3 rounded-lg border border-kumo-line p-3">
        <h4 className="text-sm font-semibold">{editingId ? "Editar plantilla" : "Nueva plantilla / copia"}</h4>
        <label className="block text-xs font-medium" htmlFor="specialization-name">Nombre</label>
        <input id="specialization-name" className={input} maxLength={80} value={name}
          placeholder="Ejemplo: Escritura narrativa" onChange={e => setName(e.target.value)} />
        <label className="block text-xs font-medium" htmlFor="specialization-instructions">Instrucciones</label>
        <textarea id="specialization-instructions" className={input} rows={4} maxLength={4000}
          placeholder="Instrucciones verificables para el agente. Nunca pegues claves ni secretos."
          value={instructions} onChange={e => setInstructions(e.target.value)} />
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">Modo
            <select className={input} value={mode} onChange={e => setMode(e.target.value as AgentMode)}>
              <option value="build">Desarrollar</option>
              <option value="plan">Planificar</option>
              <option value="review">Revisar</option>
              <option value="creative">Escritura</option>
            </select>
          </label>
          <label className="text-xs">Modelo sugerido
            <select className={input} value={model} onChange={e => {
              if (isModelPreset(e.target.value)) setModel(e.target.value);
            }}>
              {Object.entries(MODEL_PRESETS).map(([id, preset]) => (
                <option key={id} value={id}>{preset.label}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-kumo-subtle">
          El modelo es una sugerencia; puedes cambiarlo antes de enviar. Las opciones de OpenRouter requieren
          una conexión activa y pueden consumir saldo.
        </p>
        <div className="flex gap-2">
          <button className={button} type="button" disabled={busy || !name.trim() || !instructions.trim()}
            onClick={() => void save()}>{editingId ? "Guardar cambios" : "Crear plantilla"}</button>
          <button className={button} type="button" disabled={busy} onClick={clear}>Cancelar / limpiar</button>
        </div>
      </div>
      {message ? <p role="status" className="text-xs">{message}</p> : null}
    </section>
  );
}

import { useEffect, useState } from "react";
import {
  isDefaultSpecialization, type Specialization
} from "./specializations";
import type { AgentMode } from "./protocol";
import { MODEL_PRESETS, isModelPreset, type ModelSelectionID } from "./model-presets";
import { ModelPicker } from "./model-picker";
import { ImageModelPicker } from "./image-model-picker";

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
function modelLabel(model: ModelSelectionID | undefined): string {
  const selected = model ?? "cloudflare";
  return isModelPreset(selected) ? MODEL_PRESETS[selected].label : selected;
}

export function SpecializationsPanel({ onChanged, routerReady }:
  { onChanged: () => void; routerReady: boolean }) {
  const [profiles, setProfiles] = useState<Specialization[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState<AgentMode>("build");
  const [model, setModel] = useState<ModelSelectionID>("economy");
  const [decisionModel, setDecisionModel] = useState<ModelSelectionID | "">("");
  const [imageModel, setImageModel] = useState("");
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
    setDecisionModel("");
    setImageModel("");
  }
  function edit(profile: Specialization, copy = false) {
    setEditingId(copy ? null : profile.id);
    setName(copy ? profile.name + " copia" : profile.name);
    setInstructions(profile.instructions);
    setMode(profile.mode ?? "build");
    setModel(profile.model ?? "cloudflare");
    setDecisionModel(profile.decisionModel ?? "");
    setImageModel(profile.imageModel ?? "");
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
      const ok = await request("POST", { id, name, instructions, mode, model,
        ...(decisionModel ? { decisionModel } : {}), ...(imageModel ? { imageModel } : {}), enabled: true });
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
                {profile.enabled ? "Disponible" : "Desactivada"} · {profile.mode ?? "build"} · {modelLabel(profile.model)}
                {profile.decisionModel ? " · decisión " + profile.decisionModel : ""}
                {profile.imageModel ? " · imagen " + profile.imageModel : ""}
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
          <div className="space-y-1 text-xs">Modelo principal
            <ModelPicker value={model} onChange={setModel} routerReady={routerReady} disabled={busy}
              label="Elegir modelo principal" />
          </div>
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input type="checkbox" checked={Boolean(decisionModel)} disabled={busy}
              onChange={event => setDecisionModel(event.target.checked ? "reasoning" : "")} />
            Elegir modelo distinto para subagentes de decisión
          </label>
          {decisionModel ? <div className="space-y-1 text-xs sm:col-span-2">Modelo de decisión
            <ModelPicker value={decisionModel} onChange={setDecisionModel} routerReady={routerReady} disabled={busy}
              label="Elegir modelo de decisión" />
          </div> : null}
          <div className="sm:col-span-2">
            <ImageModelPicker value={imageModel} onChange={setImageModel} routerReady={routerReady} disabled={busy} />
            <p className="mt-1 text-xs text-kumo-subtle">
              Para conservar el cambio, guarda la plantilla. Luego selecciónala en el chat para ver “Generar imagen”.
            </p>
          </div>
        </div>
        <p className="text-xs text-kumo-subtle">
          El modelo principal se aplica a la tarea. El modelo de decisión solo se usa al crear un subagente;
          el de imagen solo al pedir una imagen. OpenRouter puede consumir saldo.
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

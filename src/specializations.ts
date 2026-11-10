/**
 * G6 templates reuse owner-scoped specializations. Templates are instructions,
 * never permissions, tool grants, secrets, or extra agent runtimes.
 */
import { isModelPreset, type ModelPresetID } from "./model-presets";
import type { AgentMode } from "./protocol";

export type Specialization = {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  mode?: AgentMode;       // absent on older saved records: defaults to build
  model?: ModelPresetID;  // suggestion only: the owner can override it
};

export const MAX_SPECIALIZATIONS = 16;
const MODES: readonly string[] = ["build", "plan", "review", "creative"];

export const DEFAULT_SPECIALIZATIONS: readonly Specialization[] = [
  { id: "desarrollo", name: "Desarrollo", mode: "build", model: "economy", enabled: true,
    instructions: "Implementa cambios mínimos y reversibles. Inspecciona archivos reales, ejecuta pruebas y explica los resultados. No modifiques producción sin autorización." },
  { id: "diagnostico", name: "Diagnóstico", mode: "review", model: "economy", enabled: true,
    instructions: "Analiza el problema, reproduce el fallo de forma segura y separa observaciones de hipótesis. Prioriza la causa raíz; no modifiques archivos hasta recibir autorización explícita." },
  { id: "revision", name: "Revisión", mode: "review", model: "economy", enabled: true,
    instructions: "Revisa los cambios con evidencias, riesgos y pruebas faltantes. Señala problemas concretos antes que preferencias de estilo. No modifiques archivos." },
  { id: "planificacion", name: "Planificación", mode: "plan", model: "economy", enabled: true,
    instructions: "Define objetivo, dependencias, siguiente acción y criterio de cierre. Prioriza pasos mínimos comprobables y evita planificación excesiva. No ejecutes cambios." },
  { id: "decisiones", name: "Decisiones", mode: "plan", model: "economy", enabled: true,
    instructions: "Compara opciones por beneficio, costo, riesgo, reversibilidad y evidencia. Explicita incertidumbre y recomienda una opción con condición de revisión; no ejecutes cambios." },
  { id: "flujo", name: "Flujo de trabajo", mode: "plan", model: "economy", enabled: true,
    instructions: "Convierte el objetivo en un flujo corto: entrada, acción, validación, resultado y recuperación ante fallos. Reutiliza herramientas existentes y evita pasos innecesarios." },
  { id: "documentacion", name: "Documentación", mode: "creative", model: "economy", enabled: true,
    instructions: "Redacta documentación clara basada en evidencias reales. Distingue decisiones, resultados, límites y siguiente paso. No inventes pruebas ni modifiques fuentes oficiales sin autorización." }
];

export function isDefaultSpecialization(id: string): boolean {
  return DEFAULT_SPECIALIZATIONS.some(profile => profile.id === id);
}

/** Built-ins are virtual until edited. Existing user profiles remain intact. */
export function mergeSpecializations(saved: readonly Specialization[]): Specialization[] {
  const records = new Map(DEFAULT_SPECIALIZATIONS.map(p => [p.id, { ...p }]));
  for (const item of saved) records.set(item.id, { ...item });
  return [...records.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/** Compile a fresh agent prompt per invocation, so edits take effect without deploy. */
export function specializationPrompt(profile: Specialization): string {
  return "ESPECIALIZACIÓN OPCIONAL: " + profile.name +
    "\nInstrucciones del perfil (no sustituyen permisos ni políticas del sistema):\n" +
    profile.instructions + "\n\n";
}

export function validateSpecialization(input: unknown): Specialization {
  if (typeof input !== "object" || input === null) throw new Error("Invalid specialization");
  const value = input as Record<string, unknown>;
  const { id, name, instructions } = value;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(id)) {
    throw new Error("The ID must use 2–40 lowercase letters, digits or hyphens");
  }
  if (typeof name !== "string" || name.trim().length < 2 || name.length > 80) {
    throw new Error("Name must contain 2–80 characters");
  }
  if (typeof instructions !== "string" || !instructions.trim() || instructions.length > 4000) {
    throw new Error("Instructions must contain 1–4000 characters");
  }
  if (/sk-or-[a-z0-9-]{12,}|github_pat_[a-z0-9_]{12,}/i.test(instructions)) {
    throw new Error("Do not put API credentials inside specialization instructions");
  }
  if (typeof value.enabled !== "boolean") throw new Error("Enabled must be true or false");
  const mode = value.mode === undefined ? "build" : value.mode;
  if (typeof mode !== "string" || !MODES.includes(mode)) throw new Error("Unknown template mode");
  const model = value.model === undefined ? "cloudflare" : value.model;
  if (!isModelPreset(model)) throw new Error("Unknown suggested model");
  return {
    id, name: name.trim(), instructions: instructions.trim(),
    enabled: value.enabled, mode: mode as AgentMode, model
  };
}

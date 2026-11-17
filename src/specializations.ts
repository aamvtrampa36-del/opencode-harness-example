/** Owner-editable templates. A template only describes a short sequence of
 * prompts/models; it never grants permissions or changes project isolation. */
import { isModelSelection, type ModelSelectionID } from "./model-presets";

export type WorkflowStage = {
  name: string;
  instructions: string;
  model?: ModelSelectionID;
  mode?: "build" | "plan";
};

export type Specialization = {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  /** Legacy fields remain readable so existing saved templates survive. */
  mode?: "build" | "plan" | "review" | "creative";
  model?: ModelSelectionID;
  decisionModel?: ModelSelectionID;
  imageModel?: string;
  stages?: WorkflowStage[];
};

export const MAX_SPECIALIZATIONS = 16;
export const MAX_WORKFLOW_STAGES = 6;
const LEGACY_MODES = ["build", "plan", "review", "creative"] as const;

/** Keep general chat the default. Optional examples are few and editable. */
export const DEFAULT_SPECIALIZATIONS: readonly Specialization[] = [
  { id: "cdf-workflow", name: "Flujo CDF", model: "cloudflare", enabled: true,
    instructions: "Trabaja con los recursos CDF autorizados y confirma cada resultado con evidencia.",
    stages: [
      { name: "Entender", instructions: "Resume el objetivo, revisa el contexto CDF disponible y señala qué datos concretos faltan.", model: "cloudflare", mode: "plan" },
      { name: "Ejecutar y comprobar", instructions: "Realiza únicamente la acción solicitada con las herramientas autorizadas. Comprueba el resultado y resume los cambios.", model: "cloudflare", mode: "build" }
    ] }
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
  return "PLANTILLA OPCIONAL: " + profile.name +
    "\nInstrucciones (no sustituyen permisos ni políticas del sistema):\n" +
    profile.instructions +
    (profile.decisionModel ? "\nModelo para subagentes de decisión: " + profile.decisionModel + "." : "") +
    (profile.imageModel ? "\nModelo disponible para generar imágenes bajo petición: " + profile.imageModel + "." : "") +
    "\n\n";
}

function validateStage(value: unknown): WorkflowStage {
  if (typeof value !== "object" || value === null) throw new Error("Invalid workflow stage");
  const stage = value as Record<string, unknown>;
  if (typeof stage.name !== "string" || stage.name.trim().length < 2 || stage.name.length > 80) {
    throw new Error("Stage name must contain 2–80 characters");
  }
  if (typeof stage.instructions !== "string" || !stage.instructions.trim() || stage.instructions.length > 2000) {
    throw new Error("Stage instructions must contain 1–2000 characters");
  }
  if (stage.model !== undefined && !isModelSelection(stage.model)) throw new Error("Unknown stage model");
  if (stage.mode !== undefined && stage.mode !== "build" && stage.mode !== "plan") {
    throw new Error("Stage mode must be build or plan");
  }
  return { name: stage.name.trim(), instructions: stage.instructions.trim(),
    ...(stage.model ? { model: stage.model as ModelSelectionID } : {}),
    ...(stage.mode ? { mode: stage.mode } : {}) };
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
  if (typeof mode !== "string" || !(LEGACY_MODES as readonly string[]).includes(mode)) throw new Error("Unknown template mode");
  const model = value.model === undefined ? "cloudflare" : value.model;
  const decisionModel = value.decisionModel;
  const imageModel = value.imageModel;
  if (!isModelSelection(model)) throw new Error("Unknown suggested model");
  if (decisionModel !== undefined && !isModelSelection(decisionModel)) throw new Error("Unknown decision model");
  if (imageModel !== undefined && (typeof imageModel !== "string" || imageModel.length > 160 ||
      !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:+-]*$/i.test(imageModel))) {
    throw new Error("Unknown image generation model");
  }
  let stages: WorkflowStage[] | undefined;
  if (value.stages !== undefined) {
    if (!Array.isArray(value.stages) || value.stages.length > MAX_WORKFLOW_STAGES) {
      throw new Error(`A workflow can have at most ${MAX_WORKFLOW_STAGES} stages`);
    }
    if (value.stages.length) {
      stages = value.stages.map(validateStage);
      if (stages.reduce((sum, stage) => sum + stage.instructions.length, 0) > 10_000) {
        throw new Error("Workflow instructions must not exceed 10000 characters in total");
      }
    }
  }
  return { id, name: name.trim(), instructions: instructions.trim(), enabled: value.enabled,
    mode: mode as Specialization["mode"], model: model as ModelSelectionID,
    ...(decisionModel ? { decisionModel: decisionModel as ModelSelectionID } : {}),
    ...(imageModel ? { imageModel: imageModel as string } : {}), ...(stages ? { stages } : {}) };
}

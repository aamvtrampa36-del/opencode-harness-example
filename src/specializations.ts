/**
 * Optional task profiles. Profiles are data, not new packages or plugins:
 * creating one never requires changing or redeploying the OpenCode core.
 * These instructions guide the model but do not grant security permissions.
 */
export type Specialization = {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
};

export const MAX_SPECIALIZATIONS = 16;

export function validateSpecialization(input: unknown): Specialization {
  if (typeof input !== "object" || input === null) throw new Error("Invalid specialization");
  const value = input as Record<string, unknown>;
  const id = value.id;
  const name = value.name;
  const instructions = value.instructions;
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
  return { id, name: name.trim(), instructions: instructions.trim(), enabled: value.enabled };
}

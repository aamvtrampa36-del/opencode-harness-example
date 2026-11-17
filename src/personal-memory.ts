export const MAX_PERSONAL_MEMORY_NOTES = 80;
export const MAX_PERSONAL_MEMORY_NOTE_LENGTH = 2_000;

export type PersonalMemoryNote = {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Persistent memory is opt-in and intended for small preferences and facts.
 * Reject obvious credential-shaped text so a stray "remember this" request
 * cannot turn this feature into a place for API keys or bearer tokens.
 */
export function validatePersonalMemoryContent(value: unknown): string {
  if (typeof value !== "string") throw new Error("La nota debe ser texto.");
  const content = value.trim();
  if (!content) throw new Error("La nota no puede estar vacía.");
  if (content.length > MAX_PERSONAL_MEMORY_NOTE_LENGTH) {
    throw new Error(`La nota no puede superar ${MAX_PERSONAL_MEMORY_NOTE_LENGTH} caracteres.`);
  }
  if (/(?:\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9_]{20,}|\bBearer\s+\S{20,}|\b(?:api[_ -]?key|access[_ -]?token|password|contraseña|secret|secreto)\s*[:=]\s*\S{12,})/i.test(content)) {
    throw new Error("No guardes claves, contraseñas ni tokens en la memoria.");
  }
  return content;
}

export function isPersonalMemoryNote(value: unknown): value is PersonalMemoryNote {
  if (typeof value !== "object" || value === null) return false;
  const note = value as Partial<PersonalMemoryNote>;
  return typeof note.id === "string" && /^[a-f0-9-]{36}$/i.test(note.id) &&
    typeof note.content === "string" && note.content.length > 0 &&
    typeof note.createdAt === "number" && Number.isFinite(note.createdAt) &&
    typeof note.updatedAt === "number" && Number.isFinite(note.updatedAt);
}

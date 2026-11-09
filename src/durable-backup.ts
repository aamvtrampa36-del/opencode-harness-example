/** Backup archive helpers independent of the 30-day Container snapshot TTL. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
export const BACKUP_CHUNK_BYTES = 64 * 1024;

export function chunkBackup(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length < 3 || bytes.length > MAX_ARCHIVE_BYTES ||
      bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error("El archivo de respaldo debe ser un gzip válido de hasta 2 MiB.");
  }
  const result: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += BACKUP_CHUNK_BYTES) {
    result.push(bytes.slice(i, i + BACKUP_CHUNK_BYTES));
  }
  return result;
}

export function joinBackup(parts: readonly Uint8Array[], size: number): Uint8Array {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) {
    throw new Error("Tamaño del respaldo no válido");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    if (offset + part.length > size) throw new Error("Respaldo dañado o incompleto");
    bytes.set(part, offset);
    offset += part.length;
  }
  if (offset !== size || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error("Respaldo incompleto o inválido");
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = new Uint8Array(bytes);
  const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(raw).map(b => b.toString(16).padStart(2, "0")).join("");
}

export type StoredBackup = {
  project: string;
  version: string;
  createdAt: string;
  bytes: number;
  chunks: number;
  sha256: string;
  /** Metadata pointer only; full Workerd transcript stays in the agent Durable Object. */
  sessionRef?: string;
  gitBranch?: string;
  gitHead?: string;
};

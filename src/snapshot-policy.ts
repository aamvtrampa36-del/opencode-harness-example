export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60_000;

/** Never replace a previously used, unsaved Container with an empty image. */
export function assertRecoverableContainer(
  snapshotId: string | undefined, savedAt: number | undefined,
  lastActivity: number | undefined, now: number
): void {
  if (snapshotId && (!savedAt || now - savedAt >= SNAPSHOT_TTL_MS)) {
    throw new Error("La instantánea Linux venció; se requiere recuperar una copia verificada.");
  }
  if (!snapshotId && lastActivity) {
    throw new Error("El Container anterior no tiene instantánea recuperable; no se iniciará un espacio vacío.");
  }
}

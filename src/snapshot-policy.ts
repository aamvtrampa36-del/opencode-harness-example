export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60_000;
export type SnapshotMetadata = { snapshotId: string; savedAt: number };
export function assertSnapshotMetadata(id: unknown, savedAt: unknown, now: number): SnapshotMetadata {
  if(typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(id) ||
     typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt <= 0 ||
     !Number.isSafeInteger(now) || now < savedAt || now-savedAt >= SNAPSHOT_TTL_MS)
    throw Error("La instantánea Linux venció o es inválida; se requiere recuperar una copia verificada.");
  return {snapshotId:id,savedAt};
}
/** Never replace a previously used, unsaved Container with an empty image. */
export function assertRecoverableContainer(snapshotId: string | undefined, savedAt: number | undefined,
 lastActivity: number | undefined, now: number): void {
  if(snapshotId !== undefined || savedAt !== undefined) { assertSnapshotMetadata(snapshotId,savedAt,now); return; }
  if(lastActivity !== undefined && lastActivity !== 0)
    throw Error("El Container anterior no tiene instantánea recuperable; no se iniciará un espacio vacío.");
}
export type CheckpointIO = {
  now():number; snapshot():Promise<{id:unknown}>; persist(value:SnapshotMetadata):Promise<void>;
  readback():Promise<{snapshotId:unknown;savedAt:unknown}>;
};
export async function checkpointSnapshot(io:CheckpointIO):Promise<SnapshotMetadata>{
  const result=await io.snapshot();
  const now=io.now(), expected=assertSnapshotMetadata(result.id,now,now);
  await io.persist(expected);
  const actual=await io.readback();
  const verified=assertSnapshotMetadata(actual.snapshotId,actual.savedAt,io.now());
  if(verified.snapshotId!==expected.snapshotId||verified.savedAt!==expected.savedAt)throw Error("M03_SNAPSHOT_READBACK_MISMATCH");
  return expected;
}

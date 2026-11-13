import { projectContainerName } from "./project-container";

type ProbeDev = {
  run(project: string, command: string): Promise<{exitCode: number | null}>;
  saveBackup(project: string): Promise<{sha256: string}>;
  downloadSavedBackup(project: string): Promise<Response>;
  restoreExternalBackup(source: string, target: string, data: Uint8Array, hash: string):
    Promise<{source: string; target: string; sha256: string}>;
  inspect(project: string, action: "read", path: string): Promise<unknown>;
};

/** Test independent backup and restore in separate synthetic project VMs. */
export async function checkIsolatedBackup(open: (name: string) => ProbeDev, nonce: string) {
  if (!/^[a-f0-9]{12}$/.test(nonce)) throw Error("Invalid backup probe identity");
  const source = "isobackup-a-" + nonce, target = "isobackup-b-" + nonce;
  const a = open(projectContainerName(source)), b = open(projectContainerName(target));
  const result = await a.run(source, "printf 'backup-check-v1' > evidence.txt");
  if (result.exitCode !== 0) throw Error("No se pudo crear el archivo sintético");
  const backup = await a.saveBackup(source);
  const response = await a.downloadSavedBackup(source);
  if (!response.ok) throw Error("No se pudo descargar el respaldo de prueba");
  const restored = await b.restoreExternalBackup(source, target,
    new Uint8Array(await response.arrayBuffer()), backup.sha256);
  const [before, after] = await Promise.all([
    a.inspect(source, "read", "evidence.txt"),
    b.inspect(target, "read", "evidence.txt")
  ]) as { contents?: string }[];
  if (before.contents !== "backup-check-v1" || after.contents !== before.contents ||
      restored.source !== source || restored.target !== target ||
      !/^[a-f0-9]{64}$/.test(restored.sha256)) throw Error("La restauración no conserva el archivo");
  return { passed: true, source, target, archiveSha256: backup.sha256, fileSha256: restored.sha256 };
}

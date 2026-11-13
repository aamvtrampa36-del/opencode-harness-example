import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_IMPORT_SOURCE } from "./github-import-source";

async function archive(link = false) {
  const dir = await mkdtemp(join(tmpdir(), "opencode-import-"));
  const root = join(dir, "repo-abcdef0");
  await mkdir(root);
  await writeFile(join(root, "hello.js"), "export const hello = 42;\n");
  if (link) await symlink("../../outside", join(root, "escape"));
  const file = join(dir, "repo.tar.gz");
  expect(Bun.spawnSync(["tar", "-czf", file, "-C", dir, "repo-abcdef0"]).exitCode).toBe(0);
  return { dir, bytes: await readFile(file) };
}
function run(root: string, bytes: Uint8Array) {
  return Bun.spawnSync(["node", "--input-type=module", "-e", GITHUB_IMPORT_SOURCE, "chosen-project"], {
    stdin: bytes, env: { ...process.env, IMPORT_TEST_ROOT: root }
  });
}
describe("safe repository archive import", () => {
  test("imports real content into a new directory and refuses overwrite", async () => {
    const a = await archive();
    try {
      const target = join(a.dir, "projects");
      const first = run(target, a.bytes);
      if (first.exitCode !== 0) throw Error(new TextDecoder().decode(first.stderr));
      expect(await readFile(join(target, "chosen-project", "hello.js"), "utf8")).toContain("42");
      const second = run(target, a.bytes);
      expect(second.exitCode).not.toBe(0);
      expect(await readFile(join(target, "chosen-project", "hello.js"), "utf8")).toContain("42");
    } finally { await rm(a.dir, { recursive: true, force: true }); }
  });
  test("rejects symbolic links and malformed archives without a partial target", async () => {
    const a = await archive(true);
    try {
      const target = join(a.dir, "projects");
      expect(run(target, a.bytes).exitCode).not.toBe(0);
      expect(run(target, new Uint8Array([1, 2, 3])).exitCode).not.toBe(0);
      await expect(stat(join(target, "chosen-project"))).rejects.toThrow();
    } finally { await rm(a.dir, { recursive: true, force: true }); }
  });
  test("rejects an archive with parent directory traversal", async () => {
    const a = await archive();
    try {
      const file = join(a.dir, "traversal.tar.gz");
      expect(Bun.spawnSync(["tar", "--transform=s|repo-abcdef0|../outside|",
        "-czf", file, "-C", a.dir, "repo-abcdef0"]).exitCode).toBe(0);
      const target = join(a.dir, "projects");
      expect(run(target, await readFile(file)).exitCode).not.toBe(0);
      await expect(stat(join(target, "chosen-project"))).rejects.toThrow();
    } finally { await rm(a.dir, { recursive: true, force: true }); }
  });
});

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
function run(root: string, bytes: Uint8Array, expectedTree?: string) {
  const args = ["node", "--input-type=module", "-e", GITHUB_IMPORT_SOURCE, "chosen-project"];
  if (expectedTree) args.push(expectedTree);
  return Bun.spawnSync(args, {
    stdin: bytes, env: { ...process.env, IMPORT_TEST_ROOT: root }
  });
}
async function gitTreeOf(root: string) {
  expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "add", "--force", "--all"], { cwd: root }).exitCode).toBe(0);
  const written = Bun.spawnSync(["git", "write-tree"], { cwd: root });
  expect(written.exitCode).toBe(0);
  const tree = written.stdout.toString().trim();
  expect(tree).toMatch(/^[a-f0-9]{40}$/);
  await rm(join(root, ".git"), { recursive: true, force: true });
  return tree;
}
async function archiveWithTree() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-import-tree-"));
  const root = join(dir, "repo-abcdef0");
  await mkdir(root);
  await writeFile(join(root, "hello.js"), "export const hello = 42;\n");
  await writeFile(join(root, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  const tree = await gitTreeOf(root);
  const file = join(dir, "repo.tar.gz");
  expect(Bun.spawnSync(["tar", "-czf", file, "-C", dir, "repo-abcdef0"]).exitCode).toBe(0);
  return { dir, tree, bytes: await readFile(file) };
}
async function archiveWithGitMetadata() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-import-git-"));
  const root = join(dir, "repo-abcdef0");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "config"), "[core]\n");
  await writeFile(join(root, "hello.js"), "export const hello = 42;\n");
  const file = join(dir, "repo.tar.gz");
  expect(Bun.spawnSync(["tar", "-czf", file, "-C", dir, "repo-abcdef0"]).exitCode).toBe(0);
  return { dir, bytes: await readFile(file) };
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

  test("verifies the actual Git tree of extracted bytes before publishing", async () => {
    const a = await archiveWithTree();
    try {
      const target = join(a.dir, "projects");
      const result = run(target, a.bytes, a.tree);
      if (result.exitCode !== 0) throw Error(new TextDecoder().decode(result.stderr));
      const receipt = JSON.parse(new TextDecoder().decode(result.stdout));
      expect(receipt.tree).toBe(a.tree);
      expect(await readFile(join(target, "chosen-project", "hello.js"), "utf8")).toContain("42");
      await expect(stat(join(target, "chosen-project", ".git"))).rejects.toThrow();
    } finally { await rm(a.dir, { recursive: true, force: true }); }
  });
  test("a wrong expected tree aborts without publishing a project", async () => {
    const a = await archiveWithTree();
    try {
      const target = join(a.dir, "projects");
      const result = run(target, a.bytes, "f".repeat(40));
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain("tree");
      await expect(stat(join(target, "chosen-project"))).rejects.toThrow();
    } finally { await rm(a.dir, { recursive: true, force: true }); }
  });
  test("rejects archive .git metadata before extraction", async () => {
    const a = await archiveWithGitMetadata();
    try {
      const target = join(a.dir, "projects");
      const result = run(target, a.bytes, "a".repeat(40));
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain(".git");
      await expect(stat(join(target, "chosen-project"))).rejects.toThrow();
    } finally { await rm(a.dir, { recursive: true, force: true }); }
  });
});

describe("raw Git tree certification", () => {
  test("does not certify CRLF bytes under the normalized LF Git tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-raw-tree-"));
    try {
      const root = join(dir, "repo");
      await mkdir(root);
      await writeFile(join(root, ".gitattributes"), "*.txt text eol=lf\n");
      await writeFile(join(root, "a.txt"), "hello\n");
      const tree = await gitTreeOf(root);
      await writeFile(join(root, "a.txt"), "hello\r\n");
      const file = join(dir, "repo.tar.gz");
      expect(Bun.spawnSync(["tar", "-czf", file, "-C", dir, "repo"]).exitCode).toBe(0);
      const target = join(dir, "projects");
      const result = run(target, await readFile(file), tree);
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain("Git tree hash mismatch");
      await expect(stat(join(target, "chosen-project"))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("certifies raw bytes, Git byte ordering, executable mode and nested tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-raw-tree-"));
    try {
      const root = join(dir, "repo");
      await mkdir(join(root, "a"), { recursive: true });
      await writeFile(join(root, ".gitattributes"), "*.txt text eol=lf\n");
      await writeFile(join(root, "a.txt"), "hello\r\n");
      await writeFile(join(root, "a", "file"), new Uint8Array([0, 255]));
      await writeFile(join(root, "a.c"), "x");
      await writeFile(join(root, "run"), "#!/bin/sh\n", { mode: 0o755 });
      const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root });
      expect(git("init", "--quiet").exitCode).toBe(0);
      expect(git("add", "--force", "--all").exitCode).toBe(0);
      const blob = git("hash-object", "-w", "--no-filters", "a.txt");
      expect(blob.exitCode).toBe(0);
      expect(git("update-index", "--cacheinfo", "100644," + blob.stdout.toString().trim() + ",a.txt").exitCode).toBe(0);
      const tree = git("write-tree");
      expect(tree.exitCode).toBe(0);
      const sha = tree.stdout.toString().trim();
      await rm(join(root, ".git"), { recursive: true, force: true });
      const file = join(dir, "repo.tar.gz");
      expect(Bun.spawnSync(["tar", "-czf", file, "-C", dir, "repo"]).exitCode).toBe(0);
      const target = join(dir, "projects");
      const result = run(target, await readFile(file), sha);
      if (result.exitCode !== 0) throw Error(new TextDecoder().decode(result.stderr));
      expect(JSON.parse(result.stdout.toString()).certification).toBe("raw-git-tree-v1");
      expect(await readFile(join(target, "chosen-project", "a.txt"), "utf8")).toBe("hello\r\n");
      expect((await stat(join(target, "chosen-project", "run"))).mode & 0o777).toBe(0o755);
      await expect(stat(join(target, "chosen-project", ".git"))).rejects.toThrow();
      await writeFile(join(root, "run"), "#!/bin/sh\n", { mode: 0o644, flag: "w" });
      // writeFile does not change the mode of an existing file.
      await rm(join(root, "run"));
      await writeFile(join(root, "run"), "#!/bin/sh\n", { mode: 0o644 });
      expect(Bun.spawnSync(["tar", "-czf", file, "-C", dir, "repo"]).exitCode).toBe(0);
      expect(run(join(dir, "bad-mode"), await readFile(file), sha).exitCode).not.toBe(0);
      await expect(stat(join(dir, "bad-mode", "chosen-project"))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

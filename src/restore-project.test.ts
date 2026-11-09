import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESTORE_PROJECT_SOURCE } from "./restore-project";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opencode-g4-"));
  const src = join(root, "source");
  await mkdir(src);
  await writeFile(join(src, "calc.mjs"), "export const add = (a,b) => a+b;\n");
  await writeFile(join(src, "calc.test.mjs"),
    'import {test} from "node:test"; import {strict as assert} from "node:assert"; import {add} from "./calc.mjs"; test("sum",()=>assert.equal(add(2,3),5));\n');
  const archive = join(tmpdir(), "backup-" + crypto.randomUUID() + ".tar.gz");
  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", root, "source"]);
  expect(tar.exitCode).toBe(0);
  return { root, archive, bytes: await readFile(archive), src };
}
function restore(root: string, bytes: Uint8Array, target = "restored", fault = false) {
  return Bun.spawnSync(["node", "-e", RESTORE_PROJECT_SOURCE, "source", target], {
    stdin: bytes,
    env: { ...process.env, G4_RESTORE_TEST_ROOT: root, ...(fault ? { G4_TEST_FAIL_BEFORE_COMMIT: "1" } : {}) }
  });
}
describe("G4 durable backup restore safety", () => {
  test("round trip tar.gz into fresh project, verify SHA and executable test", async () => {
    const f = await fixture();
    try {
      const r = restore(f.root, f.bytes);
      if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
      expect(r.exitCode).toBe(0);
      const data = JSON.parse(new TextDecoder().decode(r.stdout));
      expect(data.files).toBe(2);
      expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(join(f.root, "restored", "calc.mjs"), "utf8"))
        .toBe(await readFile(join(f.src, "calc.mjs"), "utf8"));
      const testResult = Bun.spawnSync(["node", "--test", join(f.root, "restored", "calc.test.mjs")]);
      expect(testResult.exitCode).toBe(0);
      const refuse = restore(f.root, f.bytes);
      expect(refuse.exitCode).not.toBe(0);
      expect(await readFile(join(f.root, "restored", "calc.mjs"), "utf8")).toContain("export const add");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.archive, { force: true });
    }
  });
  test("interrupted write does not publish partial target; retry succeeds", async () => {
    const f = await fixture();
    try {
      const failed = restore(f.root, f.bytes, "retry", true);
      expect(failed.exitCode).not.toBe(0);
      await expect(stat(join(f.root, "retry"))).rejects.toThrow();
      const succeeded = restore(f.root, f.bytes, "retry");
      if (succeeded.exitCode !== 0) throw new Error(new TextDecoder().decode(succeeded.stderr));
      expect(succeeded.exitCode).toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.archive, { force: true });
    }
  });
  test("refuses malformed archives and symbolic links without writing target", async () => {
    const f = await fixture();
    try {
      expect(restore(f.root, new Uint8Array([1,2,3]), "invalid").exitCode).not.toBe(0);
      await symlink("../outside", join(f.src, "link"));
      const tar = Bun.spawnSync(["tar", "-czf", f.archive, "-C", f.root, "source"]);
      expect(tar.exitCode).toBe(0);
      const bad = restore(f.root, await readFile(f.archive), "symlink");
      expect(bad.exitCode).not.toBe(0);
      await expect(stat(join(f.root, "symlink"))).rejects.toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.archive, { force: true });
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLinuxExecutionScope, linuxProjectCwdSource } from "../../../src/dev-guard.ts";

test("DO scope rejects foreign and unnamed VMs, preserves legacy personal only", () => {
  assert.equal(assertLinuxExecutionScope("project-v1:alpha", "alpha"), "alpha");
  assert.equal(assertLinuxExecutionScope("personal", "alpha"), "alpha");
  for (const [name, project] of [["project-v1:beta", "alpha"], [undefined, "alpha"],
    ["personal", "supervised-0000000000000001"], ["project-v1:alpha", "../alpha"]])
    assert.throws(() => assertLinuxExecutionScope(name, project));
});

test("exact VM cwd guard rejects symlink and traversal before payload", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "metralla-p10-")));
  try {
    const root = join(tmp, "projects"), foreign = join(tmp, "foreign");
    mkdirSync(root); mkdirSync(foreign);
    symlinkSync(foreign, join(root, "linked"));
    symlinkSync(foreign, join(tmp, "aliased"));
    const marker = join(foreign, "effect");
    const run = (base, project) => spawnSync(process.execPath, ["-e", linuxProjectCwdSource(base) +
      "require('node:fs').writeFileSync('effect','ok');console.log(process.cwd());", "fixture", project],
      { encoding: "utf8", timeout: 5000 });
    for (const [base, project] of [[root, "linked"], [root, "../foreign"], [join(tmp, "aliased"), "child"]]) {
      const r = run(base, project);
      assert.notEqual(r.status, 0);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(foreign, "child")), false);
    }
    const r = run(root, "alpha");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), join(root, "alpha"));
    assert.equal(existsSync(join(root, "alpha", "effect")), true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

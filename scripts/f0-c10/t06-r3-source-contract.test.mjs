#!/usr/bin/env node
// Exact-source contract guard for R3 Linux bootstrap. No network or exec effects.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("../../src/dev-container.ts", import.meta.url), "utf8");
function body(start, finish) {
  const begin = source.indexOf(start), end = source.indexOf(finish, begin + start.length);
  assert.ok(begin >= 0 && end > begin, "Expected source method section is absent");
  return source.slice(begin, end);
}
const git = body("private async ensureGitAvailable(", "private async ensureBunAvailable(");
const bun = body("private async ensureBunAvailable(", "/** Durable Object alarm:");
for (const [name, code] of [["git", git], ["bun", bun]]) {
  test(name + " bootstrap drains stdout, stderr and exitCode concurrently", () => {
    assert.doesNotMatch(code, /\\.output\\s*\\(/, "unbounded output() reintroduced");
    assert.match(code, /Promise\\.all\\s*\\(\\s*\\[/);
    assert.match(code, /captureBoundedOutput\\(\\s*\\w+\\.stdout\\s*,\\s*MAX_SHELL_OUTPUT\\)/);
    assert.match(code, /captureBoundedOutput\\(\\s*\\w+\\.stderr\\s*,\\s*MAX_SHELL_OUTPUT\\)/);
    assert.match(code, /\\w+\\.exitCode/);
    assert.match(code, /if \\(exitCode !== 0\\)/, "must preserve nonzero result");
  });
}
test("primary Linux command retains scoped PGID and pre-existing bounded collector", () => {
  const section = body("private async runExclusive(", "private async ensureGitAvailable(");
  assert.match(section, /Promise\\.all/);
  assert.match(section, /captureBoundedOutput\\(process\\.stdout/);
  assert.match(section, /captureBoundedOutput\\(process\\.stderr/);
  assert.match(source, /detached: true/);
  assert.match(source, /process\\.kill\\(-child\\.pid/);
});

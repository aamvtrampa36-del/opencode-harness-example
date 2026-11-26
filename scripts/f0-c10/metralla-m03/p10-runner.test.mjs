import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { captureBoundedOutput } from "../../../src/bounded-process-output.ts";
import { linuxProjectCwdSource } from "../../../src/dev-guard.ts";
const source = readFileSync(new URL("../../../src/dev-container.ts", import.meta.url), "utf8");
const runner = source.match(/const LINUX_RUNNER_SOURCE = String\.raw`([\s\S]*?)`;/)?.[1];
assert.ok(runner);
const root = realpathSync(mkdtempSync(join(tmpdir(), "p10-runner-")));
const delay = ms => new Promise(r => setTimeout(r, ms));
function state(pid) {
  try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return s.slice(s.lastIndexOf(") ") + 2).split(" ")[0]; }
  catch (e) { if (e.code === "ENOENT") return "gone"; throw e; }
}
function launch(project, command, short = false) {
  const code = short ? runner.replace('"180s"', '"1s"').replace('"--kill-after=5s"', '"--kill-after=1s"').replace('5_000', '800') : runner;
  const child = spawn(process.execPath, ["-e", linuxProjectCwdSource(root) + "\n" + code, command, project], { stdio: ["ignore", "pipe", "pipe"] });
  const status = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (exitCode, signal) => resolve({ exitCode, signal })); });
  const result = Promise.all([captureBoundedOutput(Readable.toWeb(child.stdout), 32000), captureBoundedOutput(Readable.toWeb(child.stderr), 32000), status]);
  return { child, result };
}
async function pidFor(project) {
  const path = join(root, project, "pid");
  for (let i = 0; i < 150; i++) {
    if (existsSync(path)) { const pid = Number(readFileSync(path, "utf8")); if (pid > 1) return pid; }
    await delay(20);
  }
  throw Error("fixture pid missing");
}
const inactive = pid => assert.ok(["Z", "X", "gone"].includes(state(pid)), "owned descendant still running");
const stubborn = `node -e 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)'`;
try {
  await test("16 MiB per channel, exact exit 19 and retained bytes", {timeout: 15000}, async () => {
    const [out, err, status] = await launch("large", `node -e 'const b=Buffer.alloc(8192,65);for(let i=0;i<2048;i++){process.stdout.write(b);process.stderr.write(b)}process.exitCode=19'`).result;
    assert.equal(status.exitCode, 19);
    for (const x of [out,err]) { assert.equal(x.totalBytes, 16777216); assert.equal(x.omittedBytes, 16745216); assert.equal(x.truncated,true); }
  });
  await test("same-group descendant ignoring TERM is inactive after parent exit", {timeout:8000}, async () => {
    const p = launch("tree", stubborn + " & while [ ! -s pid ]; do sleep .02; done; exit 31");
    const pid = await pidFor("tree");
    const [,err,status] = await p.result;
    assert.equal(status.exitCode,31,err.text); inactive(pid);
  });
  await test("timeout escalates and observes inactive group", {timeout:8000}, async () => {
    const p = launch("timeout", stubborn,true); const pid = await pidFor("timeout");
    const [,err,status] = await p.result; assert.ok([124,137,143].includes(status.exitCode),err.text); inactive(pid);
  });
  await test("runner cancellation escalates and observes inactive group", {timeout:8000}, async () => {
    const p = launch("cancel", stubborn,true); const pid = await pidFor("cancel"); p.child.kill("SIGTERM");
    const [,err,status] = await p.result; assert.equal(status.exitCode,143,err.text); inactive(pid);
  });
} finally { rmSync(root,{recursive:true,force:true}); }

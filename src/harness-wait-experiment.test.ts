import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A synthetic behavioural check for a copy of the actual pinned harness source.
// This is NOT a live Durable Object integration test.
const source = readFileSync(join(import.meta.dir, "../experiments/harness-wait-20261115/harness-patched.ts.txt"), "utf8");
const settled = source.slice(source.indexOf("  async settled("), source.indexOf("  /** Call OpenCode, turning"));

async function simulate(variant: "original" | "candidate", scenario: "normal" | "interrupted") {
  let phase = 0;
  let wakes = 0;
  let waits = 0;
  let pauses = 0;
  let idle = false;
  const state = () => phase === 0 || (scenario === "interrupted" && phase === 1) ? "running" : "settled";
  const doWait = async () => { waits++; if (phase === 0) phase = 1; else if (phase === 2) phase = 3; };
  const wake = async () => { wakes++; if (scenario === "interrupted" && phase === 1) phase = 2; };
  for (let guard=0; guard<8; guard++) {
    if (state() === "settled") return { outcome: "done", wakes, waits, pauses };
    if (variant === "candidate" && idle) { await wake(); pauses++; }
    await doWait();
    if (variant === "original") { await wake(); pauses++; }
    else idle = true;
  }
  return { outcome: "timeout", wakes, waits, pauses };
}

describe("experimental pinned OpenCodeHarness settled fast path", () => {
  test("the source copy alters the actual inner wait and wake logic", () => {
    expect(settled).toContain("let idle = false;");
    expect(settled).toContain("if (idle) {");
    expect(settled).toContain("idle = (await opencode.sessions.active())[session] === undefined;");
    expect(settled).not.toContain("if ((await opencode.sessions.active())[session] === undefined)");
  });
  test("normal completion avoids a redundant wake and one delay", async () => {
    const baseline = await simulate("original", "normal");
    const candidate = await simulate("candidate", "normal");
    expect(baseline).toMatchObject({outcome:"done", wakes:1, pauses:1});
    expect(candidate).toMatchObject({outcome:"done", wakes:0, pauses:0, waits:1});
  });
  test("an interrupted session still wakes and resumes", async () => {
    const baseline = await simulate("original", "interrupted");
    const candidate = await simulate("candidate", "interrupted");
    expect(baseline).toMatchObject({outcome:"done", wakes:1, pauses:1});
    expect(candidate).toMatchObject({outcome:"done", wakes:1, pauses:1, waits:2});
  });
  test("inspects the published agents@0.33.0 runtime artifact", () => {
    const entry = import.meta.resolve("agents/harness/opencode");
    const filename = new URL(entry);
    const compiled = readFileSync(filename, "utf8");
    const pos = compiled.indexOf("heartbeatMs / 30");
    // Diagnostic evidence only: the package may bundle or minify internals.
    console.log("HARNESS_DIST_ENTRY", filename.pathname);
    console.log("HARNESS_DIST_PAUSE_CONTEXT", pos < 0 ? "NOT_FOUND" : compiled.slice(Math.max(pos - 390, 0), pos + 185));
    expect(compiled.length).toBeGreaterThan(2000);
  });

});

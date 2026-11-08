import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("wrangler.jsonc","utf8"));
const server = readFileSync("src/server.ts","utf8");
const workspace = readFileSync("src/workspace.ts","utf8");

assert.equal(config.name, "opencode-harness-example", "Unexpected Worker target");
assert.equal(config.preview_urls, false, "Public preview URLs must remain disabled");
assert.ok(config.durable_objects?.bindings?.some((item) => item.name === "OpenCodeAgent"), "Persistent agent binding missing");
assert.ok(config.ai?.binding === "AI", "Existing Workers AI fallback removed");
assert.ok(!/sk-or-v1-[A-Za-z0-9]{16,}|sk-proj-[A-Za-z0-9]{16,}/.test(server+workspace), "Possible hardcoded API secret");
assert.ok(workspace.includes("CANON"), "Editorial approval guardrail missing from agent system");
assert.ok(workspace.includes("production"), "Production safety guardrail missing from agent system");
console.log("Static invariants passed. These checks do NOT replace runtime testing.");

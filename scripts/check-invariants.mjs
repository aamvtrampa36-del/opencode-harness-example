import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("wrangler.jsonc","utf8"));
const stagingConfig = readFileSync("wrangler.g1.jsonc","utf8");
const mcpConfig = JSON.parse(readFileSync("wrangler.mcp-staging.jsonc","utf8"));
const server = readFileSync("src/server.ts","utf8");
const workspace = readFileSync("src/workspace.ts","utf8");

assert.equal(config.name, "opencode-harness-example", "Unexpected Worker target");
assert.equal(config.preview_urls, false, "Public preview URLs must remain disabled");
assert.ok(config.durable_objects?.bindings?.some((item) => item.name === "OpenCodeAgent"), "Persistent agent binding missing");
assert.ok(config.ai?.binding === "AI", "Existing Workers AI fallback removed");
assert.ok(config.compatibility_flags?.includes("durable_object_io_tasks_prevent_eviction"),
  "Background Durable Object work must survive client disconnects in production");
assert.ok(stagingConfig.includes('"durable_object_io_tasks_prevent_eviction"'),
  "Background Durable Object work must survive client disconnects in Staging");
assert.equal(mcpConfig.name, "opencode-staging-control-mcp", "Unexpected MCP Worker target");
assert.deepEqual(mcpConfig.services?.map((item) => item.service), ["opencode-g1-staging"],
  "The control MCP must bind health only to OpenCode Staging");
assert.equal(mcpConfig.durable_objects?.bindings?.length, 1,
  "The control MCP must expose exactly one supervisor Durable Object binding");
assert.equal(mcpConfig.durable_objects.bindings[0].script_name, "opencode-g1-staging",
  "The control MCP Durable Object must belong to OpenCode Staging");
assert.equal(mcpConfig.durable_objects.bindings[0].class_name, "OpenCodeAgent",
  "The control MCP must reuse the existing Staging agent Durable Object");
assert.equal(mcpConfig.vars?.MCP_TOKEN, undefined,
  "Cloudflare Access OAuth, not a custom bearer secret, protects the MCP endpoint");
assert.ok(!JSON.stringify(mcpConfig).includes("opencode-harness-example"),
  "The control MCP configuration must not reference the production Worker");
assert.ok(!/sk-or-v1-[A-Za-z0-9]{16,}|sk-proj-[A-Za-z0-9]{16,}/.test(server+workspace), "Possible hardcoded API secret");
assert.ok(workspace.includes("OFFICIAL SOURCES") && workspace.includes("canonize"), "Official content approval guardrail missing from agent system");
assert.ok(workspace.includes("production"), "Production safety guardrail missing from agent system");
assert.ok(!workspace.includes("CDF NARRATIVE:"), "Project-specific narrative mode must be optional");
console.log("Static invariants passed. These checks do NOT replace runtime testing.");

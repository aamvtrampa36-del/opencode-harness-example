import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const MCP_URL = "https://opencode-staging-control-mcp.cdf-cloud-mvp-20261019.workers.dev/mcp";

const unauthenticatedResponse = await fetch(MCP_URL, {
  headers: { Accept: "application/json, text/event-stream" }
});
assert.equal(unauthenticatedResponse.status, 401, "Access Managed OAuth must challenge clients without a token.");
const oauthChallenge = unauthenticatedResponse.headers.get("www-authenticate");
assert.ok(oauthChallenge, "Access must return a WWW-Authenticate challenge.");
assert.match(oauthChallenge, /^Bearer\b/i, "Access must advertise Bearer OAuth.");
const resourceMetadataMatch = oauthChallenge.match(/resource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/i);
assert.ok(resourceMetadataMatch, "The OAuth challenge must advertise protected resource metadata.");
const resourceMetadataUrl = new URL(resourceMetadataMatch[1] ?? resourceMetadataMatch[2], MCP_URL);
assert.equal(resourceMetadataUrl.protocol, "https:", "OAuth discovery must use HTTPS.");
const resourceMetadataResponse = await fetch(resourceMetadataUrl, {
  headers: { Accept: "application/json" }
});
assert.equal(resourceMetadataResponse.ok, true, "Protected resource metadata must be publicly discoverable.");
const resourceMetadata = await resourceMetadataResponse.json();
assert.equal(typeof resourceMetadata.resource, "string", "Protected resource metadata must identify the MCP resource.");
assert.ok(
  Array.isArray(resourceMetadata.authorization_servers) && resourceMetadata.authorization_servers.length > 0,
  "Protected resource metadata must identify an authorization server."
);

const accessId = process.env.CF_ACCESS_CLIENT_ID;
const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!accessId || !accessSecret) {
  throw new Error("Configura CF_ACCESS_CLIENT_ID y CF_ACCESS_CLIENT_SECRET en GitHub Actions Secrets.");
}

const client = new Client({ name: "opencode-staging-control-e2e", version: "1.0.0" });
const runOpenRouterCheck = process.env.OPENCODE_STAGING_OPENROUTER_CHECK === "true";
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: {
    headers: {
      "CF-Access-Client-Id": accessId,
      "CF-Access-Client-Secret": accessSecret
    }
  }
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    "staging_cancel_task", "staging_openrouter_check", "staging_openrouter_check_status",
    "staging_review_task", "staging_start_task",
    "staging_status", "staging_task_status", "staging_task_transcript"
  ]);

  const status = await client.callTool({ name: "staging_status", arguments: {} });
  assert.equal(status.isError, undefined);
  const block = status.content.find(item => item.type === "text");
  assert.ok(block && "text" in block && typeof block.text === "string", "MCP status must return JSON text.");
  const parsed = JSON.parse(block.text);
  assert.equal(parsed.targetWorker, "opencode-g1-staging", "MCP target must remain fixed to Staging.");
  assert.equal(parsed.status, "ok", "The Staging health check must report ok.");

  let openRouterCheck;
  if (runOpenRouterCheck) {
    const startedResult = await client.callTool({ name: "staging_openrouter_check", arguments: {} });
    assert.equal(startedResult.isError, undefined, "OpenRouter diagnostic should start through the MCP.");
    const startedBlock = startedResult.content.find(item => item.type === "text");
    assert.ok(startedBlock && "text" in startedBlock, "Diagnostic start should return JSON text.");
    const started = JSON.parse(startedBlock.text);
    assert.equal(started.provider, "openrouter");
    assert.equal(started.requestedModel, "z-ai/glm-5.3-flash");
    assert.ok(["started", "existing"].includes(started.status), `Unexpected diagnostic start status: ${started.status}`);

    const deadline = Date.now() + 6.5 * 60_000;
    while (Date.now() < deadline) {
      const statusResult = await client.callTool({ name: "staging_openrouter_check_status", arguments: {} });
      assert.equal(statusResult.isError, undefined, "OpenRouter diagnostic status should be readable.");
      const statusBlock = statusResult.content.find(item => item.type === "text");
      assert.ok(statusBlock && "text" in statusBlock, "Diagnostic status should return JSON text.");
      openRouterCheck = JSON.parse(statusBlock.text);
      if (openRouterCheck.status === "passed") break;
      assert.ok(["queued", "running"].includes(openRouterCheck.status),
        `OpenRouter diagnostic failed: ${openRouterCheck.reason ?? openRouterCheck.status}`);
      await new Promise(resolve => setTimeout(resolve, 8_000));
    }
    assert.equal(openRouterCheck?.status, "passed", "OpenRouter and Linux diagnostic must pass before the deadline.");
    assert.equal(openRouterCheck.model, "review", "The actual check must use the fixed OpenRouter preset.");
    assert.equal(openRouterCheck.kind, "bun", "The check must exercise Bun in the managed Linux container.");
    assert.equal(openRouterCheck.modelVerified, true);
    assert.equal(openRouterCheck.runtimeVerified, true);
    assert.equal(openRouterCheck.fileVerified, true, "Linux must independently verify the isolated proof file.");
    assert.ok(openRouterCheck.toolCalls >= 1, "The agent must make a real Linux tool call.");
  }

  // Read-only RPC probe: an unknown task must fail with the supervisor's
  // expected response, proving the fixed cross-Worker DO binding is reachable.
  const unknownTaskId = randomUUID().replaceAll("-", "").slice(0, 16);
  const unknownTask = await client.callTool({
    name: "staging_task_status",
    arguments: { id: unknownTaskId }
  });
  assert.equal(unknownTask.isError, true, "The fixed Staging supervisor should reject an unknown task ID.");
  const unknownTaskBlock = unknownTask.content.find(item => item.type === "text");
  assert.ok(unknownTaskBlock && "text" in unknownTaskBlock, "Unknown task response must contain a text error.");
  assert.match(unknownTaskBlock.text, /Tarea del supervisor inexistente/);

  const evidence = {
    checkedAt: new Date().toISOString(),
    targetWorker: parsed.targetWorker,
    status: parsed.status,
    mcpUrl: new URL(MCP_URL).origin + "/mcp",
    oauthDiscovery: {
      unauthenticatedStatus: unauthenticatedResponse.status,
      resourceMetadata: resourceMetadata.resource,
      authorizationServers: resourceMetadata.authorization_servers
    },
    tools: names,
    operationsExecuted: [
      "tools/list",
      "tools/call staging_status",
      "tools/call staging_task_status (unknown ID; read only)",
      ...(runOpenRouterCheck ? ["tools/call staging_openrouter_check and poll status (OpenRouter + Bun + Linux proof)"] : [])
    ]
  };
  if (openRouterCheck) evidence.openRouterCheck = openRouterCheck;
  const outputPath = join(process.env.RUNNER_TEMP ?? "/tmp", "opencode-staging-control-mcp.json");
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(`OpenCode staging MCP E2E passed; evidence saved to ${outputPath}`);
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
const runRepairCheck = process.env.OPENCODE_STAGING_REPAIR_E2E === "true";
const runDelegationCheck = process.env.OPENCODE_STAGING_DELEGATION_E2E === "true";
const runRecoveryCheck = process.env.OPENCODE_STAGING_RECOVERY_E2E === "true";
const runReadOnlyCheck = process.env.OPENCODE_STAGING_READ_ONLY_E2E === "true";
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: {
    headers: {
      "CF-Access-Client-Id": accessId,
      "CF-Access-Client-Secret": accessSecret
    }
  }
});

function parseResult(result, label) {
  assert.equal(result.isError, undefined, `${label} should be callable.`);
  const item = result.content.find(block => block.type === "text");
  assert.ok(item && "text" in item, `${label} must return JSON text.`);
  return JSON.parse(item.text);
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    "staging_agent_check", "staging_agent_check_status", "staging_cancel_task", "staging_diagnostics",
    "staging_mcp_call", "staging_mcp_servers", "staging_mcp_tools", "staging_models",
    "staging_openrouter_check", "staging_openrouter_check_status", "staging_repositories",
    "staging_review_task", "staging_session_inspect", "staging_sessions", "staging_start_task",
    "staging_status", "staging_task_continue", "staging_task_progress", "staging_task_select_model",
    "staging_task_status", "staging_task_transcript"
  ]);

  const status = await client.callTool({ name: "staging_status", arguments: {} });
  assert.equal(status.isError, undefined);
  const block = status.content.find(item => item.type === "text");
  assert.ok(block && "text" in block && typeof block.text === "string", "MCP status must return JSON text.");
  const parsed = JSON.parse(block.text);
  assert.equal(parsed.targetWorker, "opencode-g1-staging", "MCP target must remain fixed to Staging.");
  assert.equal(parsed.status, "ok", "The Staging health check must report ok.");
  assert.equal(parsed.supervisor?.schema, "opencode.staging-control.v2");
  assert.equal(parsed.supervisor?.defaultModel, "economy");
  assert.equal(parsed.supervisor?.worker, "opencode-g1-staging");

  const [modelResult, repositoryResult, sessionResult, diagnosticsResult, mcpResult] = await Promise.all([
    client.callTool({ name: "staging_models", arguments: {} }),
    client.callTool({ name: "staging_repositories", arguments: {} }),
    client.callTool({ name: "staging_sessions", arguments: {} }),
    client.callTool({ name: "staging_diagnostics", arguments: {} }),
    client.callTool({ name: "staging_mcp_servers", arguments: {} })
  ]);
  const models = parseResult(modelResult, "model discovery");
  const repositories = parseResult(repositoryResult, "repository discovery");
  const sessions = parseResult(sessionResult, "session discovery");
  const diagnostics = parseResult(diagnosticsResult, "diagnostics");
  const mcpServers = parseResult(mcpResult, "MCP discovery");
  assert.ok(models.models.some(model => model.selection === "economy" && model.providerID === "cloudflare"));
  assert.ok(repositories.repositories.includes("aamvtrampa36-del/opencode-harness-example"));
  assert.ok(Array.isArray(sessions.sessions));
  assert.equal(diagnostics.targetWorker, "opencode-g1-staging");
  assert.ok(Array.isArray(mcpServers.servers));
  let mcpToolDiscovery;
  if (mcpServers.servers.length > 0) {
    const firstServer = mcpServers.servers[0].id;
    mcpToolDiscovery = parseResult(await client.callTool({ name: "staging_mcp_tools", arguments: {
      server: firstServer
    } }), "dynamic MCP tool discovery");
    assert.ok(Array.isArray(mcpToolDiscovery.tools));
  }

  const invalidWorkspace = await client.callTool({ name: "staging_sessions", arguments: { workspace: "production" } });
  assert.equal(invalidWorkspace.isError, true, "The MCP schema must reject a non-UUID workspace.");
  const arbitraryWorkspace = await client.callTool({ name: "staging_start_task", arguments: {
    requestId: randomUUID().replaceAll("-", "").slice(0, 16),
    prompt: "No reutilices un workspace sin una sesión de origen exacta",
    workspace: "7bd8f26f-b2b8-4e4d-9abc-0678294c33ab"
  } });
  assert.equal(arbitraryWorkspace.isError, true, "A workspace without sourceSession must fail closed.");

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

  let openRouterCheck;
  if (runOpenRouterCheck) {
    const startedResult = await client.callTool({ name: "staging_openrouter_check", arguments: {} });
    assert.equal(startedResult.isError, undefined, "OpenRouter diagnostic should start through the MCP.");
    const startedBlock = startedResult.content.find(item => item.type === "text");
    assert.ok(startedBlock && "text" in startedBlock, "Diagnostic start should return JSON text.");
    const started = JSON.parse(startedBlock.text);
    assert.equal(started.provider, "openrouter");
    assert.equal(started.requestedModel, "z-ai/glm-5.3-flash");
    assert.ok(["started", "existing"].includes(started.status),
      `Unexpected diagnostic start result: ${JSON.stringify({ status: started.status, message: started.message, model: started.model, kind: started.kind })}`);

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
    assert.equal(openRouterCheck.expectedBunVersion, "1.4.4");
    assert.equal(openRouterCheck.bunVersion, "1.4.4", "Linux must print the pinned Bun version.");
    assert.equal(openRouterCheck.modelVerified, true);
    assert.equal(openRouterCheck.runtimeVerified, true);
    assert.equal(openRouterCheck.fileVerified, true, "Linux must independently verify the isolated proof file.");
    assert.ok(openRouterCheck.toolCalls >= 1, "The agent must make a real Linux tool call.");
  }

  let repairCheck;
  if (runRepairCheck) {
    const startResult = await client.callTool({ name: "staging_agent_check", arguments: {
      model: "economy", kind: "repair"
    } });
    const start = parseResult(startResult, "isolated repair check start");
    assert.ok(["started", "existing"].includes(start.status),
      `Repair check did not start: ${start.status ?? JSON.stringify(start)}`);
    const deadline = Date.now() + 6.5 * 60_000;
    while (Date.now() < deadline) {
      const value = parseResult(await client.callTool({ name: "staging_agent_check_status", arguments: {} }),
        "isolated repair check status");
      repairCheck = value;
      if (value.status === "passed") break;
      assert.ok(["queued", "running"].includes(value.status),
        `Repair check failed: ${value.reason ?? value.status}`);
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    assert.equal(repairCheck?.status, "passed", "The isolated red-to-green repair must pass.");
    assert.equal(repairCheck.kind, "repair");
    assert.equal(repairCheck.model, "economy");
    assert.ok(repairCheck.toolCalls >= 4, "The agent must run the failing test, inspect, repair, and rerun it.");
    assert.equal(repairCheck.fileVerified, true, "The server must verify the repaired Linux file independently.");
    assert.ok(repairCheck.observedFailingTest, "The test must prove the original test failed before repair.");
  }

  let delegationCheck;
  if (runDelegationCheck) {
    const requestId = randomUUID().replaceAll("-", "").slice(0, 16);
    const prompt = "En el repositorio de OpenCode Staging, inspecciona src/staging-control-mcp/server.ts y sus pruebas. " +
      "Verifica que staging_start_task rechaza workspace sin sourceSession y que el fork exacto sigue funcionando. " +
      "Usa repo_read para leer ambas rutas y la herramienta linux para ejecutar " +
      "bun test src/staging-control-mcp/server.test.ts. Si falta la protección, impleméntala junto con una regresión; " +
      `Crea también docs/opencode-remote-control-e2e/${requestId}.md con un breve informe factual de la prueba. ` +
      "Guarda solo esos archivos en la rama precreada y abre una PR borrador. No fusiones ni despliegues. " +
      "Informa comandos, exitCode, hallazgos y evidencia de las herramientas usadas.";
    const start = parseResult(await client.callTool({ name: "staging_start_task", arguments: {
      requestId, prompt, repository: "aamvtrampa36-del/opencode-harness-example", model: "economy"
    } }), "delegated engineering start");
    assert.equal(start.id, requestId);
    assert.equal(start.reused, false, "A newly reserved task must not be reported as a retry.");
    assert.equal(start.targetWorker, "opencode-g1-staging");
    delegationCheck = await pollTask(client, requestId);
    assert.equal(delegationCheck.status, "finished", `Delegated task ended ${delegationCheck.status}.`);
    assert.ok(delegationCheck.toolCalls >= 2 && delegationCheck.completedTools >= 2,
      "Delegation must execute both repository and Linux tools, not only generate text.");
    const transcript = await getTaskTranscript(client, requestId);
    assert.match(transcript, /Herramienta: (?:linux|repo_read)/,
      "Transcript must expose at least one redacted real tool record.");
    assert.match(transcript, /Herramienta: github\b/, "The agent must perform a real GitHub branch write.");
    assert.match(transcript, /\"action\"\s*:\s*\"pr\"/,
      "The agent must submit a draft PR through the scoped GitHub tool.");
    assert.match(transcript, /\"draft\"\s*:\s*true/,
      "The GitHub result must confirm that the pull request is a draft.");
    delegationCheck.transcriptSha256 = createHash("sha256").update(transcript).digest("hex");
    delegationCheck.transcriptBytes = Buffer.byteLength(transcript);
    const review = parseResult(await client.callTool({ name: "staging_review_task", arguments: { id: requestId } }),
      "delegated branch review");
    assert.equal(review.reviewRequired, true);
    assert.equal(review.approved, false, "Review evidence must never auto-approve or merge.");
    const reviewFiles = review.review?.files ?? [];
    assert.ok(reviewFiles.some(file => file.path === `docs/opencode-remote-control-e2e/${requestId}.md`),
      "The scoped GitHub review must show the task's evidence file in its isolated branch diff.");
    delegationCheck.reviewFiles = reviewFiles.length;
  }

  let recoveryCheck;
  if (runRecoveryCheck) {
    const requestId = randomUUID().replaceAll("-", "").slice(0, 16);
    const firstPrompt = "Ejecuta una comprobación corta de recuperación: usa repo_read para leer src/supervisor-control.ts " +
      "y usa linux para ejecutar node -e \"console.log('RECOVERY_FIRST_OK')\". Devuelve el resultado real de ambas herramientas. " +
      "No modifiques archivos ni GitHub.";
    const initial = parseResult(await client.callTool({ name: "staging_start_task", arguments: {
      requestId, prompt: firstPrompt, model: "economy"
    } }), "recoverable task start");
    assert.equal(initial.reused, false);
    const saved = { id: initial.id, session: initial.session, branch: initial.branch,
      project: initial.project, operationId: initial.operationId };
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);

    const reconnectClient = new Client({ name: "opencode-staging-control-reconnect-e2e", version: "1.0.0" });
    const reconnectTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: {
        "CF-Access-Client-Id": accessId,
        "CF-Access-Client-Secret": accessSecret
      } }
    });
    await reconnectClient.connect(reconnectTransport);
    try {
      const retried = parseResult(await reconnectClient.callTool({ name: "staging_start_task", arguments: {
        requestId, prompt: firstPrompt, model: "economy"
      } }), "idempotent recovery retry");
      assert.equal(retried.reused, true);
      for (const key of Object.keys(saved)) assert.equal(retried[key], saved[key], `Retry changed ${key}.`);
      let task = await pollTask(reconnectClient, requestId);
      assert.equal(task.status, "finished");
      assert.ok(task.completedTools >= 2, "The first operation must prove actual repository and Linux tool execution.");

      const turnId = randomUUID().replaceAll("-", "").slice(0, 16);
      const secondPrompt = "Continúa después de reconectar: usa linux para ejecutar node -e \"console.log('RECOVERY_TURN_OK')\" " +
        "y reporta la salida exacta. No cambies archivos.";
      const turn = parseResult(await reconnectClient.callTool({ name: "staging_task_continue", arguments: {
        id: requestId, turnId, prompt: secondPrompt
      } }), "recovered continuation");
      assert.equal(turn.status, "submitted");
      await reconnectClient.close().catch(() => undefined);
      await reconnectTransport.close().catch(() => undefined);

      const finalClient = new Client({ name: "opencode-staging-control-final-e2e", version: "1.0.0" });
      const finalTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: {
          "CF-Access-Client-Id": accessId,
          "CF-Access-Client-Secret": accessSecret
        } }
      });
      await finalClient.connect(finalTransport);
      try {
        const turnRetry = parseResult(await finalClient.callTool({ name: "staging_task_continue", arguments: {
          id: requestId, turnId, prompt: secondPrompt
        } }), "idempotent continuation retry");
        assert.equal(turnRetry.operationId, turn.operationId);
        task = await pollTask(finalClient, requestId);
        assert.equal(task.status, "finished");
        const transcript = await getTaskTranscript(finalClient, requestId);
        assert.match(transcript, /RECOVERY_FIRST_OK/);
        assert.match(transcript, /RECOVERY_TURN_OK/);
        recoveryCheck = {
          id: requestId, workspace: initial.workspace, session: initial.session, branch: initial.branch,
          operationId: initial.operationId, turnOperationId: turn.operationId, status: task.status,
          toolCalls: task.toolCalls, completedTools: task.completedTools,
          transcriptSha256: createHash("sha256").update(transcript).digest("hex"),
          transcriptBytes: Buffer.byteLength(transcript), reconnects: 2, duplicateOperationsPrevented: true
        };
      } finally {
        await finalClient.close().catch(() => undefined);
        await finalTransport.close().catch(() => undefined);
      }
    } finally {
      await reconnectClient.close().catch(() => undefined);
      await reconnectTransport.close().catch(() => undefined);
    }
  }

  let readOnlyCheck;
  if (runReadOnlyCheck) {
    const requestId = randomUUID().replaceAll("-", "").slice(0, 16);
    const repository = "aamvtrampa36-del/opencode-harness-example";
    // Pinned to the independently CI-approved deployment SHA and its Git tree.
    const sourceCommit = "fb123432439abb5ecc7506f34e55447c804c0eca";
    const sourceTree = "73f6520ea6a785624d79813d4c431b2566a719c6";
    const prompt = "Certificación funcional de importación Git por SHA en modo read_only. " +
      "Usa la herramienta linux para ejecutar exactamente: ls -l src/supervisor-control.ts && echo SHA_CERTIFIED_LINUX_OK. " +
      "Reporta el código de salida y el marcador exacto. No escribas archivos, no abras ramas ni PR, no modifiques GitHub.";
    console.log("Starting read_only SHA runtime task: " + requestId);
    const started = parseResult(await client.callTool({ name: "staging_start_task", arguments: {
      requestId, prompt, repository, model: "economy", mode: "read_only", sourceCommit, sourceTree
    } }), "read_only SHA task start");
    assert.equal(started.mode, "read_only", "Runtime must preserve the read_only mode.");
    assert.equal(started.branch, "", "read_only must not reserve a GitHub branch.");
    assert.equal(started.baseCommit, sourceCommit, "Runtime must verify the exact source commit.");
    assert.equal(started.sourceTree, sourceTree, "Runtime must certify the exact Git tree.");
    assert.equal(started.reused, false);
    const completed = await pollTask(client, requestId);
    assert.equal(completed.status, "finished", "Read-only model execution must complete.");
    assert.ok(completed.completedTools >= 1, "Runtime must execute at least one real tool.");
    const transcript = await getTaskTranscript(client, requestId);
    assert.match(transcript, /Herramienta: linux\b/, "Transcript must prove a Linux tool call.");
    assert.match(transcript, /SHA_CERTIFIED_LINUX_OK/, "Linux must observe the imported source.");
    assert.doesNotMatch(transcript, /"action"\s*:\s*"(?:branch|write|pr|review)"/,
      "Read-only task must not perform a GitHub write.");
    readOnlyCheck = {
      requestId, repository, sourceCommit, sourceTree, status: completed.status,
      completedTools: completed.completedTools, branch: started.branch,
      transcriptSha256: createHash("sha256").update(transcript).digest("hex"),
      transcriptBytes: Buffer.byteLength(transcript)
    };
  }

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
      "tools/call staging_models/staging_repositories/staging_sessions/staging_diagnostics/staging_mcp_servers/staging_mcp_tools",
      "tools/call staging_task_status (unknown ID; read only)",
      "negative schema and explicit-fork precondition checks",
      ...(runRepairCheck ? ["real isolated Linux red-to-green repair using Cloudflare economy"] : []),
      ...(runDelegationCheck ? ["delegated Staging engineering task with GitHub repo_read, Linux tests and branch review"] : []),
      ...(runRecoveryCheck ? ["client disconnect/reconnect, idempotent task retry, continuation retry and transcript recovery"] : []),
      ...(runReadOnlyCheck ? ["live read_only import of CI-approved commit and exact tree, verified by Linux"] : []),
      ...(runOpenRouterCheck ? ["tools/call staging_openrouter_check and poll status (OpenRouter + Bun + Linux proof)"] : [])
    ]
  };
  if (openRouterCheck) evidence.openRouterCheck = openRouterCheck;
  if (repairCheck) evidence.repairCheck = repairCheck;
  if (delegationCheck) evidence.delegationCheck = delegationCheck;
  if (recoveryCheck) evidence.recoveryCheck = recoveryCheck;
  if (readOnlyCheck) evidence.readOnlyCheck = readOnlyCheck;
  const outputPath = join(process.env.RUNNER_TEMP ?? "/tmp", "opencode-staging-control-mcp.json");
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(`OpenCode staging MCP E2E passed; evidence saved to ${outputPath}`);
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}

async function pollTask(connection, id) {
  const deadline = Date.now() + 10 * 60_000;
  let latest;
  while (Date.now() < deadline) {
    latest = parseResult(await connection.callTool({ name: "staging_task_status", arguments: { id } }),
      `task ${id} status`);
    if (["finished", "failed", "unanswered", "cancelled"].includes(latest.status)) return latest;
    assert.ok(["preparing", "running", "cancel_requested", "unknown"].includes(latest.status),
      `Unexpected task state: ${latest.status}`);
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  await connection.callTool({ name: "staging_cancel_task", arguments: { id } }).catch(() => undefined);
  throw new Error(`Task ${id} did not finish in ten minutes; cancellation was requested.`);
}

async function getTaskTranscript(connection, id) {
  const response = await connection.callTool({ name: "staging_task_transcript", arguments: { id } });
  assert.equal(response.isError, undefined, `Task ${id} transcript must be readable.`);
  const item = response.content.find(block => block.type === "text");
  assert.ok(item && "text" in item, `Task ${id} transcript must contain text.`);
  return item.text;
}

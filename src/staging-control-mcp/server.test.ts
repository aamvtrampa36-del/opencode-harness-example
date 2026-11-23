import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";
import { BUN_RUNTIME_VERSION, commandRequiresBun } from "../dev-runtime";
import {
  createStagingControlServer,
  STAGING_REPOSITORY,
  STAGING_OPENROUTER_MODEL,
  STAGING_WORKER,
  SUPERVISOR_OBJECT,
  type StagingSupervisor
} from "./server";

describe("OpenCode staging MCP server", () => {
  test("serves only fixed staging tools and binds task creation to the staging repository", async () => {
    let started: unknown;
    let requestedWorkspace: string | undefined;
    let startCount = 0;
    let healthReads = 0;
    let largeDiagnostics = false;
    let defaultSupervisorCalls = 0;
    let customSupervisorCalls = 0;
    let derivedDiagnostics = false;
    const diagnosticBase = Date.parse("2026-11-10T12:00:00Z");
    const diagnosticRecords = Array.from({ length: 30 }, (_, index) => {
      const count = index % 4 + 1;
      const taskId = index % 3 === 0 ? index.toString(16).padStart(16, "0") : undefined;
      return {
        id: "SHELL_FAILED:linux:project-" + index + ":linux:1:-:-" + (taskId ?? "-"),
        code: "SHELL_FAILED", source: "linux", project: "project-" + index, tool: "linux", exitCode: 1,
        ...(taskId ? { taskId } : {}), count,
        firstAt: new Date(diagnosticBase).toISOString(),
        lastAt: new Date(diagnosticBase + index * 60_000).toISOString(),
        suspectedCause: "Comando Linux terminó con error", action: "Examinar exitCode",
        status: count > 2 ? "blocked" : count > 1 ? "repeated" : "open",
        automaticRetryAllowed: false
      };
    });
    let openRouterCheckResult: Record<string, unknown> = {
      status: "passed", model: "review", kind: "bun", providerID: "openrouter",
      providerModel: STAGING_OPENROUTER_MODEL, bunVersion: BUN_RUNTIME_VERSION,
      runtimeVerified: true, toolCalls: 1, fileVerified: true
    };
    const operations: string[] = [];
    const supervisor: StagingSupervisor = {
      async remoteSupervisorStatus() { return { ready: true, defaultModel: "economy" }; },
      async remoteSupervisorProgress(id, after = 0) { operations.push(`progress:${id}:${after}`); return { events: [], nextAfter: after }; },
      async remoteSupervisorContinue(input) { operations.push("continue"); return { status: "submitted", ...(input as object) }; },
      async remoteSupervisorSelectModel(id, model) { operations.push(`select:${id}:${model}`); return { id, model }; },
      async remoteSupervisorModels() { operations.push("models"); return { models: [{ selection: "economy" }] }; },
      async remoteSupervisorRepositories() { operations.push("repositories"); return { repositories: [STAGING_REPOSITORY] }; },
      async remoteSupervisorSessions() { operations.push("sessions"); return { sessions: [] }; },
      async remoteSupervisorInspectSession(id) { operations.push(`session-inspect:${id}`); return { session: id, transcriptExcerpt: "safe" }; },
      async remoteSupervisorMcpServers() { operations.push("mcp-servers"); return { servers: [{ id: "test-mcp" }] }; },
      async remoteSupervisorMcpTools(server) { operations.push(`mcp-tools:${server}`); return { tools: [{ name: "read" }] }; },
      async remoteSupervisorMcpCall(input) { operations.push(`mcp-call:${input.server}.${input.name}`); return { result: { isError: false } }; },
      async remoteSupervisorDiagnostics() {
        operations.push("diagnostics");
        if (derivedDiagnostics) {
          const taskId = "0123456789abcdef";
          return { targetWorker: STAGING_WORKER, incidents: [{
            id: "SHELL_FAILED:linux:supervised-" + taskId + ":linux:1:-:-",
            code: "SHELL_FAILED", source: "linux", project: "supervised-" + taskId,
            tool: "linux", exitCode: 1, count: 1,
            firstAt: new Date(diagnosticBase).toISOString(), lastAt: new Date(diagnosticBase).toISOString(),
            suspectedCause: "Comando Linux terminó con error", action: "Examinar exitCode",
            status: "open", automaticRetryAllowed: false
          }] };
        }
        return { targetWorker: STAGING_WORKER, incidents: largeDiagnostics ? diagnosticRecords : [] };
      },
      async remoteSupervisorAgentCheck(model, kind) { operations.push(`agent-check:${model}:${kind}`); return { status: "started", model, kind }; },
      async remoteSupervisorAgentCheckStatus(scope) {
        operations.push(`agent-check-status:${scope ?? "default"}`);
        return scope === "openrouter" ? openRouterCheckResult : { status: "passed", model: "economy", kind: "repair" };
      },
      async startAgentCheck(model, kind, scope) {
        operations.push(`start-agent-check:${model}:${kind}:${scope ?? "default"}`);
        return { status: "started", model, kind, providerID: "openrouter", providerModel: STAGING_OPENROUTER_MODEL };
      },
      async startSupervisedTask(input) {
        started = input;
        startCount++;
        operations.push("start");
        return { id: "a1234567890bcdef", status: "running", reused: false,
          branch: "opencode/staging-a1234567890bcdef" };
      },
      async supervisedTaskStatus(id) { operations.push("status:" + id); return { id, status: "running", session: "sesAbc123" }; },
      async cancelSupervisedTask(id) { operations.push("cancel:" + id); return { id, status: "cancelled" }; },
      async supervisedTaskReview(id) { operations.push("review:" + id); return { id, reviewRequired: true, approved: false }; },
      async supervisedTaskTranscript() {
        return JSON.stringify({ messages: [
          { type: "user", text: "Revisa este token ghp_abcdefghijklmnopqrstuvwx" },
          { type: "assistant", content: [{ type: "reasoning", text: "oculto" }, { type: "text", text: "Resultado" }] }
        ] });
      }
    };

    const server = createStagingControlServer({
      async readHealth() {
        healthReads++;
        return Response.json({ status: "ok", runtime: "workerd" });
      },
      supervisor: workspace => {
        if (workspace) {
          requestedWorkspace = workspace;
          customSupervisorCalls++;
        } else {
          defaultSupervisorCalls++;
        }
        return supervisor;
      }
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "staging-control-unit-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual([
        "staging_agent_check", "staging_agent_check_status", "staging_cancel_task",
        "staging_capture_task_artifact", "staging_diagnostics", "staging_mcp_call", "staging_mcp_servers", "staging_mcp_tools",
        "staging_models", "staging_openrouter_check", "staging_openrouter_check_status",
        "staging_repositories", "staging_review_task", "staging_session_inspect", "staging_sessions",
        "staging_start_task", "staging_status", "staging_task_artifacts", "staging_task_continue", "staging_task_progress", "staging_task_select_model",
        "staging_task_status", "staging_task_transcript"
      ]);
      const taskStatusTool = tools.find(tool => tool.name === "staging_task_status");
      expect(taskStatusTool?.description).toContain("Omite workspace");
      expect(taskStatusTool?.description).toContain("UUID exacto");

      const status = await client.callTool({ name: "staging_status", arguments: {} });
      expect(JSON.parse(textContent(status))).toMatchObject({ targetWorker: STAGING_WORKER, status: "ok",
        supervisor: { ready: true, defaultModel: "economy" } });
      expect(healthReads).toBe(1);

      expect(JSON.parse(textContent(await client.callTool({ name: "staging_models", arguments: {} })))
        .models[0].selection).toBe("economy");
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_repositories", arguments: {} })))
        .repositories).toEqual([STAGING_REPOSITORY]);
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_sessions", arguments: {} })))
        .sessions).toEqual([]);
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_session_inspect", arguments: {
        session: "sesAbc123"
      } }))).transcriptExcerpt).toBe("safe");
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_mcp_servers", arguments: {} })))
        .servers[0].id).toBe("test-mcp");
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_mcp_tools", arguments: { server: "test-mcp" } })))
        .tools[0].name).toBe("read");
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_mcp_call", arguments: {
        server: "test-mcp", name: "read", arguments: { path: "README.md" }
      } }))).result.isError).toBe(false);
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_diagnostics", arguments: {} })))
        .incidents).toEqual([]);
      largeDiagnostics = true;
      const largeDiagnosticPayload = JSON.parse(textContent(
        await client.callTool({ name: "staging_diagnostics", arguments: {} })
      ));
      expect(largeDiagnosticPayload.targetWorker).toBe(STAGING_WORKER);
      expect(largeDiagnosticPayload._responseTruncated).toBeUndefined();
      expect(largeDiagnosticPayload.incidents).toHaveLength(20);
      expect(largeDiagnosticPayload.summary).toMatchObject({
        total: 30, shown: 20, omitted: 10, hasMore: true, taskCorrelated: 10, uncorrelated: 20
      });
      expect(largeDiagnosticPayload.hasMore).toBe(true);
      expect(largeDiagnosticPayload.omitted).toBe(10);
      expect(largeDiagnosticPayload.order).toContain("blocked > repeated > open");
      expect(largeDiagnosticPayload.correlation).toMatchObject({ field: "taskId", equalsRequestId: true });
      expect(largeDiagnosticPayload.incidents.every((item: { taskId: string | null }) =>
        item.taskId === null || /^[a-f0-9]{16}$/.test(item.taskId))).toBe(true);
      const correlatedIncident = largeDiagnosticPayload.incidents.find(
        (item: { taskId: string | null }) => typeof item.taskId === "string"
      );
      expect(correlatedIncident).toBeTruthy();
      const correlatedStatus = await client.callTool({
        name: "staging_task_status", arguments: { id: correlatedIncident.taskId }
      });
      expect(JSON.parse(textContent(correlatedStatus))).toMatchObject({
        targetWorker: STAGING_WORKER, id: correlatedIncident.taskId
      });
      const limitedDiagnostics = JSON.parse(textContent(
        await client.callTool({ name: "staging_diagnostics", arguments: { limit: 5 } })
      ));
      expect(limitedDiagnostics.incidents).toHaveLength(5);
      expect(limitedDiagnostics.summary).toMatchObject({ total: 30, shown: 5, omitted: 25, hasMore: true });
      expect(limitedDiagnostics.hasMore).toBe(true);
      derivedDiagnostics = true;
      const derivedPayload = JSON.parse(textContent(
        await client.callTool({ name: "staging_diagnostics", arguments: {} })
      ));
      expect(derivedPayload.incidents).toHaveLength(1);
      expect(derivedPayload.incidents[0].taskId).toBe("0123456789abcdef");
      expect(derivedPayload.summary).toMatchObject({ total: 1, shown: 1, omitted: 0,
        hasMore: false, taskCorrelated: 1, uncorrelated: 0 });
      expect(derivedPayload.correlation).toMatchObject({ field: "taskId", equalsRequestId: true });
      expect(derivedPayload.correlation.derivation).toContain("supervised-<requestId>");
      const derivedStatus = await client.callTool({
        name: "staging_task_status", arguments: { id: derivedPayload.incidents[0].taskId }
      });
      expect(JSON.parse(textContent(derivedStatus))).toMatchObject({
        targetWorker: STAGING_WORKER, id: "0123456789abcdef"
      });
      derivedDiagnostics = false;
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_agent_check", arguments: {} })))
        .model).toBe("economy");
      expect(JSON.parse(textContent(await client.callTool({ name: "staging_agent_check_status", arguments: {} })))
        .status).toBe("passed");

      const modelCheck = await client.callTool({ name: "staging_openrouter_check", arguments: {} });
      expect(JSON.parse(textContent(modelCheck))).toMatchObject({
        status: "started", model: "review", kind: "bun", provider: "openrouter",
        requestedModel: STAGING_OPENROUTER_MODEL, targetWorker: STAGING_WORKER
      });
      const modelCheckStatus = await client.callTool({ name: "staging_openrouter_check_status", arguments: {} });
      expect(JSON.parse(textContent(modelCheckStatus))).toMatchObject({
        status: "passed", expectedProvider: "openrouter", expectedModel: STAGING_OPENROUTER_MODEL,
        expectedBunVersion: BUN_RUNTIME_VERSION, bunVersion: BUN_RUNTIME_VERSION,
        provider: "openrouter", providerID: "openrouter", providerModel: STAGING_OPENROUTER_MODEL,
        modelVerified: true, runtimeVerified: true, toolProofVerified: true,
        toolCalls: 1, fileVerified: true, targetWorker: STAGING_WORKER
      });
      openRouterCheckResult = { status: "passed", model: "economy", kind: "repair", providerID: "cloudflare" };
      const staleOpenRouterCheck = JSON.parse(textContent(await client.callTool({
        name: "staging_openrouter_check_status", arguments: {}
      })));
      expect(staleOpenRouterCheck).toMatchObject({
        status: "failed", modelVerified: false, toolProofVerified: false,
        provider: "cloudflare", targetWorker: STAGING_WORKER
      });

      const start = await client.callTool({
        name: "staging_start_task",
        arguments: { requestId: "a1234567890bcdef", prompt: "Inspecciona el modo staging y corrige una prueba" }
      });
      const startPayload = JSON.parse(textContent(start));
      expect(startPayload).toMatchObject({
        targetWorker: STAGING_WORKER,
        id: "a1234567890bcdef",
        status: "running", reused: false
      });
      expect(startPayload).not.toHaveProperty("workspace");
      expect(defaultSupervisorCalls).toBeGreaterThan(0);
      expect(customSupervisorCalls).toBe(0);
      expect(started).toEqual({
        requestId: "a1234567890bcdef",
        repository: STAGING_REPOSITORY,
        prompt: "Inspecciona el modo staging y corrige una prueba"
      });

      const workspace = "7bd8f26f-b2b8-4e4d-9abc-0678294c33ab";
      const fork = await client.callTool({ name: "staging_start_task", arguments: {
        requestId: "c1234567890bcdef", prompt: "Continúa desde la conversación indicada con una rama aislada",
        repository: STAGING_REPOSITORY, model: "economy", workspace, sourceSession: "sesAbc123"
      } });
      const forkPayload = JSON.parse(textContent(fork));
      expect(forkPayload).toMatchObject({ workspace, targetWorker: STAGING_WORKER });
      expect(forkPayload.workspace).toBe(workspace);
      expect(requestedWorkspace).toBe(workspace);
      expect(customSupervisorCalls).toBe(1);
      expect(started).toEqual({ requestId: "c1234567890bcdef", repository: STAGING_REPOSITORY,
        prompt: "Continúa desde la conversación indicada con una rama aislada", model: "economy",
        sourceSession: "sesAbc123" });
      const startsBeforeInvalidFork = startCount;
      const invalidFork = await client.callTool({ name: "staging_start_task", arguments: {
        requestId: "d1234567890bcdef", prompt: "Intenta hacer fork sin aportar un workspace válido",
        sourceSession: "sesAbc123"
      } });
      expect(invalidFork.isError).toBe(true);
      expect(startCount).toBe(startsBeforeInvalidFork);
      const workspaceWithoutFork = await client.callTool({ name: "staging_start_task", arguments: {
        requestId: "e1234567890bcdef", prompt: "No reutilices el workspace sin una sesión de origen",
        workspace
      } });
      expect(workspaceWithoutFork.isError).toBe(true);
      expect(startCount).toBe(startsBeforeInvalidFork);

      const defaultCallsBeforeTaskStatus = defaultSupervisorCalls;
      const taskStatus = await client.callTool({ name: "staging_task_status", arguments: { id: "a1234567890bcdef" } });
      expect(JSON.parse(textContent(taskStatus))).toMatchObject({ targetWorker: STAGING_WORKER, status: "running" });
      expect(defaultSupervisorCalls).toBe(defaultCallsBeforeTaskStatus + 1);
      expect(customSupervisorCalls).toBe(1);
      const progress = await client.callTool({ name: "staging_task_progress", arguments: { id: "a1234567890bcdef", after: 0 } });
      expect(JSON.parse(textContent(progress))).toMatchObject({ targetWorker: STAGING_WORKER, events: [], nextAfter: 0 });
      const continued = await client.callTool({ name: "staging_task_continue", arguments: {
        id: "a1234567890bcdef", turnId: "b1234567890cdefa", prompt: "Corrige el rumbo y repite la verificación"
      } });
      expect(JSON.parse(textContent(continued))).toMatchObject({ targetWorker: STAGING_WORKER, status: "submitted" });
      const selected = await client.callTool({ name: "staging_task_select_model", arguments: {
        id: "a1234567890bcdef", model: "economy"
      } });
      expect(JSON.parse(textContent(selected))).toMatchObject({ targetWorker: STAGING_WORKER, model: "economy" });
      const cancellation = await client.callTool({ name: "staging_cancel_task", arguments: { id: "a1234567890bcdef" } });
      expect(JSON.parse(textContent(cancellation))).toMatchObject({ targetWorker: STAGING_WORKER, status: "cancelled" });
      const review = await client.callTool({ name: "staging_review_task", arguments: { id: "a1234567890bcdef" } });
      expect(JSON.parse(textContent(review))).toMatchObject({ targetWorker: STAGING_WORKER, reviewRequired: true, approved: false });

      const transcript = await client.callTool({
        name: "staging_task_transcript", arguments: { id: "a1234567890bcdef" }
      });
      const transcriptText = textContent(transcript);
      expect(transcriptText).toContain("sesAbc123");
      expect(transcriptText).toContain("[REDACTADO]");
      expect(transcriptText).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
      expect(transcriptText).not.toContain("oculto");
      expect(operations).toContain("start");
      expect(operations).toContain("status:a1234567890bcdef");
      expect(operations).toContain("cancel:a1234567890bcdef");
      expect(operations).toContain("review:a1234567890bcdef");
      expect(operations).toContain("models");
      expect(operations).toContain("session-inspect:sesAbc123");
      expect(operations).toContain("mcp-call:test-mcp.read");
      expect(operations).toContain("progress:a1234567890bcdef:0");
      expect(operations).toContain("continue");
      expect(operations).toContain("select:a1234567890bcdef:economy");
      expect(operations).toContain("agent-check-status:default");
      expect(operations).toContain("agent-check-status:openrouter");
      expect(operations).toContain("start-agent-check:review:bun:openrouter");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps a stable staging identity and dedicated supervisor object name", () => {
    expect(STAGING_WORKER).toBe("opencode-g1-staging");
    expect(SUPERVISOR_OBJECT).toBe("opencode-supervisor-v1");
    expect(STAGING_REPOSITORY).toBe("aamvtrampa36-del/opencode-harness-example");
    expect(STAGING_OPENROUTER_MODEL).toBe("z-ai/glm-5.3-flash");
  });

  test("refreshes the live status when an idempotent start request is reused", async () => {
    const id = "b1234567890cdefa";
    let statusReads = 0;
    const supervisor: StagingSupervisor = {
      async remoteSupervisorStatus() { return { ready: true }; },
      async remoteSupervisorProgress() { return { events: [] }; },
      async remoteSupervisorContinue() { return { status: "submitted" }; },
      async remoteSupervisorSelectModel(taskId, model) { return { id: taskId, model }; },
      async remoteSupervisorModels() { return { models: [] }; },
      async remoteSupervisorRepositories() { return { repositories: [] }; },
      async remoteSupervisorSessions() { return { sessions: [] }; },
      async remoteSupervisorInspectSession(id) { return { session: id }; },
      async remoteSupervisorMcpServers() { return { servers: [] }; },
      async remoteSupervisorMcpTools() { return { tools: [] }; },
      async remoteSupervisorMcpCall() { return { result: {} }; },
      async remoteSupervisorDiagnostics() { return { incidents: [] }; },
      async remoteSupervisorAgentCheck(model, kind) { return { status: "started", model, kind }; },
      async remoteSupervisorAgentCheckStatus() { return { status: "not-started" }; },
      async startAgentCheck(model, kind) { return { status: "started", model, kind }; },
      async startSupervisedTask() {
        return { id, status: "running", reused: true, branch: `opencode/staging-${id}`,
          workspace: SUPERVISOR_OBJECT };
      },
      async supervisedTaskStatus(taskId) {
        statusReads++;
        expect(taskId).toBe(id);
        return { id, status: "finished", session: "sesFinished", reviewRequired: true,
          workspace: SUPERVISOR_OBJECT };
      },
      async cancelSupervisedTask(taskId) { return { id: taskId, status: "cancelled" }; },
      async supervisedTaskReview(taskId) { return { id: taskId, reviewRequired: true, approved: false }; },
      async supervisedTaskTranscript() {
        return JSON.stringify({ messages: [] });
      }
    };
    const server = createStagingControlServer({
      async readHealth() { return Response.json({ status: "ok" }); },
      supervisor: () => supervisor
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "staging-control-idempotency-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "staging_start_task",
        arguments: { requestId: id, prompt: "Repite la consulta de estado idempotente" }
      });
      const payload = JSON.parse(textContent(response));
      expect(payload).toMatchObject({
        id,
        status: "finished",
        reused: true,
        targetWorker: STAGING_WORKER
      });
      expect(payload).not.toHaveProperty("workspace");
      expect(JSON.stringify(payload)).not.toContain(SUPERVISOR_OBJECT);
      expect(statusReads).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function textContent(value: { content: Array<{ type: string; text?: string }> }): string {
  const block = value.content.find(item => item.type === "text");
  if (!block?.text) throw new Error("MCP tool returned no text block");
  return block.text;
}

describe("managed Linux runtime selection", () => {
  test("bootstraps the pinned Bun only when the shell command invokes bun or bunx", () => {
    expect(BUN_RUNTIME_VERSION).toBe("1.4.4");
    expect(commandRequiresBun("bun --version")).toBe(true);
    expect(commandRequiresBun("bun run test")).toBe(true);
    expect(commandRequiresBun("bunx wrangler deploy --dry-run")).toBe(true);
    expect(commandRequiresBun("node --version && npm --version")).toBe(false);
    expect(commandRequiresBun("echo bun is a runtime")).toBe(false);
  });
});


describe("F0-C10 R2 task artifact MCP projection", () => {
  test("never copies bytes, internal paths or bearer into the manifest", async () => {
    const id = "0000000000000001";
    let captured = 0;
    const stub = {
      async supervisedTaskArtifacts(taskId: string) {
        expect(taskId).toBe(id);
        return {
          schema: "opencode.task-output.v1", requestId: id,
          passed: false, verified: false, reviewRequired: true,
          artifacts: [{
            requestId: id, artifactId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            name: "relatório.md", mime: "text/markdown", byteSize: 5,
            sha256: "1".repeat(64),
            delivery: {
              kind: "authenticated-route",
              path: "/api/supervisor/v1/tasks/" + id +
                "/artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              expiresAt: 1795380000000
            }
          }]
        };
      },
      async supervisedArtifactCapture(taskId: string, payload: unknown) {
        expect(taskId).toBe(id);
        expect(payload).toEqual({ path: "dist/report.md", name: "relatório.md", mime: "text/markdown" });
        captured++;
        return { requestId: id, artifactId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", byteSize: 5 };
      }
    } as unknown as StagingSupervisor;
    const server = createStagingControlServer({
      async readHealth() { return Response.json({ status: "ok" }); },
      supervisor: () => stub
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifact-mcp-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = JSON.parse(textContent(await client.callTool({
        name: "staging_task_artifacts", arguments: { id }
      })));
      expect(listed).toMatchObject({ requestId: id, passed: false, verified: false });
      expect(JSON.stringify(listed)).not.toContain("dist/report.md");
      expect(JSON.stringify(listed)).not.toContain("/bundle");
      expect(JSON.stringify(listed)).not.toContain("Bearer");
      const capturedResult = JSON.parse(textContent(await client.callTool({
        name: "staging_capture_task_artifact",
        arguments: { id, path: "dist/report.md", name: "relatório.md", mime: "text/markdown" }
      })));
      expect(capturedResult).toMatchObject({ requestId: id, byteSize: 5 });
      expect(captured).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

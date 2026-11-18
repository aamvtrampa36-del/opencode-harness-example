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
    let healthReads = 0;
    const operations: string[] = [];
    const supervisor: StagingSupervisor = {
      async startAgentCheck(model, kind) { operations.push(`agent-check:${model}:${kind}`); return { status: "started", model, kind }; },
      async agentCheckStatus() { operations.push("agent-check-status"); return { status: "passed", model: "review", kind: "bun", bunVersion: BUN_RUNTIME_VERSION, runtimeVerified: true, toolCalls: 1, fileVerified: true }; },
      async startSupervisedTask(input) {
        started = input;
        operations.push("start");
        return { id: "a1234567890bcdef", status: "running", branch: "opencode/staging-a1234567890bcdef" };
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
      supervisor: () => supervisor
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "staging-control-unit-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual([
        "staging_cancel_task", "staging_openrouter_check", "staging_openrouter_check_status",
        "staging_review_task", "staging_start_task",
        "staging_status", "staging_task_status", "staging_task_transcript"
      ]);

      const status = await client.callTool({ name: "staging_status", arguments: {} });
      expect(JSON.parse(textContent(status))).toMatchObject({ targetWorker: STAGING_WORKER, status: "ok" });
      expect(healthReads).toBe(1);

      const modelCheck = await client.callTool({ name: "staging_openrouter_check", arguments: {} });
      expect(JSON.parse(textContent(modelCheck))).toMatchObject({
        status: "started", model: "review", kind: "bun", provider: "openrouter",
        requestedModel: STAGING_OPENROUTER_MODEL, targetWorker: STAGING_WORKER
      });
      const modelCheckStatus = await client.callTool({ name: "staging_openrouter_check_status", arguments: {} });
      expect(JSON.parse(textContent(modelCheckStatus))).toMatchObject({
        status: "passed", expectedProvider: "openrouter", expectedModel: STAGING_OPENROUTER_MODEL,
        expectedBunVersion: BUN_RUNTIME_VERSION, bunVersion: BUN_RUNTIME_VERSION,
        modelVerified: true, runtimeVerified: true, toolCalls: 1, fileVerified: true, targetWorker: STAGING_WORKER
      });

      const start = await client.callTool({
        name: "staging_start_task",
        arguments: { requestId: "a1234567890bcdef", prompt: "Inspecciona el modo staging y corrige una prueba" }
      });
      expect(JSON.parse(textContent(start))).toMatchObject({
        targetWorker: STAGING_WORKER,
        id: "a1234567890bcdef",
        status: "running"
      });
      expect(started).toEqual({
        requestId: "a1234567890bcdef",
        repository: STAGING_REPOSITORY,
        prompt: "Inspecciona el modo staging y corrige una prueba"
      });

      const taskStatus = await client.callTool({ name: "staging_task_status", arguments: { id: "a1234567890bcdef" } });
      expect(JSON.parse(textContent(taskStatus))).toMatchObject({ targetWorker: STAGING_WORKER, status: "running" });
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
      expect(operations).toEqual([
        "agent-check:review:bun", "agent-check-status", "start", "status:a1234567890bcdef",
        "cancel:a1234567890bcdef", "review:a1234567890bcdef",
        "status:a1234567890bcdef"
      ]);
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
      async startAgentCheck(model, kind) { return { status: "started", model, kind }; },
      async agentCheckStatus() { return { status: "not-started" }; },
      async startSupervisedTask() {
        return { id, status: "running", reused: true, branch: `opencode/staging-${id}` };
      },
      async supervisedTaskStatus(taskId) {
        statusReads++;
        expect(taskId).toBe(id);
        return { id, status: "finished", session: "sesFinished", reviewRequired: true };
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
      expect(JSON.parse(textContent(response))).toMatchObject({
        id,
        status: "finished",
        reused: true,
        targetWorker: STAGING_WORKER
      });
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

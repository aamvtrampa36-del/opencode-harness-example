import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";
import {
  createStagingControlServer,
  STAGING_REPOSITORY,
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
        "staging_cancel_task", "staging_review_task", "staging_start_task",
        "staging_status", "staging_task_status", "staging_task_transcript"
      ]);

      const status = await client.callTool({ name: "staging_status", arguments: {} });
      expect(JSON.parse(textContent(status))).toMatchObject({ targetWorker: STAGING_WORKER, status: "ok" });
      expect(healthReads).toBe(1);

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
        "start", "status:a1234567890bcdef", "cancel:a1234567890bcdef", "review:a1234567890bcdef",
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
  });
});

function textContent(value: { content: Array<{ type: string; text?: string }> }): string {
  const block = value.content.find(item => item.type === "text");
  if (!block?.text) throw new Error("MCP tool returned no text block");
  return block.text;
}

import { describe, expect, mock, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ DurableObject: class {}, RpcTarget: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {}, exports: {} }));
mock.module("cloudflare:email", () => ({ EmailMessage: class {} }));
const { OpenCodeAgent } = await import("./server");
import { supervisorTaskKey, type SupervisorTask } from "./supervisor-control";

const UNAVAILABLE = "SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED";

function fixture(overrides: Partial<SupervisorTask> = {}) {
  const task: SupervisorTask = {
    id: "a6c0847e2f931b5d", repository: "aamvtrampa36-del/opencode-harness-example",
    project: "supervised-a6c0847e2f931b5d", branch: "opencode/staging-a6c0847e2f931b5d",
    fingerprint: "f".repeat(64), createdAt: 1, updatedAt: 1, status: "running",
    model: "economy", session: "sesTest", operationId: "op-1",
    baseCommit: "11161dd6f2c4b5237a2da59d7275ff693e0afdbe", ...overrides
  };
  const rows = new Map<string, unknown>([[supervisorTaskKey(task.id), { ...task }]]);
  const calls = { history: 0, wait: 0, session: 0, log: 0, writes: 0 };
  const storage = {
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: unknown) => { calls.writes++; rows.set(key, value); },
    transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(storage)
  };
  const agent = Object.create(OpenCodeAgent.prototype) as any;
  agent.env = { OPENCODE_SUPERVISOR_ENABLED: "true" };
  agent.ctx = { storage };
  agent.harness = {
    sessions: { list: async () => [{ id: "sesTest", busy: false, title: "Test" }] },
    session: () => {
      calls.session++;
      return {
        history: async () => { calls.history++; throw new Error("UNSAFE_HISTORY_CALLED"); },
        wait: async () => { calls.wait++; throw new Error("UNSAFE_WAIT_CALLED"); },
        busy: async () => false,
        log: () => { calls.log++; throw new Error("UNSAFE_NATIVE_LOG_CALLED"); }
      };
    }
  };
  return { agent, task, rows, calls };
}

describe("F0-OOM-02 supervisor transcript memory containment", () => {
  test("task transcript fails closed without materializing history", async () => {
    const { agent, task, calls } = fixture();
    await expect(agent.supervisedTaskTranscript(task.id)).rejects.toThrow(UNAVAILABLE);
    expect(calls.history).toBe(0);
    expect(calls.wait).toBe(0);
  });

  test("inspector exposes only durable snapshot without wait/history", async () => {
    const { agent, task, calls } = fixture({ error: "prior failure" });
    const result = await agent.remoteSupervisorInspect(task.id);
    expect(result.snapshot).toBe(true);
    expect(result.status).toMatchObject({ id: task.id, status: "running", snapshot: true,
      source: "supervisor-task-ledger", error: "prior failure", passed: false, verified: false });
    expect(result.transcriptAvailable).toBe(false);
    expect(result.progressAvailableViaCursor).toBe(false);
    expect(result.progressError).toBe("SUPERVISOR_PROGRESS_UNAVAILABLE_UNBOUNDED_SDK");
    expect(result.transcriptError).toBe(UNAVAILABLE);
    expect(calls.history).toBe(0);
    expect(calls.wait).toBe(0);
    expect(calls.session).toBe(0);
  });

  test("session inspector rejects unsafe transcript before history access", async () => {
    const { agent, calls } = fixture();
    await expect(agent.remoteSupervisorInspectSession("sesTest")).rejects.toThrow(UNAVAILABLE);
    expect(calls.history).toBe(0);
    expect(calls.session).toBe(0);
  });

  test("retains session identity and missing-record validation", async () => {
    const { agent, calls } = fixture();
    await expect(agent.remoteSupervisorInspectSession("not-a-session")).rejects.toThrow("Identificador de sesión inválido");
    await expect(agent.supervisedTaskTranscript("0000000000000000")).rejects.toThrow("Tarea del supervisor inexistente");
    expect(calls.history).toBe(0);
  });


  test("legacy export fails before sessions.list, history or serialization", async () => {
    const { agent, calls } = fixture();
    agent.harness.sessions.list = async () => { throw new Error("UNSAFE_LIST_CALLED"); };
    await expect(agent.exportSessionData("sesTest")).rejects.toThrow("SESSION_EXPORT_PAGINATION_UNAVAILABLE_LEGACY");
    await expect(agent.exportSessionData("../bad")).rejects.toThrow("SESSION_EXPORT_ID_INVALID");
    expect(calls.history).toBe(0);
    expect(calls.session).toBe(0);
    expect(calls.wait).toBe(0);
  });


  test("R3 remote status snapshot is read-only, non-native and never PASS", async () => {
    const { agent, task, calls } = fixture({
      status: "unknown", error: "turn_submit: effect_unknown"
    });
    const value = await agent.remoteSupervisorTaskStatusSnapshot(task.id);
    expect(value).toMatchObject({
      id: task.id, status: "unknown", recordedStatus: "unknown",
      snapshot: true, nativeReconciled: false, toolCountsComplete: false,
      passed: false, verified: false, reviewRequired: true
    });
    expect(calls).toEqual({ history: 0, wait: 0, session: 0, log: 0, writes: 0 });
  });

  test("R3 remote progress refuses any SDK log() allocation and never advances cursor", async () => {
    const { agent, task, calls } = fixture();
    for (const after of [0, 128, 1_000_000]) {
      const page = await agent.remoteSupervisorProgress(task.id, after);
      expect(page).toMatchObject({
        taskId: task.id, nextAfter: after, events: [], scanned: 0,
        pageAvailable: false, complete: false, truncated: true,
        error: "SUPERVISOR_PROGRESS_UNAVAILABLE_UNBOUNDED_SDK",
        passed: false, verified: false, snapshot: true
      });
    }
    await expect(agent.remoteSupervisorProgress(task.id, -1))
      .rejects.toThrow("SUPERVISOR_PROGRESS_CURSOR_INVALID");
    expect(calls).toEqual({ history: 0, wait: 0, session: 0, log: 0, writes: 0 });
  });

  test("R3 ten concurrent task snapshots are independent across restart-like re-instantiation", async () => {
    const { agent, task, rows, calls } = fixture();
    const tasks = Array.from({ length: 10 }, (_, i) => {
      const id = i.toString(16).padStart(16, "0");
      rows.set(supervisorTaskKey(id), {
        ...task, id, project: "supervised-" + id,
        branch: "opencode/staging-" + id,
        session: "ses_r2_" + id,
        status: i % 2 ? "running" : "unknown"
      });
      return id;
    });
    const receipts = await Promise.all(tasks.map(async id =>
      ({ id, snapshot: await agent.remoteSupervisorTaskStatusSnapshot(id),
        progress: await agent.remoteSupervisorProgress(id, 123) })
    ));
    expect(new Set(receipts.map(x => x.snapshot.id)).size).toBe(10);
    for (const item of receipts) {
      expect(item.snapshot.id).toBe(item.id);
      expect(item.snapshot.verified).toBe(false);
      expect(item.progress.nextAfter).toBe(123);
      expect(item.progress.pageAvailable).toBe(false);
      expect(item.progress.passed).toBe(false);
    }
    // A fresh DO can retrieve the same durable map; no native event read needed.
    const again = await agent.remoteSupervisorTaskStatusSnapshot(tasks[0]);
    expect(again.id).toBe(tasks[0]);
    expect(calls).toEqual({ history: 0, wait: 0, session: 0, log: 0, writes: 0 });
  });

  test("requires supervisor enablement before transcript operations", async () => {
    const { agent, task, calls } = fixture();
    agent.env.OPENCODE_SUPERVISOR_ENABLED = "false";
    await expect(agent.supervisedTaskTranscript(task.id)).rejects.toThrow();
    await expect(agent.remoteSupervisorInspect(task.id)).rejects.toThrow();
    expect(calls.history).toBe(0);
  });
});

import { describe, expect, mock, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ DurableObject: class {}, RpcTarget: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {}, exports: {} }));
mock.module("cloudflare:email", () => ({ EmailMessage: class {} }));
const { OpenCodeAgent } = await import("./server");
import { supervisorTaskKey, type SupervisorTask } from "./supervisor-control";

function memoryStorage(initial: Record<string, unknown>) {
  const rows = new Map(Object.entries(initial));
  const storage: any = {};
  storage.get = async <T>(key: string) => rows.get(key) as T | undefined;
  storage.put = async (key: string, value: unknown) => { rows.set(key, value); };
  storage.transaction = async <T>(run: (tx: any) => Promise<T>) => run(storage);
  return { storage, rows };
}

function task(overrides: Partial<SupervisorTask> = {}): SupervisorTask {
  return {
    id: "a6c0847e2f931b5d",
    repository: "aamvtrampa36-del/opencode-harness-example",
    project: "supervised-a6c0847e2f931b5d",
    branch: "opencode/staging-a6c0847e2f931b5d",
    fingerprint: "f".repeat(64),
    createdAt: 1,
    updatedAt: 1,
    status: "running",
    model: "economy",
    session: "sesTest",
    operationId: "op-1",
    baseCommit: "6755de9b96cb42b70ba238f6e35150e6a08637d6",
    ...overrides
  };
}

async function statusOf(stored: SupervisorTask, operation: unknown, busy = false) {
  const { storage, rows } = memoryStorage({ [supervisorTaskKey(stored.id)]: { ...stored } });
  const agent = Object.create(OpenCodeAgent.prototype) as Record<string, unknown>;
  agent.env = { OPENCODE_SUPERVISOR_ENABLED: "true" };
  agent.ctx = { storage };
  agent.harness = {
    session: () => ({
      wait: async () => operation,
      busy: async () => busy,
      log: () => (async function* () {})()
    })
  };
  const response = await (agent as unknown as {
    supervisedTaskStatus(id: string): Promise<Record<string, unknown>>;
  }).supervisedTaskStatus(stored.id);
  const saved = rows.get(supervisorTaskKey(stored.id)) as SupervisorTask;
  return { response, saved };
}

async function cancelOf(stored: SupervisorTask) {
  const { storage, rows } = memoryStorage({ [supervisorTaskKey(stored.id)]: { ...stored } });
  const agent = Object.create(OpenCodeAgent.prototype) as Record<string, unknown>;
  agent.env = { OPENCODE_SUPERVISOR_ENABLED: "true" };
  agent.ctx = { storage };
  let abortCalls = 0;
  agent.harness = {
    session: () => ({ abort: async () => { abortCalls++; return true; } })
  };
  const response = await (agent as unknown as {
    cancelSupervisedTask(id: string): Promise<Record<string, unknown>>;
  }).cancelSupervisedTask(stored.id);
  const saved = rows.get(supervisorTaskKey(stored.id)) as SupervisorTask;
  return { response, saved, abortCalls };
}

describe("supervisedTaskStatus returns the reconciled task error", () => {
  test("a done operation clears a stale error from the returned receipt", async () => {
    const { response, saved } = await statusOf(task({ error: "stale failure" }), { status: "done", text: "ok" });
    expect(response.status).toBe("finished");
    expect(response.error).toBeUndefined();
    expect(response.passed).toBe(false);
    expect(response.verified).toBe(false);
    expect(response.reviewRequired).toBe(true);
    expect(saved.error).toBeUndefined();
  });

  test("an unanswered failure returns its reason and stays fail-closed", async () => {
    const { response } = await statusOf(task(), { status: "unanswered", reason: "failed" });
    expect(response.status).toBe("failed");
    expect(response.error).toBe("failed");
    expect(response.passed).toBe(false);
    expect(response.verified).toBe(false);
    expect(response.reviewRequired).toBe(true);
  });

  test("an interrupted cancellation returns its reason and is not passed", async () => {
    const { response } = await statusOf(task({ status: "cancel_requested" }),
      { status: "unanswered", reason: "interrupted" });
    expect(response.status).toBe("cancelled");
    expect(response.error).toBe("interrupted");
    expect(response.passed).toBe(false);
    expect(response.verified).toBe(false);
  });

  test("a stale error is cleared when the stored status already matches", async () => {
    const { response } = await statusOf(task({ status: "finished", error: "stale failure" }),
      { status: "done", text: "ok" });
    expect(response.status).toBe("finished");
    expect(response.error).toBeUndefined();
  });
});

describe("cancelSupervisedTask reports unconfirmed legacy cancellation", () => {
  test("a session without an operation id is left unknown, not falsely cancelled", async () => {
    const { response, saved, abortCalls } = await cancelOf(task({ operationId: undefined }));
    expect(response.status).toBe("unknown");
    expect(response.confirmed).toBe(false);
    expect(response.reason).toBe("OpenCode operation id missing");
    expect(saved.status).toBe("unknown");
    expect(abortCalls).toBe(0);
  });
});

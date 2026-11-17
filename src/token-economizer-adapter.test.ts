import { describe, expect, test } from "bun:test";
import { invokeConnector, type ConnectorEvent } from "./connector-adapter";
import { tokenEconomizerAdapter } from "./token-economizer-adapter";

type Hook = (input: any) => Promise<unknown> | unknown;

function eventQueue() {
  const queued: unknown[] = [];
  let waiter: ((value: IteratorResult<unknown>) => void) | undefined;
  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<unknown>>(resolve => {
          const value = queued.shift();
          if (value !== undefined) resolve({ value, done: false });
          else waiter = resolve;
        }),
        return: async () => ({ value: undefined, done: true })
      };
    }
  };
  return {
    iterable,
    emit(value: unknown) {
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve({ value, done: false });
      } else queued.push(value);
    }
  };
}

describe("TokenEconomizer OpenCode adapter", () => {
  test("maps prompt, context, tool and turn-end events into the connector contract", async () => {
    const hooks = new Map<string, Hook>();
    const events: ConnectorEvent[] = [];
    const stream = eventQueue();
    const completionWaiters: Array<() => void> = [];
    const waitForEnd = () => new Promise<void>(resolve => completionWaiters.push(resolve));
    let starts = 0;
    const endEvent = waitForEnd();
    const plugin = tokenEconomizerAdapter(async () => true, async (_id, event) => {
      events.push(event);
      if (event.name === "SessionStart") {
        starts++;
        return { additionalContext: starts === 1 ? "manual inicial" : "hecho reutilizable" };
      }
      if (event.name === "UserPromptSubmit") return { additionalContext: "contexto de prompt" };
      if (event.name === "PostToolUse") return { additionalContext: "continúa desde el resultado" };
      if (event.name === "SessionEnd") completionWaiters.shift()?.();
      return {};
    }, async () => "proyecto-prueba");
    const setup = plugin.setup as unknown as (ctx: unknown) => Promise<() => void>;
    const cleanup = await setup({
      location: { directory: "/workspace/project" },
      session: { hook: async (name: string, handler: Hook) => { hooks.set("session:" + name, handler); } },
      tool: { hook: async (name: string, handler: Hook) => { hooks.set("tool:" + name, handler); } },
      event: { subscribe: () => stream.iterable }
    });

    await hooks.get("session:prompt")!({ sessionID: "ses_test", messageID: "user-1", prompt: { text: "Comprueba el entorno" } });
    const system: unknown[] = [];
    await hooks.get("session:context")!({ sessionID: "ses_test", system });
    expect(system).toEqual([{ type: "text", text: "manual inicial\n\ncontexto de prompt" }]);

    const result = { content: [{ type: "text", text: "Python 3 disponible" }] };
    await hooks.get("tool:execute.after")!({ sessionID: "ses_test", id: "tool-1", tool: "linux",
      input: { command: "python3 --version" }, status: "completed", result });
    expect(result.content).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ name: "PostToolUse", project: "proyecto-prueba",
      toolName: "linux", toolUseID: "tool-1" });

    stream.emit({ type: "session.tool.input.started", properties: { sessionID: "ses_test",
      assistantMessageID: "assistant-1", id: "tool-1", name: "linux" } });
    stream.emit({ type: "session.tool.called", properties: { sessionID: "ses_test",
      assistantMessageID: "assistant-1", id: "tool-1", input: { command: "python3 --version" } } });
    stream.emit({ type: "session.tool.success", properties: { sessionID: "ses_test",
      assistantMessageID: "assistant-1", id: "tool-1", content: [{ type: "text", text: "Python 3 disponible" }], metadata: { exit: 0 } } });
    stream.emit({ type: "session.execution.succeeded", properties: { sessionID: "ses_test" } });
    await endEvent;
    const stop = events.find(event => event.name === "Stop");
    const end = events.find(event => event.name === "SessionEnd");
    expect(stop?.sessionID).toMatch(/^ses[a-f0-9]{32}$/);
    expect(end?.sessionID).toBe(stop?.sessionID);
    expect(end?.transcript).toContain("Comprueba el entorno");
    expect(end?.transcript).toContain("Python 3 disponible");
    expect(end?.project).toBe("proyecto-prueba");
    const exported = JSON.parse(end?.transcript ?? "{}") as {
      messages?: Array<{ info?: { path?: { cwd?: string } }; parts?: Array<{
        tool?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string }
      }> }>
    };
    const bashMessage = exported.messages?.find(message => message.parts?.some(part => part.tool === "bash"));
    const bashCall = bashMessage?.parts?.find(part => part.tool === "bash");
    expect(bashCall).toMatchObject({ tool: "bash", state: {
      status: "completed", input: { command: "python3 --version" }, output: "Python 3 disponible"
    } });
    expect(bashMessage?.info?.path?.cwd)
      .toBe("/workspace/projects/opencode-connectors/workspaces/proyecto-prueba");

    const secondEnd = waitForEnd();
    await hooks.get("session:prompt")!({ sessionID: "ses_test", messageID: "user-2", prompt: { text: "Repite la tarea" } });
    const nextSystem: unknown[] = [];
    await hooks.get("session:context")!({ sessionID: "ses_test", system: nextSystem });
    expect(nextSystem).toEqual([{ type: "text", text: "hecho reutilizable\n\ncontexto de prompt" }]);
    stream.emit({ type: "session.execution.succeeded", properties: { sessionID: "ses_test" } });
    await secondEnd;
    expect(events.filter(event => event.name === "SessionStart")).toHaveLength(2);
    expect(events.filter(event => event.name === "SessionEnd")).toHaveLength(2);
    expect(new Set(events.filter(event => event.name === "SessionEnd").map(event => event.sessionID)).size).toBe(2);
    cleanup();
  });

  test("optional connector errors leave the chat event unchanged", async () => {
    const event: ConnectorEvent = { name: "SessionStart", sessionID: "ses_test", project: "global" };
    expect(await invokeConnector(async () => { throw new Error("connector offline"); }, "token-economizer", event)).toEqual({});
  });

  test("reads nonzero Linux exit codes from the real JSON result for hooks and transcripts", async () => {
    const hooks = new Map<string, Hook>();
    const events: ConnectorEvent[] = [];
    const stream = eventQueue();
    let resolveEnd!: () => void;
    const ended = new Promise<void>(resolve => { resolveEnd = resolve; });
    const plugin = tokenEconomizerAdapter(async () => true, async (_id, event) => {
      events.push(event);
      if (event.name === "SessionEnd") resolveEnd();
      return {};
    }, async () => "app-test");
    const setup = plugin.setup as unknown as (ctx: unknown) => Promise<() => void>;
    const cleanup = await setup({
      location: { directory: "/workspace/project" },
      session: { hook: async (name: string, handler: Hook) => { hooks.set("session:" + name, handler); } },
      tool: { hook: async (name: string, handler: Hook) => { hooks.set("tool:" + name, handler); } },
      event: { subscribe: () => stream.iterable }
    });

    await hooks.get("session:prompt")!({ sessionID: "ses_linux_failure", messageID: "user-1", prompt: { text: "Ejecuta pytest" } });
    const commandOutput = JSON.stringify({
      project: "app-test", exitCode: 127, stdout: "", stderr: "bash: pytest: command not found"
    });
    await hooks.get("tool:execute.after")!({ sessionID: "ses_linux_failure", id: "tool-1", tool: "linux",
      input: { command: "pytest" }, status: "completed", result: { content: commandOutput } });
    expect(events.at(-1)).toMatchObject({ name: "PostToolUse", project: "app-test", toolName: "linux",
      toolResponse: { content: commandOutput, isError: true, exit_code: 127 } });

    stream.emit({ type: "session.tool.input.started", properties: { sessionID: "ses_linux_failure",
      assistantMessageID: "assistant-1", id: "tool-1", name: "linux" } });
    stream.emit({ type: "session.tool.called", properties: { sessionID: "ses_linux_failure",
      assistantMessageID: "assistant-1", id: "tool-1", input: { command: "pytest" } } });
    stream.emit({ type: "session.tool.success", properties: { sessionID: "ses_linux_failure",
      assistantMessageID: "assistant-1", id: "tool-1", content: commandOutput } });
    stream.emit({ type: "session.execution.succeeded", properties: { sessionID: "ses_linux_failure" } });
    await ended;

    const end = events.find(event => event.name === "SessionEnd");
    const transcript = JSON.parse(end?.transcript ?? "{}") as {
      messages?: Array<{ parts?: Array<{ tool?: string; state?: { status?: string; error?: string } }> }>
    };
    const bashCall = transcript.messages?.flatMap(message => message.parts ?? []).find(part => part.tool === "bash");
    expect(bashCall?.state?.status).toBe("error");
    expect(bashCall?.state?.error).toContain("pytest: command not found");
    expect(end?.project).toBe("app-test");
    cleanup();
  });
});

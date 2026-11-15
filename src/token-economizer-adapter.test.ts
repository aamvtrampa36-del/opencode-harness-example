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
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    const plugin = tokenEconomizerAdapter(async () => true, async (_id, event) => {
      events.push(event);
      if (event.name === "SessionStart") return { additionalContext: "manual inicial" };
      if (event.name === "UserPromptSubmit") return { additionalContext: "contexto de prompt" };
      if (event.name === "PostToolUse") return { additionalContext: "continúa desde el resultado" };
      if (event.name === "Stop") stop();
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
    await stopped;
    const end = events.find(event => event.name === "Stop");
    expect(end?.transcript).toContain("Comprueba el entorno");
    expect(end?.transcript).toContain("Python 3 disponible");
    cleanup();
  });

  test("optional connector errors leave the chat event unchanged", async () => {
    const event: ConnectorEvent = { name: "SessionStart", sessionID: "ses_test", project: "global" };
    expect(await invokeConnector(async () => { throw new Error("connector offline"); }, "token-economizer", event)).toEqual({});
  });
});

import type { Plugin } from "@opencode/plugin";
import { invokeConnector, type ConnectorEvent, type ConnectorRunner } from "./connector-adapter";

type TranscriptPart = Record<string, unknown>;
type TranscriptMessage = { info: Record<string, unknown>; parts: TranscriptPart[] };

const textOf = (value: unknown): string => typeof value === "string" ? value :
  Array.isArray(value) ? value.map(item => typeof item === "string" ? item :
    item && typeof item === "object" && "text" in item ? String(item.text ?? "") : "").filter(Boolean).join("\n") : "";

/** TokenEconomizer's upstream hook protocol, adapted to OpenCode's current plugin hooks. */
export function tokenEconomizerAdapter(
  enabled: () => Promise<boolean>,
  runner: ConnectorRunner,
  projectForSession: (sessionID: string) => Promise<string>
): Plugin.Plugin {
  return {
    id: "opencode-cloud.token-economizer",
    async setup(ctx) {
      const manuals = new Map<string, string>();
      const prompts = new Map<string, number>();
      const turns = new Map<string, string>();
      const records = new Map<string, TranscriptMessage[]>();
      const steps = new Map<string, TranscriptMessage>();
      const toolNames = new Map<string, string>();
      const open = new Set<string>();

      const event = async (name: ConnectorEvent["name"], sessionID: string,
        extra: Partial<ConnectorEvent> = {}): Promise<{ additionalContext?: string; systemMessage?: string }> => {
        if (!await enabled()) return {};
        let project = "global";
        try { project = await projectForSession(sessionID) || "global"; } catch { /* global session */ }
        return invokeConnector(runner, "token-economizer", {
          name, sessionID, project, ...extra
        });
      };
      const start = async (sessionID: string) => {
        if (open.has(sessionID)) return;
        open.add(sessionID);
        records.set(sessionID, []);
        prompts.set(sessionID, 0);
        const output = await event("SessionStart", sessionID);
        if (output.additionalContext) manuals.set(sessionID, output.additionalContext);
        if (output.systemMessage) manuals.set(sessionID,
          [manuals.get(sessionID), "Nota de TokenEconomizer: " + output.systemMessage].filter(Boolean).join("\n\n"));
      };
      const assistant = (sessionID: string, messageID: string): TranscriptMessage => {
        let message = steps.get(messageID);
        if (!message) {
          message = { info: { id: messageID, role: "assistant", path: { cwd: ctx.location.directory } }, parts: [] };
          steps.set(messageID, message);
          records.get(sessionID)?.push(message);
        }
        return message;
      };
      const closeTurn = async (sessionID: string) => {
        const promptID = turns.get(sessionID);
        if (!promptID || !await enabled()) return;
        const output = await event("Stop", sessionID, {
          promptID, reason: "end_turn",
          transcript: JSON.stringify({ info: { id: sessionID }, messages: records.get(sessionID) ?? [] })
        });
        if (output.systemMessage) manuals.set(sessionID,
          [manuals.get(sessionID), "Nota de TokenEconomizer: " + output.systemMessage].filter(Boolean).join("\n\n"));
        turns.delete(sessionID);
      };

      await ctx.session.hook("prompt", async input => {
        const sessionID = input.sessionID;
        await start(sessionID);
        const number = (prompts.get(sessionID) ?? 0) + 1;
        prompts.set(sessionID, number);
        const promptID = sessionID + ":" + number;
        turns.set(sessionID, promptID);
        const prompt = input.prompt.text ?? "";
        records.get(sessionID)?.push({
          info: { id: String(input.messageID ?? promptID), role: "user" },
          parts: [{ type: "text", text: prompt }]
        });
        const output = await event("UserPromptSubmit", sessionID, { promptID, prompt });
        if (output.additionalContext) manuals.set(sessionID,
          [manuals.get(sessionID), output.additionalContext].filter(Boolean).join("\n\n"));
        if (output.systemMessage) manuals.set(sessionID,
          [manuals.get(sessionID), "Nota de TokenEconomizer: " + output.systemMessage].filter(Boolean).join("\n\n"));
      });

      await ctx.session.hook("context", input => {
        const manual = manuals.get(input.sessionID);
        if (manual) input.system.push({ type: "text", text: manual });
      });

      await ctx.tool.hook("execute.after", async input => {
        const ok = input.status === "completed";
        const response = ok ? input.result : undefined;
        const text = ok ? textOf(response?.content) || String(response?.output ?? "")
          : String(input.error?.message ?? "");
        const metadata = ok ? response?.metadata : undefined;
        const output = await event("PostToolUse", input.sessionID, {
          promptID: turns.get(input.sessionID) ?? "",
          toolName: input.tool, toolUseID: input.id, toolInput: input.input,
          toolResponse: { content: text, isError: !ok, exit_code: metadata?.exit }
        });
        const context = output.additionalContext;
        // OpenCode exposes the tool result by reference; append the hook nudge to the model result.
        if (context && ok && response) {
          const mutable = response as { content?: string | readonly unknown[] };
          if (typeof mutable.content === "string") mutable.content += "\n\n" + context;
          else if (Array.isArray(mutable.content)) mutable.content = [...mutable.content, { type: "text", text: context }];
          else mutable.content = context;
        }
        if (output.systemMessage) manuals.set(input.sessionID,
          [manuals.get(input.sessionID), "Nota de TokenEconomizer: " + output.systemMessage].filter(Boolean).join("\n\n"));
      });

      const controller = new AbortController();
      void (async () => {
        try {
          for await (const update of ctx.event.subscribe({ signal: controller.signal })) {
            const record = update as unknown as {
              type: string; properties?: Record<string, unknown>; data?: Record<string, unknown>
            };
            const name = record.type;
            const value = record.properties ?? record.data ?? {};
            if (!name.startsWith("session.")) continue;
            const sessionID = typeof value.sessionID === "string" ? value.sessionID : "";
            if (!sessionID) continue;
            if (name === "session.step.started") {
              assistant(sessionID, String(value.assistantMessageID ?? ""))
                .info.modelID = (value.model as { id?: string } | undefined)?.id;
            } else if (name === "session.step.ended") {
              const message = assistant(sessionID, String(value.assistantMessageID ?? ""));
              message.info.cost = value.cost ?? 0;
              message.info.tokens = value.tokens;
            } else if (name === "session.tool.input.started") {
              if (typeof value.id === "string" && typeof value.name === "string") toolNames.set(value.id, value.name);
            } else if (name === "session.tool.called") {
              assistant(sessionID, String(value.assistantMessageID ?? "")).parts.push({
                type: "tool", callID: value.id, tool: toolNames.get(String(value.id)) ?? "",
                state: { status: "running", input: value.input ?? {} }
              });
            } else if (name === "session.tool.success" || name === "session.tool.failed") {
              const call = assistant(sessionID, String(value.assistantMessageID ?? "")).parts
                .find(part => part.callID === value.id);
              const toolError = value.error as { message?: unknown } | undefined;
              if (call) call.state = name === "session.tool.success"
                ? { status: "completed", input: call.state, output: textOf(value.content), metadata: value.metadata ?? {} }
                : { status: "error", input: call.state, error: String(toolError?.message ?? textOf(value.content)) };
            } else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(name) || name === "session.idle") {
              await closeTurn(sessionID);
            } else if (name === "session.deleted") {
              if (open.has(sessionID)) {
                const output = await event("SessionEnd", sessionID, {
                  reason: "deleted",
                  transcript: JSON.stringify({ info: { id: sessionID }, messages: records.get(sessionID) ?? [] })
                });
                if (output.systemMessage) console.warn("TokenEconomizer:", output.systemMessage);
                open.delete(sessionID);
                records.delete(sessionID);
                manuals.delete(sessionID);
              }
            }
          }
        } catch { /* optional connector */ }
      })();

      return () => controller.abort();
    }
  };
}

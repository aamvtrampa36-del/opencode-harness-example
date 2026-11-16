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
      const active = new Map<string, string>();
      const workingDirectories = new Map<string, string>();
      const records = new Map<string, TranscriptMessage[]>();
      const steps = new Map<string, TranscriptMessage>();
      const toolNames = new Map<string, string>();
      const closing = new Set<string>();

      const event = async (name: ConnectorEvent["name"], sessionID: string,
        extra: Partial<ConnectorEvent> = {}, sourceSessionID = sessionID): Promise<{ additionalContext?: string; systemMessage?: string }> => {
        if (!await enabled()) return {};
        let project = "global";
        try { project = await projectForSession(sourceSessionID) || "global"; } catch { /* global session */ }
        workingDirectories.set(sessionID, "/workspace/projects/opencode-connectors/workspaces/" + project);
        return invokeConnector(runner, "token-economizer", {
          name, sessionID, project, ...extra
        });
      };
      const start = async (sessionID: string) => {
        // OpenCode conversations can remain open indefinitely and can receive many tasks. Give
        // each completed task its own upstream session so SessionEnd folds its transcript and
        // envfacts can learn between turns instead of waiting for the conversation to be deleted.
        if (active.has(sessionID)) await closeTurn(sessionID, "interrupted");
        const tokenSessionID = "ses" + crypto.randomUUID().replaceAll("-", "");
        active.set(sessionID, tokenSessionID);
        records.set(tokenSessionID, []);
        const output = await event("SessionStart", tokenSessionID, {}, sessionID);
        if (output.additionalContext) manuals.set(tokenSessionID, output.additionalContext);
        if (output.systemMessage) manuals.set(tokenSessionID,
          [manuals.get(tokenSessionID), "Nota de TokenEconomizer: " + output.systemMessage].filter(Boolean).join("\n\n"));
        return tokenSessionID;
      };
      const assistant = (sessionID: string, tokenSessionID: string, messageID: string): TranscriptMessage => {
        const key = tokenSessionID + ":" + messageID;
        let message = steps.get(key);
        if (!message) {
          message = { info: { id: messageID, role: "assistant",
            path: { cwd: workingDirectories.get(sessionID) ?? ctx.location.directory } }, parts: [] };
          steps.set(key, message);
          records.get(sessionID)?.push(message);
        }
        return message;
      };
      const closeTurn = async (sessionID: string, reason = "end_turn") => {
        const tokenSessionID = active.get(sessionID);
        if (!tokenSessionID || closing.has(tokenSessionID)) return;
        closing.add(tokenSessionID);
        const transcript = JSON.stringify({ info: { id: tokenSessionID }, messages: records.get(tokenSessionID) ?? [] });
        const promptID = turns.get(tokenSessionID);
        try {
          if (promptID) await event("Stop", tokenSessionID, {
            promptID, reason, transcript
          }, sessionID);
          const output = await event("SessionEnd", tokenSessionID, {
            ...(promptID ? { promptID } : {}), reason, transcript
          }, sessionID);
          if (output.systemMessage) console.warn("TokenEconomizer:", output.systemMessage);
        } finally {
          if (active.get(sessionID) === tokenSessionID) active.delete(sessionID);
          turns.delete(tokenSessionID);
          records.delete(tokenSessionID);
          manuals.delete(tokenSessionID);
          workingDirectories.delete(tokenSessionID);
          for (const key of steps.keys()) if (key.startsWith(tokenSessionID + ":")) steps.delete(key);
          for (const key of toolNames.keys()) if (key.startsWith(tokenSessionID + ":")) toolNames.delete(key);
          closing.delete(tokenSessionID);
        }
      };

      await ctx.session.hook("prompt", async input => {
        const sessionID = input.sessionID;
        const tokenSessionID = await start(sessionID);
        const number = (prompts.get(sessionID) ?? 0) + 1;
        prompts.set(sessionID, number);
        const promptID = sessionID + ":" + number;
        turns.set(tokenSessionID, promptID);
        const prompt = input.prompt.text ?? "";
        records.get(tokenSessionID)?.push({
          info: { id: String(input.messageID ?? promptID), role: "user" },
          parts: [{ type: "text", text: prompt }]
        });
        const output = await event("UserPromptSubmit", tokenSessionID, { promptID, prompt }, sessionID);
        if (output.additionalContext) manuals.set(tokenSessionID,
          [manuals.get(tokenSessionID), output.additionalContext].filter(Boolean).join("\n\n"));
        if (output.systemMessage) manuals.set(tokenSessionID,
          [manuals.get(tokenSessionID), "Nota de TokenEconomizer: " + output.systemMessage].filter(Boolean).join("\n\n"));
      });

      await ctx.session.hook("context", input => {
        const tokenSessionID = active.get(input.sessionID);
        const manual = tokenSessionID ? manuals.get(tokenSessionID) : undefined;
        if (manual) input.system.push({ type: "text", text: manual });
      });

      await ctx.tool.hook("execute.after", async input => {
        const tokenSessionID = active.get(input.sessionID);
        if (!tokenSessionID) return;
        const ok = input.status === "completed";
        const response = ok ? input.result : undefined;
        const text = ok ? textOf(response?.content) || String(response?.output ?? "")
          : String(input.error?.message ?? "");
        const metadata = ok ? response?.metadata : undefined;
        const output = await event("PostToolUse", tokenSessionID, {
          promptID: turns.get(tokenSessionID) ?? "",
          toolName: input.tool, toolUseID: input.id, toolInput: input.input,
          toolResponse: { content: text, isError: !ok, exit_code: metadata?.exit }
        }, input.sessionID);
        const context = output.additionalContext;
        // OpenCode exposes the tool result by reference; append the hook nudge to the model result.
        if (context && ok && response) {
          const mutable = response as { content?: string | readonly unknown[] };
          if (typeof mutable.content === "string") mutable.content += "\n\n" + context;
          else if (Array.isArray(mutable.content)) mutable.content = [...mutable.content, { type: "text", text: context }];
          else mutable.content = context;
        }
        if (output.systemMessage) manuals.set(tokenSessionID,
          [manuals.get(tokenSessionID), "Nota de TokenEconomizer: " + output.systemMessage].filter(Boolean).join("\n\n"));
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
            const tokenSessionID = active.get(sessionID);
            if (!tokenSessionID) {
              if (name === "session.deleted") prompts.delete(sessionID);
              continue;
            }
            if (name === "session.step.started") {
              assistant(tokenSessionID, tokenSessionID, String(value.assistantMessageID ?? ""))
                .info.modelID = (value.model as { id?: string } | undefined)?.id;
            } else if (name === "session.step.ended") {
              const message = assistant(tokenSessionID, tokenSessionID, String(value.assistantMessageID ?? ""));
              message.info.cost = value.cost ?? 0;
              message.info.tokens = value.tokens;
            } else if (name === "session.tool.input.started") {
              if (typeof value.id === "string" && typeof value.name === "string")
                toolNames.set(tokenSessionID + ":" + value.id, value.name);
            } else if (name === "session.tool.called") {
              const toolName = toolNames.get(tokenSessionID + ":" + String(value.id)) ?? "";
              assistant(tokenSessionID, tokenSessionID, String(value.assistantMessageID ?? "")).parts.push({
                type: "tool", callID: value.id, tool: toolName === "linux" ? "bash" : toolName,
                state: { status: "running", input: value.input ?? {} }
              });
            } else if (name === "session.tool.success" || name === "session.tool.failed") {
              const call = assistant(tokenSessionID, tokenSessionID, String(value.assistantMessageID ?? "")).parts
                .find(part => part.callID === value.id);
              const toolError = value.error as { message?: unknown } | undefined;
              if (call) call.state = name === "session.tool.success"
                ? { status: "completed", input: call.state, output: textOf(value.content), metadata: value.metadata ?? {} }
                : { status: "error", input: call.state, error: String(toolError?.message ?? textOf(value.content)) };
            } else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(name) || name === "session.idle") {
              await closeTurn(sessionID, name.endsWith("interrupted") ? "interrupted" : "end_turn");
            } else if (name === "session.deleted") {
              await closeTurn(sessionID, "deleted");
              prompts.delete(sessionID);
            }
          }
        } catch { /* optional connector */ }
      })();

      return () => controller.abort();
    }
  };
}

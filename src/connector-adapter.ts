/** OpenCode events translated to the small hook contract future integrations share. */
export type ConnectorEventName = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "SessionEnd";
export type ConnectorEvent = {
  name: ConnectorEventName;
  sessionID: string;
  project: string;
  promptID?: string;
  prompt?: string;
  toolName?: string;
  toolUseID?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  reason?: string;
  transcript?: string;
};
export type ConnectorOutput = { additionalContext?: string; systemMessage?: string };
export type ConnectorRunner = (
  connectorID: string,
  event: ConnectorEvent
) => Promise<ConnectorOutput>;

/** Optional integrations fail open: a stopped connector must not stop a chat turn. */
export async function invokeConnector(
  runner: ConnectorRunner,
  connectorID: string,
  event: ConnectorEvent
): Promise<ConnectorOutput> {
  try {
    return await runner(connectorID, event);
  } catch (error) {
    console.warn(`Connector ${connectorID} hook failed`, error instanceof Error ? error.message : "unknown error");
    return {};
  }
}

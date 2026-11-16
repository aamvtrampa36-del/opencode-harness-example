import type { AgentMode } from "./protocol";

const MODE_PREFIX = "opencode-session-mode:";

export function readSessionMode(storage: Pick<Storage, "getItem">, object: string, session: string): AgentMode {
  // Modes are no longer persistent UI choices. Legacy sessions return to
  // general chat; one-shot read-only actions can still request `review`.
  void storage.getItem(MODE_PREFIX + object + ":" + session);
  return "build";
}

export function saveSessionMode(storage: Pick<Storage, "setItem">, object: string, session: string, mode: AgentMode): void {
  storage.setItem(MODE_PREFIX + object + ":" + session, mode);
}

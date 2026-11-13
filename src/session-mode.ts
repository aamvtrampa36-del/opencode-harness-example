import type { AgentMode } from "./protocol";

const MODE_PREFIX = "opencode-session-mode:";

export function readSessionMode(storage: Pick<Storage, "getItem">, object: string, session: string): AgentMode {
  const mode = storage.getItem(MODE_PREFIX + object + ":" + session);
  return mode === "build" || mode === "plan" || mode === "review" || mode === "creative" ? mode : "review";
}

export function saveSessionMode(storage: Pick<Storage, "setItem">, object: string, session: string, mode: AgentMode): void {
  storage.setItem(MODE_PREFIX + object + ":" + session, mode);
}

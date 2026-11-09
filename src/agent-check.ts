/** Verify native OpenCode tool evidence, never inferred from assistant prose. */
export type AgentCheckEvidence = {
  requestedTools: number;
  finishedLinuxTools: number;
  correctLinuxResult: boolean;
};

export function assessAgentToolEvidence(
  messages: readonly {
    type: string;
    content?: readonly {
      type: string;
      name?: string;
      state?: {
        status?: string;
        content?: readonly { type: string; text?: string }[];
      };
    }[];
  }[],
  project: string,
  token: string
): AgentCheckEvidence {
  let requestedTools = 0;
  let finishedLinuxTools = 0;
  let correctLinuxResult = false;
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue;
      requestedTools++;
      if (part.name !== "linux" || part.state?.status !== "completed") continue;
      finishedLinuxTools++;
      const output = (part.state.content ?? [])
        .filter(c => c.type === "text")
        .map(c => c.text ?? "").join("\n");
      try {
        const result = JSON.parse(output) as {
          project?: string;
          exitCode?: number;
          stdout?: string;
        };
        if (result.project === project && result.exitCode === 0 &&
            result.stdout?.includes("AGENT_PROOF_OK:" + token)) {
          correctLinuxResult = true;
        }
      } catch {
        // A model response that merely describes a command never passes.
      }
    }
  }
  return { requestedTools, finishedLinuxTools, correctLinuxResult };
}

/** Reuse only a genuinely unfinished proof; terminal attempts are retryable. */
export function hasUnfinishedAgentCheck(
  previous: { error?: string } | null | undefined,
  outcome: unknown
): boolean {
  return Boolean(previous && !previous.error && outcome == null);
}

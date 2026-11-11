import { G8_PROOFS } from "./g8-smoke";

/**
 * Strong G8 acceptance: count ONLY actual completed repo_review tool outputs
 * from a real agent session, never model prose or an external GitHub query.
 */
export const G8_LIVE_FILE = "docs/opencode-g8/isolated-review-20261110.md";
export const G8_LIVE_CHECK_VERSION = "g8-live-agent-20261110-v1";
export type G8Proof = (typeof G8_PROOFS)[number];
export type G8LiveTask = {
  repo: string; project: string; branch: string; session: string;
  startedAt: number;
};
export type G8LiveCheck = {
  version: string;
  status: "starting" | "running" | "passed" | "failed";
  startedAt: number;
  tasks: G8LiveTask[];
  reason?: string;
};

export function g8LivePrompt(proof: G8Proof): string {
  return "PRUEBA G8 de lectura REAL del agente, repositorio YA VINCULADO a esta sesión: " +
    proof.repo + ". Modo Revisión, solo lectura. Ejecuta ahora la herramienta EXACTA " +
    "repo_review con el único argumento branch=" + JSON.stringify(proof.branch) +
    ". Espera la RESPUESTA DE LA HERRAMIENTA, compara contra main y menciona el archivo " +
    G8_LIVE_FILE + ". No uses /bundle, ls, find, exec, inspect_linux, " +
    "GitHub de escritura ni otras herramientas. No inventes resultados. " +
    "No modifiques archivos, ramas, PR, canon ni producción.";
}

export type G8LiveEvidence = {
  passed: boolean;
  matchedTools: number;
  completedTools: number;
  failedTools: number;
  reason: string;
};

export function assessG8LiveHistory(messages: readonly unknown[], proof: G8Proof): G8LiveEvidence {
  let matchedTools = 0;
  let completedTools = 0;
  let failedTools = 0;
  let passed = false;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || (raw as {type?:unknown}).type !== "assistant") continue;
    const content = (raw as {content?:unknown}).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || (part as {type?:unknown}).type !== "tool") continue;
      const tool = part as {
        name?: string; state?: {status?: string; content?: {type?: string; text?: string}[]}
      };
      if (tool.state?.status === "error") failedTools++;
      if (tool.state?.status === "completed") completedTools++;
      if (tool.name !== "repo_review") continue;
      matchedTools++;
      if (tool.state?.status !== "completed") continue;
      const text = (tool.state.content ?? []).filter(x=>x?.type === "text")
        .map(x=>x.text ?? "").join("\n");
      try {
        const data = JSON.parse(text) as {
          repo?: string; branch?: string; base?: string;
          truncated?: boolean; files?: {path?: string; status?: string}[]
        };
        if (data.repo?.toLowerCase() === proof.repo.toLowerCase() &&
            data.branch === proof.branch &&
            data.base === "main" && data.truncated !== true &&
            Array.isArray(data.files) && data.files.length === 1 &&
            data.files[0]?.path === G8_LIVE_FILE &&
            data.files[0]?.status === "added") passed = true;
      } catch { /* Never accept a model claim as tool evidence. */ }
    }
  }
  return {
    passed, matchedTools, completedTools, failedTools,
    reason: passed ? "Diff real correcto mediante repo_review"
      : matchedTools === 0 ? "El modelo no invocó repo_review"
      : "repo_review no devolvió un diff auténtico, completo y correspondiente al repositorio"
  };
}

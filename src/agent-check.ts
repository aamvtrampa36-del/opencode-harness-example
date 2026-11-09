/** Verify native OpenCode tool evidence, never inferred from assistant prose. */
export type AgentCheckEvidence = {
  requestedTools: number;
  finishedLinuxTools: number;
  correctLinuxResult: boolean;
  /** A Linux tool returned a real failing Node test in this session. */
  observedFailingTest: boolean;
  /** A successful tool result arrived only AFTER observing a failing test. */
  verifiedRepairSequence: boolean;
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
  let observedFailingTest = false;
  let verifiedRepairSequence = false;
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
        if (result.project !== project) continue;
        // Seeding the fixture server-side is not proof that the model saw its failure.
        if (result.exitCode !== 0 && result.stdout?.includes("not ok")) {
          observedFailingTest = true;
        }
        if (result.exitCode === 0 &&
            result.stdout?.includes("AGENT_PROOF_OK:" + token)) {
          correctLinuxResult = true;
          if (observedFailingTest) verifiedRepairSequence = true;
        }
      } catch {
        // A model response that merely describes a command never passes.
      }
    }
  }
  return { requestedTools, finishedLinuxTools, correctLinuxResult, observedFailingTest, verifiedRepairSequence };
}

/** Reuse only a genuinely unfinished proof; terminal attempts are retryable. */
export function hasUnfinishedAgentCheck(
  previous: { error?: string } | null | undefined,
  outcome: unknown
): boolean {
  return Boolean(previous && !previous.error && outcome == null);
}

/** Restrict expensive diagnostic calls to the baseline and two low-cost presets. */
export const AGENT_CHECK_MODELS = ["cloudflare", "economy", "review"] as const;
export type AgentCheckModel = (typeof AGENT_CHECK_MODELS)[number];
export function isAgentCheckModel(value: unknown): value is AgentCheckModel {
  return typeof value === "string" && AGENT_CHECK_MODELS.some(model => model === value);
}

/** Human-actionable diagnostics, based on actual tool events rather than assistant text. */
export function explainAgentCheckFailure(evidence: AgentCheckEvidence, kind: AgentCheckKind = "linux"): string {
  if (evidence.requestedTools === 0) {
    return "El agente no solicitó herramientas. Es posible que el modelo no haya arrancado; revisa el proveedor y los registros de Cloudflare.";
  }
  if (evidence.finishedLinuxTools === 0) {
    return "El agente solicitó herramientas, pero ninguna ejecución Linux terminó correctamente.";
  }
  if (kind === "repair" && !evidence.observedFailingTest) {
    return "No se observó una prueba Node fallida en las herramientas del agente. La prueba inicial del servidor no cuenta como observación del modelo.";
  }
  if (kind === "repair" && !evidence.verifiedRepairSequence) {
    return "El agente observó el fallo, pero no consta una ejecución Linux posterior que haya pasado la prueba y devuelto el token."; 
  }
  if (!evidence.correctLinuxResult) {
    return "Linux respondió, pero faltó la salida verificable del comando solicitado o su resultado fue incorrecto.";
  }
  return "Linux devolvió el resultado esperado, pero la comprobación independiente del archivo persistido falló.";
}


/** An isolated red-to-green Node test. This is a fixture, NOT a repository change. */
export const REPAIR_SOURCE_BROKEN = "export const add = (a, b) => a - b;\n";
export const REPAIR_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from './calc.mjs';",
  "test('sumar dos numeros', () => assert.equal(add(2, 3), 5));",
  ""
].join("\n");

export const AGENT_CHECK_KINDS = ["linux", "repair"] as const;
export type AgentCheckKind = (typeof AGENT_CHECK_KINDS)[number];
export function isAgentCheckKind(value: unknown): value is AgentCheckKind {
  return typeof value === "string" && AGENT_CHECK_KINDS.some(kind => kind === value);
}

/** Seed a known failing test before letting the model edit the isolated files. */
export function repairSeedCommand(): string {
  const script = "const fs=require('node:fs');" +
    "fs.writeFileSync('calc.mjs'," + JSON.stringify(REPAIR_SOURCE_BROKEN) + ");" +
    "fs.writeFileSync('calc.test.mjs'," + JSON.stringify(REPAIR_TEST) + ");";
  return "node -e " + JSON.stringify(script) + " && node --test --test-reporter=tap calc.test.mjs";
}

/** A fix only counts when the source changed, the test was not weakened and Node passes. */
export function repairIsVerified(source: string, test: string, exitCode: number | null): boolean {
  return source !== REPAIR_SOURCE_BROKEN && test === REPAIR_TEST && exitCode === 0;
}

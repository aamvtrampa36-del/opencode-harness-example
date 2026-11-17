/**
 * G9 staging acceptance: a real agent must repair a deliberately broken,
 * non-production source file in a private review branch and prove it with Linux.
 * The server seeds the fixture; the model must perform the actual code fix.
 */
export const G9_PROOF_VERSION = "g9-native-e2e-v2-20261117";
export const G9_REPO = "aamvtrampa36-del/opencode-harness-example";
export const G9_BRANCH = "opencode/g9-native-e2e-20261117";
export const G9_PROJECT = "g9-native-e2e-20261117";
export const G9_SOURCE = "tests/g9-proof/add.mjs";
export const G9_TEST_PATH = "tests/g9-proof/add.test.mjs";
export const G9_BROKEN = "export function add(a, b) { return a - b; }\n";
export const G9_FIXED = "export function add(a, b) { return a + b; }\n";
/** Fail closed for branch-changing tools in the dedicated G9 proof session.
 * Agent may read metadata from any ref, but cannot mutate other review branches.
 */
export function assertG9BoundGitHubOperation(operation?: string, branch?: string): void {
  if(!operation)return; // Dedicated read-only tools resolve repo separately.
  if(operation === "branch") throw new Error("G9: rama ya preparada; no crear otras ramas");
  if((operation === "write" || operation === "pr") && branch !== G9_BRANCH){
    throw new Error("G9: escritura o PR fuera de la rama aislada bloqueada");
  }
}
export const G9_TEST_SOURCE = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from './add.mjs';",
  "test('G9: add(2,3) is five', () => assert.equal(add(2, 3), 5));",
  ""
].join("\n");

export type G9ProofState = {
  version: string;
  status: "starting" | "running" | "verifying" | "passed" | "failed";
  startedAt: number;
  session?: string;
  seedCommits?: string[];
  reason?: string;
  result?: G9Evidence;
};

export type G9Evidence = {
  passed: boolean;
  observedRed: boolean;
  observedGreenAfterRed: boolean;
  actualAgentWrite: boolean;
  actualAgentReview: boolean;
  actualAgentDraftPR: boolean;
  toolCalls: number;
  failedTools: number;
  prUrl?: string;
};

/** Only parse completed tool outputs; never accept success claims in prose. */
export function assessG9History(messages: readonly unknown[]): G9Evidence {
  let redAt = -1, greenAt = -1, writeAt = -1, reviewAt = -1, prAt = -1;
  let toolCalls = 0, failedTools = 0;
  let prUrl: string | undefined;
  let index = 0;
  for(const raw of messages){
    if(!raw || typeof raw !== "object" || (raw as {type?: unknown}).type !== "assistant")continue;
    const parts = (raw as {content?:unknown}).content;
    if(!Array.isArray(parts))continue;
    for(const item of parts){
      if(!item || typeof item !== "object" || (item as {type?:unknown}).type !== "tool") continue;
      const part = item as {
        name?:string; state?:{status?:string;content?:{type?:string;text?:string}[]}
      };
      const pos=index++;
      toolCalls++;
      if(part.state?.status === "error") {failedTools++;continue;}
      if(part.state?.status !== "completed")continue;
      const output=(part.state.content??[]).filter(x=>x?.type==="text")
        .map(x=>x.text??"").join("\n");
      let data: any;
      try {data=JSON.parse(output);} catch {continue;}
      if(part.name === "linux" && data.project === G9_PROJECT){
        if(data.exitCode !== 0 && typeof data.stdout === "string" &&
           data.stdout.includes("not ok") && redAt < 0)redAt=pos;
        if(data.exitCode === 0 && typeof data.stdout === "string" &&
           data.stdout.includes("ok 1 - G9: add(2,3) is five") && greenAt < 0)greenAt=pos;
      }
      if(part.name === "github" && data.repo?.toLowerCase()===G9_REPO.toLowerCase()){
        if(data.branch===G9_BRANCH && data.path===G9_SOURCE && typeof data.commitSha==="string")writeAt=pos;
        if(data.branch===G9_BRANCH && data.base==="main" &&
          Array.isArray(data.files) && !data.truncated &&
          data.files.length===2 &&
          [G9_SOURCE,G9_TEST_PATH].every(path=>data.files.some((x:any)=>x.path===path)))reviewAt=pos;
        if(data.head===G9_BRANCH && data.base==="main" && data.draft===true &&
          typeof data.url==="string" && data.url.startsWith("https://github.com/")){
          prAt=pos;prUrl=data.url;
        }
      }
      if(part.name==="repo_review" && data.repo?.toLowerCase()===G9_REPO.toLowerCase()
        && data.branch===G9_BRANCH && data.base==="main"
        && !data.truncated && Array.isArray(data.files) && data.files.length===2 &&
        [G9_SOURCE,G9_TEST_PATH].every(path=>data.files.some((x:any)=>x.path===path)))reviewAt=pos;
    }
  }
  // A successful test before a code change, or PR before review, is NOT
  // evidence of a complete engineering cycle.
  const observedRed=redAt>=0;
  const actualAgentWrite=writeAt>redAt && redAt>=0;
  const observedGreenAfterRed=greenAt>writeAt && actualAgentWrite;
  const actualAgentReview=reviewAt>greenAt && observedGreenAfterRed;
  const actualAgentDraftPR=prAt>reviewAt && actualAgentReview;
  return {passed:observedGreenAfterRed && actualAgentWrite && actualAgentReview && actualAgentDraftPR,
    observedRed,observedGreenAfterRed,actualAgentWrite,actualAgentReview,actualAgentDraftPR,
    toolCalls,failedTools,prUrl};
}

/** The agent must inspect and diagnose; the fixture and fix remain server-only. */
export function g9AgentPrompt(): string {
  return "G9: aceptación REAL de reparación autónoma con DeepSeek Workers AI. " +
    "Tu conversación tiene un repositorio GitHub autorizado (" + G9_REPO + "), la rama de prueba " +
    G9_BRANCH + " y un proyecto Linux aislado vinculado. " +
    "Existe una prueba Node fallida y dos archivos sintéticos; NO conoces la causa ni la reparación. " +
    "Primero usa la herramienta linux (SOLO campo command; el proyecto se resuelve automáticamente) " +
    "para listar archivos y ejecutar el test fallido. Lee los archivos reales y diagnostica el defecto. " +
    "Contrasta el test de GitHub en tests/g9-proof/add.test.mjs usando github action=read " +
    "con repo=" + G9_REPO + " ref=" + G9_BRANCH + ", y descubre qué fuente importa. " +
    "Lee esa fuente mediante github action=read antes de modificarla. " +
    "Corrige exclusivamente la fuente defectuosa tanto en Linux como mediante " +
    "github action=write en la rama autorizada. Nunca cambies el archivo de pruebas. " +
    "Demuestra el resultado: ejecuta linux para obtener test rojo ANTES de la escritura GitHub " +
    "y test verde DESPUÉS de escribir la reparación y sincronizar la fuente Linux. " +
    "Después revisa el diff con repo_review branch=" + G9_BRANCH +
    " y crea una PR DRAFT con github action=pr, repo=" + G9_REPO + ", branch=" +
    G9_BRANCH + ". No hagas merge ni toques main, otros proyectos, CDF o producción. " +
    "Describe los exitCode y el cambio basándote únicamente en las herramientas. " +
    "Si no puedes completar una etapa, presenta el error real y no finjas éxito.";
}

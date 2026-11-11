/**
 * G9 staging acceptance: a real agent must repair a deliberately broken,
 * non-production source file in a private review branch and prove it with Linux.
 * The server seeds the fixture; the model must perform the actual code fix.
 */
export const G9_PROOF_VERSION = "g9-selfdev-v1-20261111";
export const G9_REPO = "aamvtrampa36-del/opencode-harness-example";
export const G9_BRANCH = "opencode/g9-selfdev-20261111";
export const G9_PROJECT = "g9-selfdev-proof";
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

export function g9AgentPrompt(): string {
  return "G9: ensayo REAL de autodesarrollo con un repositorio GitHub y Linux. " +
    "Esta sesión ya está limitada a repo=" + G9_REPO + " y proyecto Linux=" + G9_PROJECT + ". " +
    "El servidor creó una rama de revisión " + G9_BRANCH + " y sembró DOS archivos: " +
    G9_SOURCE + " (bug: usa resta) y " + G9_TEST_PATH + " (test fijo; NO MODIFICAR). " +
    "El Container del proyecto " + G9_PROJECT + " contiene los dos mismos archivos bajo " +
    "sus nombres simples add.mjs/add.test.mjs y el test inicial falló. " +
    "Trabaja con estas herramientas REALES, no inventes resultados: " +
    "(1) llama a linux con project=" + G9_PROJECT +
    " y command='node --test --test-reporter=tap add.test.mjs' para OBSERVAR el fallo. " +
    "(2) usa github action=read para leer " + G9_SOURCE + " y " + G9_TEST_PATH +
    " en repo " + G9_REPO + " ref " + G9_BRANCH + ". " +
    "(3) usa github action=write para reparar SOLO " + G9_SOURCE +
    " en branch " + G9_BRANCH + ", escribiendo el código exacto export function add(a, b) { return a + b; }, con commit message 'fix(g9): correct isolated add fixture'. " +
    "(4) usa linux con project=" + G9_PROJECT +
    " y command que actualice SOLO add.mjs de forma equivalente y luego ejecute " +
    "'node --test --test-reporter=tap add.test.mjs' con exitCode 0. " +
    "(5) usa repo_review con branch " + G9_BRANCH +
    " (o github action=review), inspecciona los dos archivos añadidos respecto a main. " +
    "(6) usa github action=pr para crear PR DRAFT, título 'test(g9): agent fixes isolated red-to-green fixture' " +
    "y cuerpo con evidencias reales. Nunca merge, cambiar main, configurar credenciales, crear producción, " +
    "ni tocar otros archivos, ramas o proyectos. Si una herramienta falla, indícalo y detente, no finjas éxito.";
}

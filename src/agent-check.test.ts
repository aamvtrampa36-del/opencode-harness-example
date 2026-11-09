import { describe, expect, test } from "bun:test";
import { assessAgentToolEvidence, hasUnfinishedAgentCheck, isAgentCheckModel, explainAgentCheckFailure, isAgentCheckKind, repairSeedCommand, repairIsVerified, REPAIR_SOURCE_BROKEN, REPAIR_TEST } from "./agent-check";

const project = "agent-check-123";
const token = "abcdef1234";
function tool(content: string, status = "completed", name = "linux") {
  return { type: "assistant", content: [
    { type: "tool", name, state: { status, content: [{ type: "text", text: content }] } }
  ] };
}
describe("OpenCode end-to-end tool proof", () => {
  test("model prose is not sufficient", () => {
    const result = assessAgentToolEvidence([{ type: "assistant", content: [
      { type: "text", text: "I ran Linux and it passed" }
    ] }], project, token);
    expect(result.correctLinuxResult).toBe(false);
    expect(result.requestedTools).toBe(0);
  });
  test("real matching tool content and exit code is evidence", () => {
    const result = assessAgentToolEvidence([
      tool(JSON.stringify({project,exitCode:0,stdout:"AGENT_PROOF_OK:"+token}))
    ],project,token);
    expect(result.correctLinuxResult).toBe(true);
    expect(result.finishedLinuxTools).toBe(1);
  });
  test("unmatched project, token, exit code and errors fail", () => {
    const variants = [
      {project:"wrong",exitCode:0,stdout:"AGENT_PROOF_OK:"+token},
      {project,exitCode:1,stdout:"AGENT_PROOF_OK:"+token},
      {project,exitCode:0,stdout:"unverified"}
    ];
    for(const output of variants)
      expect(assessAgentToolEvidence([tool(JSON.stringify(output))],project,token).correctLinuxResult).toBe(false);
    expect(assessAgentToolEvidence([tool("error", "error")],project,token).correctLinuxResult).toBe(false);
    expect(assessAgentToolEvidence([tool("garbage")],project,token).correctLinuxResult).toBe(false);
  });
});

describe("Agent verification repeat policy", () => {
  test("an active check is reused to avoid duplicate inference", () => {
    expect(hasUnfinishedAgentCheck({ error: undefined }, null)).toBe(true);
    expect(hasUnfinishedAgentCheck({ error: undefined }, undefined)).toBe(true);
  });
  test("a completed or failed check can be attempted again", () => {
    expect(hasUnfinishedAgentCheck({ error: undefined }, { status: "passed" })).toBe(false);
    expect(hasUnfinishedAgentCheck({ error: undefined }, { status: "failed" })).toBe(false);
    expect(hasUnfinishedAgentCheck({ error: "Provider unavailable" }, null)).toBe(false);
    expect(hasUnfinishedAgentCheck(null, null)).toBe(false);
  });
});


describe("Diagnostic model selection and evidence explanations", () => {
  test("offers only the baseline and economical provider models", () => {
    expect(isAgentCheckModel("cloudflare")).toBe(true);
    expect(isAgentCheckModel("economy")).toBe(true);
    expect(isAgentCheckModel("review")).toBe(true);
    expect(isAgentCheckModel("reasoning")).toBe(false);
    expect(isAgentCheckModel("creative")).toBe(false);
    expect(isAgentCheckModel("../secret")).toBe(false);
  });
  test("distinguishes provider/tool/non-persistent failures", () => {
    expect(explainAgentCheckFailure({requestedTools:0,finishedLinuxTools:0,correctLinuxResult:false})).toContain("no solicitó herramientas");
    expect(explainAgentCheckFailure({requestedTools:2,finishedLinuxTools:0,correctLinuxResult:false})).toContain("ninguna ejecución Linux");
    expect(explainAgentCheckFailure({requestedTools:2,finishedLinuxTools:1,correctLinuxResult:false})).toContain("faltó la salida");
    expect(explainAgentCheckFailure({requestedTools:2,finishedLinuxTools:1,correctLinuxResult:true})).toContain("archivo persistido");
  });
});


describe("Isolated autonomous code-repair rehearsal", () => {
  test("only expected proof modes are supported", () => {
    expect(isAgentCheckKind("linux")).toBe(true);
    expect(isAgentCheckKind("repair")).toBe(true);
    expect(isAgentCheckKind("shell-arbitrary")).toBe(false);
  });
  test("seeded code is wrong and the seed runs a failing Node test", () => {
    expect(REPAIR_SOURCE_BROKEN).toContain("a - b");
    expect(REPAIR_TEST).toContain("assert.equal(add(2, 3), 5)");
    expect(repairSeedCommand()).toContain("node --test calc.test.mjs");
  });
  test("an AI claim alone, a weakened test, or unchanged code cannot pass", () => {
    expect(repairIsVerified(REPAIR_SOURCE_BROKEN, REPAIR_TEST, 0)).toBe(false);
    expect(repairIsVerified("export const add=(a,b)=>a+b;\\n", "modified test", 0)).toBe(false);
    expect(repairIsVerified("export const add=(a,b)=>a+b;\\n", REPAIR_TEST, 1)).toBe(false);
    expect(repairIsVerified("export const add=(a,b)=>a+b;\\n", REPAIR_TEST, 0)).toBe(true);
  });
});

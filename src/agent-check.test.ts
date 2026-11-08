import { describe, expect, test } from "bun:test";
import { assessAgentToolEvidence } from "./agent-check";

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

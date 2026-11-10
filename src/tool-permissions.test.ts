import { describe, expect, test } from "bun:test";
import { assertAgentToolPermission } from "./tool-permissions";

describe("native OpenCode tool execution permissions", () => {
  test("plan and review cannot run arbitrary shell", () => {
    expect(() => assertAgentToolPermission("plan", "linux")).toThrow("no pueden ejecutar");
    expect(() => assertAgentToolPermission("build", "linux")).not.toThrow();
  });
  test("plan cannot mutate GitHub, but can inspect repositories", () => {
    for (const action of ["branch", "write", "pr", "delete"]) {
      expect(() => assertAgentToolPermission("plan", "github", { action })).toThrow();
    }
    for (const action of ["repo", "read", "review"]) {
      expect(() => assertAgentToolPermission("plan", "github", { action })).not.toThrow();
    }
  });
  test("plan allows read-only workspace operations, not edit or exec", () => {
    for (const tool of ["read", "glob", "grep", "ls", "find", "stat"]) {
      expect(() => assertAgentToolPermission("plan", "workspace", { tool })).not.toThrow();
    }
    for (const tool of ["write", "edit", "exec", "patch", "shell"]) {
      expect(() => assertAgentToolPermission("plan", "workspace", { tool })).toThrow();
    }
  });
  test("development can use its full authorized tools", () => {
    expect(() => assertAgentToolPermission("build", "github", { action: "write" })).not.toThrow();
    expect(() => assertAgentToolPermission("build", "workspace", { tool: "exec" })).not.toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { MAX_SHELL_OUTPUT, validateCommand, validateProject } from "./dev-guard";

describe("isolated Linux project guardrails", () => {
  test("only short rootless project slugs are valid", () => {
    expect(validateProject("primera-app")).toBe("primera-app");
    for (const bad of ["", "UPPERCASE", "../cdf-cloud", "a/b", "-start", "a".repeat(41), ".", "ab cd"]) {
      expect(() => validateProject(bad)).toThrow();
    }
  });
  test("reject missing or oversized Linux commands", () => {
    expect(validateCommand("npm test")).toBe("npm test");
    expect(() => validateCommand("")).toThrow();
    expect(() => validateCommand(" ".repeat(10))).toThrow();
    expect(() => validateCommand("x".repeat(12_001))).toThrow();
  });
  test("logs are capped to prevent excessive session output", () => {
    expect(MAX_SHELL_OUTPUT).toBeLessThanOrEqual(32_768);
  });
});

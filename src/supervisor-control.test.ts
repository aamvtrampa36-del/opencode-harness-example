import { describe, expect, test } from "bun:test";
import {
  SUPERVISOR_WORKSPACE, assertSupervisorBoundGitHubOperation,
  supervisorBearerAllowed, supervisorBranch, supervisorFingerprint,
  supervisorProject, supervisorPrompt, supervisorResponse,
  supervisorTaskKey, validateSupervisorStart
} from "./supervisor-control";

const repos = ["aamvtrampa36-del/opencode-harness-example",
  "aamvtrampa36-del/cdf-cloud-engine"];
const input = {
  requestId: "a1234567890bcdef",
  repository: repos[0],
  prompt: "Corregir una prueba real del repositorio, sin tocar main"
};

describe("OpenCode remote supervisor — fail closed", () => {
  test("requires owner-approved repository, immutable task ID and bounded prompt", () => {
    expect(validateSupervisorStart(input, repos)).toEqual(input);
    expect(() => validateSupervisorStart({ ...input, repository: "aamvtrampa36-del/not-approved" }, repos)).toThrow("no autorizado");
    expect(() => validateSupervisorStart({ ...input, requestId: "../bad" }, repos)).toThrow("requestId");
    expect(() => validateSupervisorStart({ ...input, prompt: "too short" }, repos)).toThrow("Tarea");
    expect(() => validateSupervisorStart({ ...input, prompt: "a".repeat(5001) }, repos)).toThrow("Tarea");
    expect(() => validateSupervisorStart({ ...input, production: true }, repos)).toThrow("desconocidos");
    expect(() => validateSupervisorStart(null, repos)).toThrow();
    expect(() => validateSupervisorStart(input, [])).toThrow("no autorizado");
  });

  test("binds task to exactly one project and review branch", () => {
    expect(SUPERVISOR_WORKSPACE).toBe("opencode-supervisor-v1");
    expect(supervisorTaskKey(input.requestId)).toBe("supervisor:task:" + input.requestId);
    expect(supervisorProject(input.requestId)).toBe("supervised-" + input.requestId);
    const branch = supervisorBranch(input.requestId);
    expect(branch).toBe("opencode/supervised-a1234567890bcdef");
    expect(supervisorBranch(input.requestId, repos[0])).toBe("opencode/staging-a1234567890bcdef");
    expect(supervisorBranch(input.requestId, repos[1])).toBe(branch);
    expect(supervisorPrompt(input, supervisorBranch(input.requestId, repos[0]), supervisorProject(input.requestId))).toContain("NO main");
    expect(() => supervisorTaskKey("bad")).toThrow();
    for (const operation of ["write", "pr", "review"]) {
      expect(() => assertSupervisorBoundGitHubOperation(operation, branch, branch)).not.toThrow();
      expect(() => assertSupervisorBoundGitHubOperation(operation, "main", branch)).toThrow("bloqueada");
      expect(() => assertSupervisorBoundGitHubOperation(operation, "opencode/other", branch)).toThrow("bloqueada");
    }
    expect(() => assertSupervisorBoundGitHubOperation("branch", branch, branch)).toThrow("precreada");
    expect(() => assertSupervisorBoundGitHubOperation("read", undefined, branch)).not.toThrow();
  });

  test("denies absent/malformed/short/wrong bearer; accepts only exact secret", async () => {
    const secret = "supervisor-test-0123456789abcdefghijklmnopqrstuvwxyz";
    expect(await supervisorBearerAllowed("Bearer " + secret, secret)).toBe(true);
    for (const header of [null, "", secret, "Basic " + secret,
      "Bearer wrongwrongwrongwrongwrongwrongwrongwrongwrong",
      "Bearer " + secret + "x"]) {
      expect(await supervisorBearerAllowed(header, secret)).toBe(false);
    }
    expect(await supervisorBearerAllowed("Bearer abc", "abc")).toBe(false);
  });

  test("idempotency fingerprint binds repo and instruction; prompt limits privileges", async () => {
    const current = await supervisorFingerprint(input);
    expect(current).toMatch(/^[a-f0-9]{64}$/);
    expect(await supervisorFingerprint(input)).toBe(current);
    expect(await supervisorFingerprint({ ...input, repository: repos[1] })).not.toBe(current);
    expect(await supervisorFingerprint({ ...input, prompt: input.prompt + " modificado" })).not.toBe(current);
    const p = supervisorPrompt(input, supervisorBranch(input.requestId), supervisorProject(input.requestId));
    expect(p).toContain(repos[0]);
    expect(p).toContain("opencode/supervised-");
    expect(p).toContain("PR borrador");
    expect(p).toContain("Prohibido fusionar");
  });

  test("response has no-cache and privacy headers", () => {
    const result = supervisorResponse({ result: "ok" });
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

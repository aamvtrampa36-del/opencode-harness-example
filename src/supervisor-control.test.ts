import { describe, expect, test } from "bun:test";
import {
  classifySupervisorOperation,
  SUPERVISOR_WORKSPACE, assertSupervisorBoundGitHubOperation,
  supervisorBaseCommit, supervisorBearerAllowed, supervisorBranch, supervisorFingerprint,
  supervisorProject, supervisorPrompt, supervisorResponse, supervisorTaskStatusReceipt,
  supervisorTaskKey, supervisorStartOperationId, supervisorTurnOperationId, validateSupervisorStart,
  type SupervisorTask
} from "./supervisor-control";

const repos = ["aamvtrampa36-del/opencode-harness-example",
  "aamvtrampa36-del/cdf-cloud-engine"];
const input = {
  requestId: "a1234567890bcdef",
  repository: repos[0],
  prompt: "Corregir una prueba real del repositorio, sin tocar main"
};

describe("OpenCode remote supervisor — fail closed", () => {
  test("status receipt reflects an error cleared after the operation finishes", () => {
    const task: SupervisorTask = {
      id: input.requestId,
      repository: input.repository,
      project: supervisorProject(input.requestId),
      branch: supervisorBranch(input.requestId, input.repository),
      fingerprint: "fingerprint",
      createdAt: 1,
      status: "unknown",
      error: "No se pudo confirmar el envío"
    };
    const completed = { ...task, status: "finished" as const, error: undefined };
    const receipt = supervisorTaskStatusReceipt(completed);
    expect(receipt).toMatchObject({ status: "finished" });
    expect(receipt.error).toBeUndefined();
  });

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

  test("accepts only catalog model selections and an exact OpenCode source session", () => {
    expect(validateSupervisorStart({ ...input, model: "review", sourceSession: "sesAbc123" }, repos))
      .toMatchObject({ model: "review", sourceSession: "sesAbc123" });
    expect(() => validateSupervisorStart({ ...input, model: "openrouter:google/gemini-3.8-flash" }, repos))
      .not.toThrow();
    expect(() => validateSupervisorStart({ ...input, model: "unregistered/model" }, repos)).toThrow("catálogo");
    expect(() => validateSupervisorStart({ ...input, sourceSession: "../ses" }, repos)).toThrow("sesión de origen");
  });

  test("binds task to exactly one project and review branch", () => {
    expect(SUPERVISOR_WORKSPACE).toBe("opencode-supervisor-v1");
    expect(supervisorTaskKey(input.requestId)).toBe("supervisor:task:" + input.requestId);
    expect(supervisorProject(input.requestId)).toBe("supervised-" + input.requestId);
    const branch = supervisorBranch(input.requestId);
    expect(branch).toBe("opencode/supervised-a1234567890bcdef");
    expect(supervisorBranch(input.requestId, repos[0])).toBe("opencode/staging-a1234567890bcdef");
    expect(supervisorBranch(input.requestId, "aamvtrampa36-del/OpenCode-Harness-Example"))
      .toBe("opencode/staging-a1234567890bcdef");
    expect(supervisorBranch(input.requestId, repos[1])).toBe(branch);
    const base = "7d1669cba0f3c8ee08626425aaf551c8d5bd4bf7";
    const stagingPrompt = supervisorPrompt(
      input, supervisorBranch(input.requestId, repos[0]), supervisorProject(input.requestId), base
    );
    expect(stagingPrompt).toContain("No leas ni presentes main como Staging");
    expect(stagingPrompt).toContain("staging/opencode-g1-20261118");
    expect(stagingPrompt).toContain(base);
    expect(stagingPrompt).toContain("no contiene .git");
    expect(stagingPrompt).not.toContain("usa git fetch");
    expect(supervisorBaseCommit({source:"staging/opencode-g1-20261118",sha:base}, repos[0])).toBe(base);
    expect(() => supervisorBaseCommit({source:"main",sha:base}, repos[0])).toThrow("partir de Staging");
    expect(() => supervisorBaseCommit({source:"main",sha:"bad"}, repos[1])).toThrow("SHA de base");
    expect(stagingPrompt).not.toContain("staging-supervisor-control-20261111");
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
    expect(await supervisorFingerprint({ ...input, model: "review" })).not.toBe(current);
    expect(await supervisorFingerprint({ ...input, sourceSession: "sesAbc123" })).not.toBe(current);
    expect(supervisorStartOperationId(input.requestId)).toBe("rc-start-" + input.requestId);
    expect(supervisorTurnOperationId(input.requestId, "b1234567890cdefa"))
      .toBe("rc-turn-" + input.requestId + "-b1234567890cdefa");
    expect(() => supervisorTurnOperationId(input.requestId, "bad")).toThrow("turno");
    const p = supervisorPrompt(input, supervisorBranch(input.requestId), supervisorProject(input.requestId),
      "a".repeat(40));
    expect(p).toContain(repos[0]);
    expect(p).toContain("opencode/supervised-");
    expect(p).toContain("PR borrador");
    expect(p).toContain("Prohibido fusionar");
  });

  test("reports cancellation only after OpenCode confirms interruption", () => {
    expect(classifySupervisorOperation("cancel_requested", false,
      { status: "unanswered", reason: "interrupted" })).toBe("cancelled");
    expect(classifySupervisorOperation("running", false,
      { status: "unanswered", reason: "interrupted" })).toBe("unanswered");
    expect(classifySupervisorOperation("cancel_requested", true)).toBe("cancel_requested");
    expect(classifySupervisorOperation("running", true)).toBe("running");
    expect(classifySupervisorOperation("running", false, { status: "done" })).toBe("finished");
    expect(classifySupervisorOperation("running", false,
      { status: "unanswered", reason: "failed" })).toBe("failed");
    expect(classifySupervisorOperation("running", false,
      { status: "unanswered", reason: "not_found" })).toBe("unknown");
  });

  test("response has no-cache and privacy headers", () => {
    const result = supervisorResponse({ result: "ok" });
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

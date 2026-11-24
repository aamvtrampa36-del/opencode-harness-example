import { describe, expect, test } from "bun:test";
import { projectContainerName, repositoryProjectSlug, validateIsolatedRegistration, isSupervisorProjectName, assertGeneralProjectName } from "./project-container";

describe("project Container identities", () => {
  test("supervisor project names require the task-scoped route", () => {
    const name = "supervised-0123456789abcdef";
    expect(isSupervisorProjectName(name)).toBe(true);
    expect(() => assertGeneralProjectName(name)).toThrow("SUPERVISOR_PROJECT_REQUIRES_TASK_ROUTE");
    for (const other of ["repo-example","supervised-not-a-task","project-a"]) {
      expect(isSupervisorProjectName(other)).toBe(false);
      expect(() => assertGeneralProjectName(other)).not.toThrow();
    }
  });
  test("maps distinct projects to distinct named instances", () => {
    expect(projectContainerName("project-a")).not.toBe(projectContainerName("project-b"));
    expect(() => projectContainerName("../personal")).toThrow();
  });
  test("new repository projects never reuse the old shared name", () => {
    expect(repositoryProjectSlug("aamvtrampa36-del/CDF-WorkBench-")).toBe("repo-cdf-workbench");
    expect(() => repositoryProjectSlug("other/secret")).toThrow();
  });
  test("never shadows a legacy project or rebinds a registered repository", () => {
    expect(() => validateIsolatedRegistration([{name:"old-project"}], undefined,
      {project:"old-project"})).toThrow("anterior");
    const existing = {project:"project-a",repository:"owner/one"};
    expect(() => validateIsolatedRegistration([], existing,
      {project:"project-a",repository:"owner/two"})).toThrow("otro");
    expect(validateIsolatedRegistration([], existing,
      {project:"project-a",repository:"OWNER/ONE"}).project).toBe("project-a");
    expect(validateIsolatedRegistration([], existing,
      {project:"project-a"})).toEqual(existing);
  });
});

import { describe, expect, test } from "bun:test";
import { projectContainerName, validateIsolatedRegistration } from "./project-container";

describe("project Container identities", () => {
  test("maps distinct projects to distinct named instances", () => {
    expect(projectContainerName("project-a")).not.toBe(projectContainerName("project-b"));
    expect(() => projectContainerName("../personal")).toThrow();
  });
  test("never shadows a legacy project or rebinds a registered repository", () => {
    expect(() => validateIsolatedRegistration([{name:"old-project"}], undefined,
      {project:"old-project"})).toThrow("anterior");
    expect(() => validateIsolatedRegistration([], {project:"project-a",repository:"owner/one"},
      {project:"project-a",repository:"owner/two"})).toThrow("otro");
    expect(validateIsolatedRegistration([], {project:"project-a",repository:"owner/one"},
      {project:"project-a",repository:"OWNER/ONE"}).project).toBe("project-a");
  });
});

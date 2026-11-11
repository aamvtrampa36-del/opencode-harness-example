import { describe, expect, test } from "bun:test";
import { repositoryImportScope } from "./repository-import-scope";

const authorized = ["aamvtrampa36-del/cdf-cloud-engine", "aamvtrampa36-del/CDF-WorkBench-"];

describe("repository import session scope", () => {
  test("binds an authorized repository to its deterministic isolated project", () => {
    expect(repositoryImportScope(authorized[0], authorized)).toEqual({
      project: "repo-cdf-cloud-engine",
      repository: authorized[0],
    });
    expect(repositoryImportScope(authorized[1], authorized)).toEqual({
      project: "repo-cdf-workbench",
      repository: authorized[1],
    });
  });

  test("fails closed for missing or unauthorized repository selections", () => {
    expect(() => repositoryImportScope(undefined, authorized)).toThrow();
    expect(() => repositoryImportScope("someone/private", authorized)).toThrow("no está autorizado");
  });
});

import { describe, expect, test } from "bun:test";
import { assertScopedTool, requireSameScope, scopeStorageKey, validateProjectScope } from "./project-scope";
const repos = ["aamvtrampa36-del/cdf-cloud-engine","aamvtrampa36-del/CDF-WorkBench-"];
describe("G8 project isolation", () => {
  test("binds separate canonical repos to explicit projects", () => {
    const a=validateProjectScope({project:"cdf-cloud",repository:repos[0]},repos);
    const b=validateProjectScope({project:"cdf-workbench",repository:repos[1]},repos);
    expect(a.repository).toBe(repos[0]);
    expect(b.repository).toBe(repos[1]);
    expect(scopeStorageKey("ses_root")).toBe("g8-scope:ses_root");
    expect(()=>scopeStorageKey("../secret")).toThrow();
  });
  test("fail closed for unauthorized repo, malformed project and absent binding", () => {
    expect(()=>validateProjectScope({project:"a",repository:"other/secret"},repos)).toThrow();
    expect(()=>validateProjectScope({project:"../../other"},repos)).toThrow();
    expect(()=>assertScopedTool(undefined,{kind:"github",repo:repos[0]})).toThrow();
    expect(()=>assertScopedTool(undefined,{kind:"linux",project:"cdf-cloud"})).toThrow();
  });
  test("blocks cross-repository writes and cross-project Linux even if an agent requests them", () => {
    const a=validateProjectScope({project:"cdf-cloud",repository:repos[0]},repos);
    expect(()=>assertScopedTool(a,{kind:"github",repo:repos[1]})).toThrow("bloqueado");
    expect(()=>assertScopedTool(a,{kind:"linux",project:"cdf-workbench"})).toThrow("bloqueada");
    expect(()=>assertScopedTool(a,{kind:"workspace-write"})).toThrow("desactivada");
    expect(()=>assertScopedTool(a,{kind:"github",repo:repos[0]})).not.toThrow();
    expect(()=>assertScopedTool(a,{kind:"linux",project:"cdf-cloud"})).not.toThrow();
  });
  test("keeps the shared Workspace available only to conversations without a project", () => {
    const a=validateProjectScope({project:"cdf-cloud",repository:repos[0]},repos);
    expect(()=>assertScopedTool(undefined,{kind:"workspace-write"})).not.toThrow();
    expect(()=>assertScopedTool(a,{kind:"workspace-write"})).toThrow("desactivada");
  });
  test("cannot silently change the scoped project of a session", () => {
    const a=validateProjectScope({project:"cdf-cloud",repository:repos[0]},repos);
    expect(requireSameScope(a,{...a})).toEqual(a);
    expect(()=>requireSameScope(a,{project:"cdf-workbench",repository:repos[1]})).toThrow("conversación nueva");
    expect(requireSameScope(undefined,a)).toEqual(a);
  });
});

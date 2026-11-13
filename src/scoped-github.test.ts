import { describe, expect, test } from "bun:test";
import { executeBoundRepositoryAction } from "./scoped-github";
import { assertScopedTool, type ProjectScope } from "./project-scope";
import type { GitHubAction } from "./github";

const repo = "aamvtrampa36-del/cdf-cloud-engine";
const other = "aamvtrampa36-del/CDF-WorkBench-";
const scope: ProjectScope = { project: "cdf-cloud-engine", repository: repo };

describe("G8 trusted session-bound GitHub read tools", () => {
  test("Review agent reads a diff using server-bound repository with no model-supplied repo", async () => {
    const requests: GitHubAction[] = [];
    const result = await executeBoundRepositoryAction(
      "ses_test", "plan", { action: "review", branch: "opencode/g8-cdf-isolation-20261110" },
      async session => {
        expect(session).toBe("ses_test");
        return scope.repository!;
      },
      async (_session, selectedRepo) => { assertScopedTool(scope, { kind: "github", repo: selectedRepo }); },
      async action => {
        requests.push(action);
        return { repo: action.repo, changedFiles: ["docs/opencode-g8/isolated-review-20261110.md"] };
      }
    );
    expect(requests).toEqual([{ action: "review", repo, branch: "opencode/g8-cdf-isolation-20261110" }]);
    expect(result).toMatchObject({ repo });
  });

  test("Review mode permits repo metadata and text-file read; does not invoke Linux", async () => {
    const requests: GitHubAction[] = [];
    const execute = async (action:GitHubAction) => {requests.push(action);return {ok:true};};
    const get = async () => repo;
    const guard = async (_session:string, selected:string) => {assertScopedTool(scope,{kind:"github",repo:selected});};
    await executeBoundRepositoryAction("ses_test","plan",{action:"repo"},get,guard,execute);
    await executeBoundRepositoryAction("ses_test","plan",
      {action:"read",path:"README.md",ref:"main"},get,guard,execute);
    expect(requests.map(x=>x.action)).toEqual(["repo","read"]);
  });

  test("missing or malicious bindings never trigger GitHub", async () => {
    let called=0;
    const execute=async (_action:GitHubAction) => {called++;return {};};
    await expect(executeBoundRepositoryAction("ses_test","plan",{action:"repo"},
      async()=>"",async()=>undefined,execute)).rejects.toThrow("No hay repositorio");
    await expect(executeBoundRepositoryAction("ses_test","plan",{action:"review",branch:"opencode/review"},
      async()=>other,async(_session,selected)=>{assertScopedTool(scope,{kind:"github",repo:selected});},execute))
      .rejects.toThrow("bloqueado");
    expect(called).toBe(0);
  });
});

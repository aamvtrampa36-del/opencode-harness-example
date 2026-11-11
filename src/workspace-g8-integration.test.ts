import { describe, expect, test } from "bun:test";
import type { Workspace } from "@cloudflare/computer";
import type { GitHubAction } from "./github";
import { workspacePlugin } from "./workspace";
import type { ScopedToolAction } from "./project-scope";
import { assertScopedTool } from "./project-scope";

/**
 * G8: test the real workspacePlugin registration, not just the helper.
 * No model calls, no network and no writes are needed for this regression test.
 */
describe("G8 Review tool registration through the actual OpenCode plugin", () => {
  test("repo_review is exposed as a named read-only tool and executes against the bound repo", async () => {
    const repo = "aamvtrampa36-del/cdf-cloud-engine";
    const toolSpecs = new Map<string, any>();
    const invoked: GitHubAction[] = [];
    let guards = 0;
    const plugin = workspacePlugin(
      {} as Workspace,
      {},
      undefined,
      { execute: async (action) => {
        invoked.push(action);
        return { repo: action.repo, branch: action.action === "review" ? action.branch : undefined,
          base: "main", files: [{path:"docs/opencode-g8/isolated-review-20261110.md",status:"added"}] };
      }},
      async (session, action: ScopedToolAction) => {
        expect(session).toBe("ses_test");
        expect(action).toEqual({kind:"github",repo});
        guards++;
      },
      async (session) => {
        expect(session).toBe("ses_test");
        return repo;
      }
    );
    const agentEditor = { update: () => undefined };
    const toolEditor = {
      remove: () => undefined,
      add: (spec: any) => { toolSpecs.set(spec.name, spec); }
    };
    await plugin.setup({
      agent: { transform: async (fn: (ed: typeof agentEditor) => unknown) => fn(agentEditor) },
      tool: { transform: async (fn: (ed: typeof toolEditor) => unknown) => fn(toolEditor) }
    } as any);
    for(const name of ["repo_review", "repo_info", "repo_read"]) {
      expect(toolSpecs.has(name)).toBe(true);
      expect(toolSpecs.get(name).options).toMatchObject({codemode:false});
    }
    const result = await toolSpecs.get("repo_review").execute(
      {branch:"opencode/g8-cdf-isolation-20261110"},
      {sessionID:"ses_test", agent:"plan"}
    );
    expect(JSON.parse(result.content)).toMatchObject({
      repo, branch:"opencode/g8-cdf-isolation-20261110",base:"main"
    });
    expect(invoked).toEqual([{action:"review", repo, branch:"opencode/g8-cdf-isolation-20261110"}]);
    expect(guards).toBe(1);
  });
  test("plan/review tool cannot write or operate without a trusted repository", async () => {
    const toolSpecs = new Map<string, any>();
    let requests = 0;
    const plugin = workspacePlugin(
      {} as Workspace, {}, undefined,
      { execute: async () => { requests++; return {}; } },
      async () => undefined,
      async () => { throw new Error("No repository bound"); }
    );
    await plugin.setup({
      agent: {transform: async () => undefined},
      tool: {transform: async (cb: (ed:any)=>unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name,spec)
      })}
    } as any);
    await expect(toolSpecs.get("repo_review").execute(
      { branch:"opencode/g8-review" },{sessionID:"ses_unknown",agent:"plan"}
    )).rejects.toThrow("No repository bound");
    await expect(toolSpecs.get("github").execute(
      {action:"write",repo:"aamvtrampa36-del/cdf-cloud-engine",
       branch:"opencode/g8-review",path:"docs/x.md",content:"change"},
      {sessionID:"ses_unknown",agent:"plan"}
    )).rejects.toThrow("Planificación y Revisión");
    expect(requests).toBe(0);
  });

  test("routes Linux to the trusted session and rejects another project's slug", async () => {
    const toolSpecs = new Map<string, any>();
    const runs: Array<{project: string; session?: string}> = [];
    const plugin = workspacePlugin(
      {} as Workspace, {},
      {
        inspect: async () => ({}),
        run: async (project: string, _command: string, session?: string) => {
          runs.push({project, session});
          return {project, exitCode: 0, stdout: "", stderr: "", truncated: false, persistence: "test"};
        }
      },
      undefined,
      async (_session, action) => assertScopedTool({project:"cdf-cloud-engine"}, action)
    );
    await plugin.setup({
      agent: {transform: async () => undefined},
      tool: {transform: async (cb: (ed:any)=>unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name,spec)
      })}
    } as any);
    const allowed = await toolSpecs.get("linux").execute(
      {project:"cdf-cloud-engine",command:"pwd"},
      {sessionID:"ses_test",agent:"build"}
    );
    expect(JSON.parse(allowed.content).exitCode).toBe(0);
    await expect(toolSpecs.get("linux").execute(
      {project:"cdf-workbench",command:"pwd"},
      {sessionID:"ses_test",agent:"build"}
    )).rejects.toThrow("proyecto distinto");
    expect(runs).toEqual([{project:"cdf-cloud-engine",session:"ses_test"}]);
  });

  test("project sessions cannot read the shared global workspace", async () => {
    const toolSpecs = new Map<string, any>();
    const plugin = workspacePlugin({} as Workspace, {}, undefined, undefined,
      async (_session, action) => assertScopedTool({project:"cdf-cloud-engine"}, action));
    await plugin.setup({
      agent: {transform: async () => undefined},
      tool: {transform: async (cb: (ed:any)=>unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name,spec)
      })}
    } as any);
    expect(toolSpecs.has("read")).toBe(true);
    await expect(toolSpecs.get("read").execute(
      {path:"/other-project/secret.txt"}, {id:"test-read",sessionID:"ses_test",agent:"plan"}
    )).rejects.toThrow("workspace");
    for (const name of ["ls", "find", "grep", "glob", "stat"]) {
      if (!toolSpecs.has(name)) continue;
      await expect(toolSpecs.get(name).execute(
        {}, {id:"test-" + name,sessionID:"ses_test",agent:"plan"}
      )).rejects.toThrow("workspace");
    }
  });
});

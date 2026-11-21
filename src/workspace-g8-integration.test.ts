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
  test("tells the agent that an internal file path is not a user download", async () => {
    const systems = new Map<string, string>();
    const plugin = workspacePlugin({} as Workspace);
    await plugin.setup({
      agent: { transform: async (callback: (editor: any) => unknown) => callback({
        update: (name: string, update: (agent: any) => void) => {
          const agent: any = {};
          update(agent);
          systems.set(name, agent.system);
        }
      }) },
      tool: { transform: async (callback: (editor: any) => unknown) => callback({
        remove: () => undefined, add: () => undefined
      }) }
    } as any);

    expect(systems.get("build")).toContain("A path returned by a remote tool");
    expect(systems.get("build")).toContain("not a user download");
    expect(systems.get("plan")).toContain("not a user download");
  });

  test("GitHub tool exposes and forwards bounded exact replacement inputs", async () => {
    const toolSpecs = new Map<string, any>();
    const repo = "aamvtrampa36-del/opencode-harness-example";
    const received: GitHubAction[] = [];
    const plugin = workspacePlugin({} as Workspace, {}, undefined, {
      execute: async (action) => { received.push(action); return { mode: "replacement" }; }
    });
    await plugin.setup({
      agent: { transform: async () => undefined },
      tool: { transform: async (cb: (editor: any) => unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name, spec)
      }) }
    } as any);

    const github = toolSpecs.get("github");
    expect(github.input.additionalProperties).toBe(false);
    for (const field of ["expectedHead", "oldText", "newText"]) {
      expect(github.input.properties).toHaveProperty(field);
    }
    const input = {
      action: "write", repo, path: "src/server.ts", branch: "opencode/staging-a1234567890bcdef",
      expectedHead: "a".repeat(40), oldText: "const old = true;", newText: "const old = false;"
    };
    const result = await github.execute(input, { sessionID: "ses_test", agent: "build" });
    expect(received).toEqual([input]);
    expect(JSON.parse(result.content)).toEqual({ mode: "replacement" });
  });

  test("subagents default to the inherited model and identify explicit decision delegation", async () => {
    const toolSpecs = new Map<string, any>();
    const kinds: string[] = [];
    const plugin = workspacePlugin({} as Workspace, {}, undefined, undefined,
      undefined, undefined, undefined, undefined, {
        isChild: async () => false,
        start: async (_session, task, kind) => {
          expect(task).toBeTruthy();
          kinds.push(kind);
          return { session: "ses_child" };
        },
        result: async () => ({ status: "finished", text: "hallazgos" })
      });
    await plugin.setup({
      agent: { transform: async () => undefined },
      tool: { transform: async (cb: (editor: any) => unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name, spec)
      }) }
    } as any);

    await toolSpecs.get("start_subagent").execute({ task: "Leer documentación" },
      { sessionID: "ses_parent", agent: "build" });
    await toolSpecs.get("start_subagent").execute({ task: "Comparar dos opciones", kind: "decision" },
      { sessionID: "ses_parent", agent: "build" });
    const result = await toolSpecs.get("subagent_result").execute({ session: "ses_child" },
      { sessionID: "ses_parent", agent: "build" });

    expect(kinds).toEqual(["analysis", "decision"]);
    expect(JSON.parse(result.content)).toEqual({ status: "finished", text: "hallazgos" });
  });

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
    const inspections: Array<{project: string; session?: string}> = [];
    const plugin = workspacePlugin(
      {} as Workspace, {},
      {
        inspect: async (project: string, _action: string, _path: string, session?: string) => {
          inspections.push({project, session});
          return {};
        },
        run: async (project: string, _command: string, session?: string) => {
          runs.push({project, session});
          return {project, exitCode: 0, stdout: "", stderr: "", truncated: false, persistence: "test"};
        }
      },
      undefined,
      async (_session, action) => assertScopedTool({project:"cdf-cloud-engine"}, action),
      undefined,
      async () => "cdf-cloud-engine"
    );
    await plugin.setup({
      agent: {transform: async () => undefined},
      tool: {transform: async (cb: (ed:any)=>unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name,spec)
      })}
    } as any);
    expect(toolSpecs.get("linux").input.properties).not.toHaveProperty("project");
    expect(toolSpecs.get("inspect_linux").input.properties).not.toHaveProperty("project");
    expect(toolSpecs.get("linux").description).toContain("use relative paths");
    expect(toolSpecs.get("linux").description).toContain("never /bundle");
    const allowed = await toolSpecs.get("linux").execute(
      {command:"pwd"},
      {sessionID:"ses_test",agent:"build"}
    );
    expect(JSON.parse(allowed.content).exitCode).toBe(0);
    await toolSpecs.get("inspect_linux").execute(
      {action:"list",path:""}, {sessionID:"ses_test",agent:"plan"}
    );
    await expect(toolSpecs.get("linux").execute(
      {project:"cdf-workbench",command:"pwd"},
      {sessionID:"ses_test",agent:"build"}
    )).rejects.toThrow("Proyecto diferente al autorizado en esta sesión");
    expect(runs).toEqual([{project:"cdf-cloud-engine",session:"ses_test"}]);
    expect(inspections).toEqual([{project:"cdf-cloud-engine",session:"ses_test"}]);
  });

  test("session context exposes global tools only without a project", async () => {
    const toolSpecs = new Map<string, any>();
    const repo = "aamvtrampa36-del/cdf-cloud-engine";
    let filterContext: ((event: {sessionID: string; agent: string; tools: Record<string, unknown>}) => void | Promise<void>) | undefined;
    const plugin = workspacePlugin(
      { runtime: { backends: () => [
        { id: "codemode", callable: true, description: "workspace" },
        { id: "dynamic-mcp", callable: true, description: "MCP" }
      ] } } as unknown as Workspace,
      {},
      { inspect: async () => ({}), run: async () => ({}) } as any,
      { execute: async () => ({}) },
      async (session, action) => {
        if (session !== "ses_project" && session !== "ses_repo") throw new Error("unexpected session");
        assertScopedTool({project:"cdf-cloud-engine", ...(session === "ses_repo" ? {repository:repo} : {})}, action);
      },
      async (session) => {
        if (session !== "ses_repo") throw new Error("No repository bound");
        return repo;
      },
      async (session) => session === "ses_free" ? "" : "cdf-cloud-engine"
    );
    await plugin.setup({
      agent: {transform: async () => undefined},
      tool: {transform: async (cb: (ed:any)=>unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name,spec)
      })},
      session: {hook: async (name: string, callback: typeof filterContext) => {
        expect(name).toBe("context");
        filterContext = callback;
        return {dispose: async () => undefined};
      }}
    } as any);

    const getTools = () => Object.fromEntries([...toolSpecs.keys(), "execute"].map(name => [name, {}]));
    const unscoped = getTools();
    await filterContext!({sessionID:"ses_free", agent:"build", tools:unscoped});
    expect(unscoped).toHaveProperty("read");
    expect(unscoped).toHaveProperty("ls");
    expect(unscoped).toHaveProperty("find");
    expect(unscoped).toHaveProperty("execute");
    expect(unscoped).not.toHaveProperty("linux");
    expect(unscoped).not.toHaveProperty("github");

    const projectOnly = getTools();
    await filterContext!({sessionID:"ses_project", agent:"build", tools:projectOnly});
    expect(projectOnly).not.toHaveProperty("read");
    expect(projectOnly).not.toHaveProperty("ls");
    expect(projectOnly).not.toHaveProperty("find");
    expect(projectOnly).not.toHaveProperty("execute");
    expect(projectOnly).toHaveProperty("exec");
    expect(projectOnly).toHaveProperty("linux");
    expect(projectOnly).toHaveProperty("inspect_linux");
    expect(projectOnly).not.toHaveProperty("github");

    const projectWithRepo = getTools();
    await filterContext!({sessionID:"ses_repo", agent:"build", tools:projectWithRepo});
    expect(projectWithRepo).not.toHaveProperty("find");
    expect(projectWithRepo).not.toHaveProperty("execute");
    expect(projectWithRepo).toHaveProperty("exec");
    expect(projectWithRepo).toHaveProperty("linux");
    expect(projectWithRepo).toHaveProperty("github");
    expect(projectWithRepo).toHaveProperty("repo_read");
  });

  test("plan hides dynamic and side-effect tools and rejects direct calls", async () => {
    const toolSpecs = new Map<string, any>();
    let filterContext: ((event: { sessionID: string; agent: string; tools: Record<string, unknown> }) => void | Promise<void>) | undefined;
    let dynamicRuns = 0;
    let proposalWrites = 0;
    let imageRuns = 0;
    const plugin = workspacePlugin(
      { runtime: {
        backends: () => [
          { id: "codemode", callable: true, description: "workspace" },
          { id: "dynamic-mcp", callable: true, description: "MCP" }
        ],
        exec: async () => {
          dynamicRuns++;
          return { async *[Symbol.asyncIterator]() { yield { name: "exit", code: 0, result: {} }; } };
        }
      } } as unknown as Workspace,
      {},
      undefined,
      undefined,
      async () => undefined,
      undefined,
      async () => "",
      {
        getModel: async () => "configured-image-model",
        generate: async () => {
          imageRuns++;
          return { mime: "image/png", data: "aW1hZ2U=" };
        }
      },
      undefined,
      { propose: async () => { proposalWrites++; return { id: "proposal-1" }; } }
    );
    await plugin.setup({
      agent: { transform: async () => undefined },
      tool: { transform: async (callback: (editor: any) => unknown) => callback({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name, spec)
      }) },
      session: { hook: async (_name: string, callback: typeof filterContext) => { filterContext = callback; } }
    } as any);

    const planTools = Object.fromEntries([...toolSpecs.keys(), "execute"].map(name => [name, {}]));
    await filterContext!({ sessionID: "ses_plan", agent: "plan", tools: planTools });
    expect(planTools).toHaveProperty("read");
    expect(planTools).not.toHaveProperty("exec");
    expect(planTools).not.toHaveProperty("execute");
    expect(planTools).not.toHaveProperty("propose_template");
    expect(planTools).not.toHaveProperty("generate_image");

    const context = { id: "call-plan", sessionID: "ses_plan", agent: "plan", signal: new AbortController().signal };
    await expect(toolSpecs.get("exec").execute({ command: "export default () => ({ ok: true })" }, context))
      .rejects.toThrow("solo pueden leer o buscar archivos");
    await expect(toolSpecs.get("propose_template").execute({ templateJson: "{}" }, context))
      .rejects.toThrow("solo pueden leer o buscar archivos");
    await expect(toolSpecs.get("generate_image").execute({ prompt: "imagen" }, context))
      .rejects.toThrow("solo pueden leer o buscar archivos");
    expect({ dynamicRuns, proposalWrites, imageRuns }).toEqual({ dynamicRuns: 0, proposalWrites: 0, imageRuns: 0 });
  });

  test("forces project-bound exec calls onto the isolated Dynamic Worker backend", async () => {
    const toolSpecs = new Map<string, any>();
    let execution: { command: string; backend?: string; cwd?: string; env?: Record<string, string> } | undefined;
    const workspace = {
      runtime: {
        backends: () => [
          { id: "codemode", callable: true, description: "workspace" },
          { id: "dynamic-mcp", callable: true, description: "MCP" }
        ],
        exec: async (command: string, options: { backend?: string; cwd?: string; env?: Record<string, string> }) => {
          execution = { command, backend: options.backend, cwd: options.cwd, env: options.env };
          return {
            async *[Symbol.asyncIterator]() {
              yield { name: "exit", code: 0, result: { ok: true } };
            }
          };
        }
      }
    } as unknown as Workspace;
    const plugin = workspacePlugin(
      workspace, {}, undefined, undefined,
      async () => { throw new Error("Shared workspace guard must not permit project access"); },
      undefined, async () => "cdf-cloud-engine"
    );
    await plugin.setup({
      agent: {transform: async () => undefined},
      tool: {transform: async (cb: (ed: any) => unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => toolSpecs.set(spec.name, spec)
      })}
    } as any);

    await toolSpecs.get("exec").execute({
      command: "export default () => ({ ok: true })",
      backend: "codemode",
      cwd: "/workspace/elsewhere",
      env: { SHOULD_NOT_REACH_DYNAMIC_WORKER: "value" }
    }, { id: "call-1", sessionID: "ses_project", agent: "build", signal: new AbortController().signal });
    expect(execution).toEqual({ command: "export default () => ({ ok: true })", backend: "dynamic-mcp" });
  });

  test("subagents only receive read tools for their bound scope", async () => {
    const repo = "aamvtrampa36-del/cdf-cloud-engine";
    let filterContext: ((event: {sessionID: string; agent: string; tools: Record<string, unknown>}) => void | Promise<void>) | undefined;
    const plugin = workspacePlugin(
      {} as Workspace,
      {},
      { inspect: async () => ({}), run: async () => ({}) } as any,
      { execute: async () => ({}) },
      async () => undefined,
      async (session) => session === "ses_child_repo" ? repo : "",
      async (session) => session === "ses_child_project" || session === "ses_child_repo" ? "cdf-cloud-engine" : "",
      undefined,
      { isChild: async (session) => session.startsWith("ses_child_"),
        start: async () => ({ session: "ses_unused" }),
        result: async () => ({ status: "finished", text: "" }) }
    );
    await plugin.setup({
      agent: { transform: async () => undefined },
      tool: { transform: async (cb: (ed: any) => unknown) => cb({
        remove: () => undefined, add: () => undefined
      }) },
      session: { hook: async (_name: string, callback: typeof filterContext) => { filterContext = callback; } }
    } as any);

    const global = Object.fromEntries([
      "read", "glob", "grep", "ls", "find", "stat", "write", "shell", "mcp_write",
      "linux", "inspect_linux", "github", "repo_read", "start_subagent"
    ].map(name => [name, {}]));
    await filterContext!({ sessionID: "ses_child_global", agent: "build", tools: global });
    expect(Object.keys(global).sort()).toEqual(["find", "glob", "grep", "ls", "read", "stat"]);

    const project = Object.fromEntries([
      "read", "write", "shell", "mcp_write", "linux", "inspect_linux", "github",
      "repo_info", "repo_read", "repo_review", "start_subagent", "generate_image"
    ].map(name => [name, {}]));
    await filterContext!({ sessionID: "ses_child_project", agent: "build", tools: project });
    expect(Object.keys(project).sort()).toEqual(["inspect_linux"]);

    const projectRepo = Object.fromEntries([
      "read", "write", "shell", "mcp_write", "linux", "inspect_linux", "github",
      "repo_info", "repo_read", "repo_review", "start_subagent", "generate_image"
    ].map(name => [name, {}]));
    await filterContext!({ sessionID: "ses_child_repo", agent: "build", tools: projectRepo });
    expect(Object.keys(projectRepo).sort()).toEqual(["inspect_linux", "repo_info", "repo_read", "repo_review"]);
  });
});

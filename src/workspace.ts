import { assertAgentToolPermission } from "./tool-permissions";
import type { Workspace } from "@cloudflare/computer";
import {
  createPiTools,
  type CreatePiToolsOptions,
  type PiTool
} from "@cloudflare/computer/tools/pi-ai";
import type { Plugin } from "@opencode/plugin";
import type { GitHubAction } from "./github";
import type { ScopedToolAction } from "./project-scope";
import { executeBoundRepositoryAction } from "./scoped-github";
import { resolveScopedLinuxProject } from "./scoped-linux-tools";

/**
 * OpenCode's tools that need a local filesystem or process. The Workers
 * profile has neither, so the Workspace's tools replace them.
 */
export type GitHubRunner = { execute(input: GitHubAction): Promise<unknown> };

export type LinuxRunner = {
  inspect(project: string, action: "list" | "read", relativePath: string, sessionID?: string): Promise<unknown>;
  run(project: string, command: string, sessionID?: string): Promise<{
    project: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    persistence: string;
  }>;
};

const LOCAL_TOOLS = ["read", "write", "edit", "patch", "glob", "grep", "shell"];

const SYSTEM = `You are OpenCode running in a Cloudflare Durable Object, not the user's computer. Each project uses a separate Linux Container. The linux tool runs commands in the selected project; inspect_linux reads its files without executing commands. A selected GitHub repository is imported into its Container from a pinned commit without sending credentials to Linux. This is a source archive, not a Git checkout: .git and Git history are absent. Use the scoped github tool to create an opencode/* branch, write the tested text files to that branch, review the diff, and open a draft PR. Do not claim a local git push or checkout exists. Previous shared projects remain available as backups and must be restored to a new name before development. Containers checkpoint files before idle suspension. To give the user a live browser preview, create a static production build at /workspace/projects/{project-slug}/dist/index.html with relative asset URLs. For Vite use base './'; for HTML-only projects copy HTML, CSS and JS into dist/. The web UI provides a Ver app button. Do not claim the preview is working until tested. Never claim a command passed until its returned exitCode is zero. Never claim to have run tools or tests you could not actually run.\n\nDEVELOPMENT: Understand requirements, use small reversible changes, inspect diffs, report tests actually performed and unresolved issues. Create proposals or drafts first. Do not delete important data, write to production, merge to main, change credentials or deploy services without explicit approval. Never make up tool results or source contents.\n\nOFFICIAL SOURCES: You may plan, draft, edit and review, but the owner approves final integration and publication. NEVER overwrite official sources, canonize editorial content, merge production changes or publish without explicit authorization for the exact operation. Keep drafts distinguishable from approved materials.\n\nGITHUB: When the github tool is available, use it to read the owner's repositories approved in Settings, create opencode/* review branches, save changed text files and open draft pull requests. It never merges or pushes to main. For remote GitHub review use repo_review, repo_read and repo_info: these tools automatically resolve the repository from the authenticated session. DO NOT inspect /bundle/.git/HEAD or use /bundle as a checkout of the selected GitHub repository. Generic workspace tools are blocked in project sessions because the Durable Object workspace is shared. Use the scoped inspect_linux or GitHub tools for reads. In Plan/Review use repo_review with the opencode/* branch directly. If the bridge is unavailable, ask the user to connect GitHub privately in Settings; never ask for a token in chat.\n\nCOST/SECURITY: Prefer inexpensive models for ordinary tasks. Never print API secrets. Do not disable authentication or launch billable infrastructure without informed authorization.\n\nOPERATIONS: State the actual available tools and constraints. A separate Linux Container is available through the scoped linux tool. Explain only genuine missing capabilities, and never fake command results, tools, or tests. Do not use the shared workspace tools in project sessions. Concise Spanish unless the user requests otherwise.`;

/**
 * The shared `exec` description is written for a choice of shell backends.
 * This Workspace has one JavaScript backend, so say what that is instead.
 */
const EXEC_DESCRIPTION = `Run JavaScript in the workspace. \`command\` is the source of an ES module, run in a fresh sandboxed isolate with no network access. If the module default-exports a function, it is called with \`input\` and its return value comes back as \`result\`. console.log and console.error go to stdout and stderr. There is no shell, npm or package install: the only imports are these two, plus relative imports of .js files in the workspace.

- \`node:fs/promises\`: the workspace files, async only (readFile, writeFile, mkdir, rm, readdir, stat, lstat, access). readFile takes "utf8" for text.
- \`codemode:git\`: git on the workspace, cloning over HTTPS through the host. Each \`dir\` is resolved against the module's working directory, defaults to it, and must stay inside /workspace, so pass the repository's directory. Its exports:

\`\`\`ts
function clone(options: {
  url: string; // HTTPS only
  dir?: string; // working tree to create
  ref?: string; // branch, tag or commit; default: the remote's default branch
  depth?: number; // shallow clone; default: full history
  paths?: string[]; // check out only these paths
  singleBranch?: boolean; // default true
  noTags?: boolean; // default true
}): Promise<void>;
function status(options?: { dir?: string }): Promise<
  { path: string; index: " " | "A" | "M" | "D"; worktree: " " | "A" | "M" | "D" | "?" }[]
>;
// A unified diff of \`ref\` (default HEAD) against the working tree, or against \`to\` when set.
function diff(options?: { dir?: string; ref?: string; to?: string; paths?: string[] }): Promise<string>;
// Newest first, from \`ref\` (default HEAD); \`depth\` caps the count.
function log(options?: { dir?: string; ref?: string; depth?: number }): Promise<
  {
    oid: string;
    message: string;
    tree: string;
    parent: string[];
    author: { name: string; email: string; timestamp: number; timezoneOffset: number }; // timestamp in seconds
    committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
  }[]
>;
\`\`\`

Example:
import { clone, log } from "codemode:git";
export default async function () {
  await clone({ url: "https://github.com/octocat/Hello-World", dir: "/workspace/hello", depth: 5 });
  return (await log({ dir: "/workspace/hello" })).map((c) => \`\${c.oid.slice(0, 7)} \${c.message.split("\\n")[0]}\`);
}

Prefer the read, write and edit tools for plain file changes.`;

const COMMAND_DESCRIPTION =
  "ES module source to run. Default-export a function to receive `input` and return a result.";

/** `exec`'s declaration, described for the JavaScript backend. */
function describeExec(tool: PiTool): PiTool {
  const properties = tool.parameters.properties ?? {};
  const command = properties.command;
  return {
    ...tool,
    description: EXEC_DESCRIPTION,
    parameters: {
      ...tool.parameters,
      properties: {
        ...properties,
        command:
          typeof command === "object" && command !== null
            ? { ...command, description: COMMAND_DESCRIPTION }
            : command
      }
    }
  };
}

/**
 * This app's OpenCode plugin: the Workspace tools from
 * `@cloudflare/computer/tools/pi-ai` in place of OpenCode's local file and
 * shell tools, and a system prompt that says what is there.
 *
 * `createPiTools` returns tool declarations and one `execute` that runs a
 * call by name. `execute` validates the arguments against the tool's schema
 * and reports failures as `isError` results, which become tool errors here.
 */
export function workspacePlugin(
  workspace: Workspace,
  options: Omit<CreatePiToolsOptions, "workspace" | "exec" | "shell"> = {},
  linux?: LinuxRunner,
  github?: GitHubRunner,
  scopeGuard?: (sessionID: string, action: ScopedToolAction) => Promise<void>,
  getBoundRepository?: (sessionID: string) => Promise<string>,
  getBoundProject?: (sessionID: string) => Promise<string>
): Plugin.Plugin {
  const { tools, execute } = createPiTools({
    ...options,
    workspace,
    exec: {
      backends: {
        // The id `CodemodeBackend` registers under by default.
        codemode: {
          description: "Runs ES module source in a sandboxed isolate."
        }
      }
    }
  });
  const sharedWorkspaceToolNames = tools.map((tool) => tool.name.replace(/[^a-zA-Z0-9_-]/g, "_"));
  const projectToolNames = ["linux", "inspect_linux", "github", "repo_review", "repo_info", "repo_read"];
  const githubToolNames = ["github", "repo_review", "repo_info", "repo_read"];

  return {
    id: "example.workspace",
    async setup(ctx) {
      await ctx.agent.transform((editor) => {
        editor.update("build", (agent) => {
          agent.system = SYSTEM;
        });
        editor.update("plan", (agent) => {
          agent.system = SYSTEM +
            "\n\nPLAN/REVIEW MODE: Only analyze and inspect. Do not modify files, change Git branches, perform deployments, publish narrative or install packages. Provide grounded observations and a concise plan. The user must switch to Develop before implementing changes.";
        });
      });
      if (scopeGuard && ctx.session) {
        // Tool definitions are shared by the Worker, but the model context is
        // per session. Expose the shared Workspace only for confirmed
        // unscoped conversations and isolated project tools after binding.
        await ctx.session.hook("context", async ({ sessionID, tools: available }) => {
          let project: string | undefined;
          try {
            if (!getBoundProject) throw new Error("Session scope is unavailable");
            project = await getBoundProject(sessionID);
          } catch {
            project = undefined;
          }

          if (project !== "") {
            for (const name of sharedWorkspaceToolNames) delete available[name];
          }
          if (!project) {
            for (const name of projectToolNames) delete available[name];
            return;
          }

          let repository = "";
          try {
            repository = await getBoundRepository?.(sessionID) ?? "";
          } catch {
            // A project without an approved repository still has Linux tools.
          }
          if (!repository) {
            for (const name of githubToolNames) delete available[name];
          }
        });
      }
      await ctx.tool.transform((editor) => {
        for (const id of LOCAL_TOOLS) editor.remove(id);
        if (linux) {
          editor.add({
            name: "linux",
            description: "Run one real command in the selected project's separate Linux Container. A bound GitHub repository is prepared from a pinned source archive, without .git or credentials. Use github to write tested files to an opencode/* branch and open a draft PR. Output includes the real exitCode.",
            input: {
              type: "object",
              properties: {
                project: { type: "string", description: "Optional legacy project ID. Normally omit it: the target is derived from the authorized session, not model input." },
                command: { type: "string", description: "Shell script to execute INSIDE the project directory; no more than 12000 characters" }
              },
              required: ["command"],
              additionalProperties: false
            },
            options: { codemode: false },
            async execute(input, context) {
              assertAgentToolPermission(context.agent, "linux");
              const p = input as { project?: string; command: string };
              const target = await resolveScopedLinuxProject(context.sessionID, p.project, getBoundProject);
              if (scopeGuard) await scopeGuard(context.sessionID, { kind: "linux", project: target });
              const result = await linux.run(target, p.command, context.sessionID);
              return { content: JSON.stringify(result) };

            }
          });
        }
        if (linux) {
          editor.add({
            name: "inspect_linux",
            description: "READ-ONLY inspection of an existing Linux project. List one directory or read one UTF-8 text file (max 32 KiB) without running commands, installing packages or modifying files. Use this in Plan or Review. Hidden secrets, node_modules, and .git are excluded. Enter project slug and a safe relative path.",
            input: {
              type: "object",
              properties: {
                project: { type: "string", description: "Optional legacy project ID; the authorized session determines the target automatically." },
                action: { type: "string", enum: ["list", "read"], description: "List folder or read text file" },
                path: { type: "string", description: "Relative path under project, empty string for project root listing" }
              },
              required: ["action", "path"],
              additionalProperties: false
            },
            options: { codemode: false },
            async execute(input, context) {
              const p = input as { project?: string; action: "list" | "read"; path: string };
              const target = await resolveScopedLinuxProject(context.sessionID, p.project, getBoundProject);
              if (scopeGuard) await scopeGuard(context.sessionID, { kind: "linux", project: target });
              return { content: JSON.stringify(await linux.inspect(target, p.action, p.path, context.sessionID)) };
            }
          });
        }
        if (github) {
          editor.add({
            name: "github",
            description: "Session-scoped GitHub integration. Only the repository explicitly selected in this conversation is permitted. Read metadata/files, create opencode/* review branches, write small text files outside protected canonical paths, review changed-file diffs and open draft PRs. Never merge or modify main. Actions: repo, read, branch, write, review, pr. Token never enters the agent or Linux.",
            input: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["repo", "read", "branch", "write", "review", "pr"] },
                repo: { type: "string", description: "An owner-approved repository, e.g. aamvtrampa36-del/my-project" },
                branch: { type: "string", description: "New review branch, must start opencode/" },
                path: { type: "string", description: "Repository-relative file path (text files only, 100KB maximum)" },
                ref: { type: "string", description: "Read-only branch, tag or commit" },
                content: { type: "string", description: "Full text content for GitHub write" },
                message: { type: "string", description: "Git commit message" },
                title: { type: "string", description: "Draft PR title" },
                body: { type: "string", description: "Draft PR description" }
              },
              required: ["action", "repo"],
              additionalProperties: false
            },
            options: { codemode: false },
            async execute(input, context) {
              const action = (input as { action?: string }).action;
              assertAgentToolPermission(context.agent, "github", { action });
              if (scopeGuard) await scopeGuard(context.sessionID, {
                kind: "github", repo: (input as { repo: string }).repo,
                operation: action,
                ...(["write", "pr", "review", "branch"].includes(action ?? "") ?
                  { branch: (input as { branch?: string }).branch } : {})
              });
              const result = await github.execute(input as GitHubAction);
              return { content: JSON.stringify(result) };
            }
          });
        }
        // Dedicated unambiguous GitHub read tools. Unlike a generic
        // github action with an LLM-provided repo, these resolve the
        // selected repository from Durable Object session state.
        if (github && getBoundRepository && scopeGuard) {
          const runBound = (
            context: { sessionID: string; agent: string },
            action: Parameters<typeof executeBoundRepositoryAction>[2]
          ) => executeBoundRepositoryAction(
            context.sessionID, context.agent, action,
            getBoundRepository,
            async (sessionID, repo) => scopeGuard(sessionID, { kind: "github", repo }),
            (input) => github.execute(input)
          );
          editor.add({
            name: "repo_review",
            description: "REVIEW SELECTED GITHUB REPOSITORY DIFF. Use this FIRST in Review mode. Read-only GitHub API comparison of main to an opencode/* branch. The selected repository is automatically resolved from the current session; do not supply a repo. Never inspect /bundle/.git/HEAD. Returns changed files and line counts.",
            input: {
              type: "object",
              properties: {
                branch: { type: "string", description: "Review branch, e.g. opencode/g8-cdf-isolation-20261110" }
              },
              required: ["branch"],
              additionalProperties: false
            },
            options: { codemode: false },
            async execute(input, context) {
              const p = input as { branch: string };
              return { content: JSON.stringify(await runBound(context, { action: "review", branch: p.branch })) };
            }
          });
          editor.add({
            name: "repo_info",
            description: "Read ONLY the selected GitHub repository metadata through its authorized API. Automatically uses the immutable repository bound to this conversation. Do NOT use generic filesystem tools or /bundle.",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            async execute(_input, context) {
              return { content: JSON.stringify(await runBound(context, { action: "repo" })) };
            }
          });
          editor.add({
            name: "repo_read",
            description: "Read ONLY a text file from the selected GitHub repository and ref using GitHub API. The repo is bound to this session, NOT a local /bundle checkout. Does not modify files.",
            input: {
              type: "object",
              properties: {
                path: { type: "string", description: "Repository-relative path, e.g. docs/opencode-g8/isolated-review-20261110.md" },
                ref: { type: "string", description: "Branch or commit, e.g. opencode/g8-cdf-isolation-20261110" }
              },
              required: ["path", "ref"],
              additionalProperties: false
            },
            options: { codemode: false },
            async execute(input, context) {
              const p = input as { path: string; ref: string };
              return { content: JSON.stringify(await runBound(context, { action: "read", path: p.path, ref: p.ref })) };
            }
          });
        }
        // The context hook above limits these shared tools to unscoped
        // conversations; project sessions use isolated Linux/GitHub tools.
        for (const declared of tools) {
          const tool =
            declared.name === "exec" ? describeExec(declared) : declared;
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.parameters,
            // Offer each tool to the model by name. Otherwise OpenCode wraps
            // plugin tools in its `execute` code-mode tool.
            options: { codemode: false },
            async execute(input, context) {
              assertAgentToolPermission(context.agent, "workspace", { tool: tool.name });
              // All generic tools target one shared workspace, including reads.
              // Project sessions must use their scoped Linux or GitHub tools.
              if (scopeGuard) {
                await scopeGuard(context.sessionID, { kind: "workspace-write" });
              }
              const { content, isError } = await execute(
                { id: context.id, name: tool.name, arguments: input },
                { abortSignal: context.signal }
              );
              const text = content
                .map((part) => (part.type === "text" ? part.text : ""))
                .join("\n");
              if (isError) throw new Error(text || `${tool.name} failed`);
              return { content: text };
            }
          });
        }
      });
    }
  };
}

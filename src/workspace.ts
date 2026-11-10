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

/**
 * OpenCode's tools that need a local filesystem or process. The Workers
 * profile has neither, so the Workspace's tools replace them.
 */
export type GitHubRunner = { execute(input: GitHubAction): Promise<unknown> };

export type LinuxRunner = {
  inspect(project: string, action: "list" | "read", relativePath: string): Promise<unknown>;
  run(project: string, command: string): Promise<{
    project: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    persistence: string;
  }>;
};

const LOCAL_TOOLS = ["read", "write", "edit", "patch", "glob", "grep", "shell"];

const SYSTEM = `You are OpenCode running in a Cloudflare Durable Object, not the user's computer. You have a durable /workspace with file tools and an isolated JavaScript ES-module exec backend; you can clone public Git repositories via codemode:git. You ALSO have a separate cloud Linux computer via the linux tool (Debian, Node.js and npm; Git can be installed on demand). The inspect_linux tool safely lists and reads existing Linux project files without executing commands; use it for planning and review. The Durable Object file tools are a separate storage area; use linux for actual application projects under /workspace/projects/{project-slug}, compilation, package installation and tests. The Linux container automatically checkpoints files before idle suspension. To give the user a live browser preview, create a static production build at /workspace/projects/{project-slug}/dist/index.html with relative asset URLs. For Vite use base './' (for example npm run build -- --base=./); for HTML-only projects copy HTML, CSS and JS into dist/. The web UI provides a Ver app button that opens /api/dev/preview/{project-slug}/dist/. Do not claim the preview is working until tested. Never claim a command passed until its returned exitCode is zero. Never claim to have run tools or tests you could not actually run.\n\nDEVELOPMENT: Understand requirements, use small reversible changes, inspect diffs, report tests actually performed and unresolved issues. Create proposals or drafts first. Do not delete important data, write to production, merge to main, change credentials or deploy services without explicit approval. Never make up tool results or source contents.\n\nOFFICIAL SOURCES: You may plan, draft, edit and review, but the owner approves final integration and publication. NEVER overwrite official sources, canonize editorial content, merge production changes or publish without explicit authorization for the exact operation. Keep drafts distinguishable from approved materials.\n\nGITHUB: When the github tool is available, use it to read the owner's repositories approved in Settings, create opencode/* review branches, save changed text files and open draft pull requests. It never merges or pushes to main. If github is unavailable, tell the user that a private GITHUB_TOKEN Worker secret must be configured; never ask for a token in chat.\n\nCOST/SECURITY: Prefer inexpensive models for ordinary tasks. Never print API secrets. Do not disable authentication or launch billable infrastructure without informed authorization.\n\nOPERATIONS: State the actual available tools and constraints. A separate Linux Container is already available through the linux tool. Explain only genuine missing capabilities, and never fake command results, tools, or tests. Paths for workspace tools are absolute. Prefer read/write/edit for text files. Concise Spanish unless the user requests otherwise.`;

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
  scopeGuard?: (sessionID: string, action: ScopedToolAction) => Promise<void>
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
      await ctx.tool.transform((editor) => {
        for (const id of LOCAL_TOOLS) editor.remove(id);
        if (linux) {
          editor.add({
            name: "linux",
            description: "Run ONE real Linux shell command inside an isolated Cloudflare Container (Debian, Node.js 24, npm). Can install dependencies, create apps, run tests and inspect git. Project is a 1–40 char lowercase slug under /workspace/projects/. Commands run for up to 180 seconds. Output includes real exitCode. Files are checkpointed automatically by container snapshots before idle suspend. Do not use it for secrets, production deploys, deleting unrelated projects, or canonizing CDF.",
            input: {
              type: "object",
              properties: {
                project: { type: "string", description: "Project ID, e.g. primera-app (lowercase letters, digits, hyphen)" },
                command: { type: "string", description: "Shell script to execute INSIDE the project directory; no more than 12000 characters" }
              },
              required: ["project", "command"],
              additionalProperties: false
            },
            options: { codemode: false },
            async execute(input, context) {
              assertAgentToolPermission(context.agent, "linux");
              const p = input as { project: string; command: string };
              if (scopeGuard) await scopeGuard(context.sessionID, { kind: "linux", project: p.project });
              const result = await linux.run(p.project, p.command);
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
                project: { type: "string", description: "Existing project slug, e.g. primera-app" },
                action: { type: "string", enum: ["list", "read"], description: "List folder or read text file" },
                path: { type: "string", description: "Relative path under project, empty string for project root listing" }
              },
              required: ["project", "action", "path"],
              additionalProperties: false
            },
            options: { codemode: false },
            async execute(input) {
              const p = input as { project: string; action: "list" | "read"; path: string };
              if (scopeGuard) await scopeGuard(context.sessionID, { kind: "linux", project: p.project });
              return { content: JSON.stringify(await linux.inspect(p.project, p.action, p.path)) };
            }
          });
        }
        if (github) {
          editor.add({
            name: "github",
            description: "Direct GitHub integration independent of ChatGPT. Read files and repository metadata, create review branches named opencode/<slug>, commit small text files to those branches, and create draft pull requests. Only the owner's explicitly approved repositories are authorized. Never merge, publish or modify default branches. Actions: repo, read, branch, write, pr. No GitHub token is sent to Linux or the model.",
            input: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["repo", "read", "branch", "write", "pr"] },
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
                kind: "github", repo: (input as { repo: string }).repo
              });
              const result = await github.execute(input as GitHubAction);
              return { content: JSON.stringify(result) };
            }
          });
        }
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
              if (scopeGuard && ["write", "edit", "patch", "exec", "shell"].includes(tool.name)) {
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

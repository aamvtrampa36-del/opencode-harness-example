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
import type { GeneratedImage } from "./openrouter-images";

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

export type ImageGenerationRunner = {
  getModel(sessionID: string): Promise<string | undefined>;
  generate(sessionID: string, prompt: string): Promise<GeneratedImage>;
};

export type SubagentRunner = {
  isChild(sessionID: string): Promise<boolean>;
  start(sessionID: string, task: string, kind: "analysis" | "decision"): Promise<{ session: string }>;
  result(parentSession: string, childSession: string): Promise<{ status: "running" | "finished"; text: string }>;
};

export type TemplateProposalRunner = { propose(value: unknown): Promise<{ id: string }> };

const LOCAL_TOOLS = ["read", "write", "edit", "patch", "glob", "grep", "shell"];

const SYSTEM = `You are OpenCode running in a Cloudflare Durable Object, not the user's computer. Each project uses a separate Linux Container. The linux tool runs commands in the selected project; inspect_linux reads its files without executing commands. The linux command starts in the selected project's root: use relative paths such as dist/index.html, never /bundle or other absolute workspace paths. A selected GitHub repository is imported into its Container from a pinned commit without sending credentials to Linux. This is a source archive, not a Git checkout: .git and Git history are absent. Use the scoped github tool to create an opencode/* branch, write the tested text files to that branch, review the diff, and open a draft PR. Do not claim a local git push or checkout exists. Previous shared projects remain available as backups and must be restored to a new name before development. Containers checkpoint files before idle suspension. To give the user a live browser preview, create the build in the selected project directory's relative dist/ folder; for HTML-only projects create dist/index.html, and for Vite use base './'. The web UI provides a Ver app button. Do not claim the preview is working until tested. Never claim a command passed until its returned exitCode is zero. Never claim to have run tools or tests you could not actually run.\n\nDEVELOPMENT: Understand requirements, use small reversible changes, inspect diffs, report tests actually performed and unresolved issues. Create proposals or drafts first. Do not delete important data, write to production, merge to main, change credentials or deploy services without explicit approval. Never make up tool results or source contents.\n\nOFFICIAL SOURCES: You may plan, draft, edit and review, but the owner approves final integration and publication. NEVER overwrite official sources, canonize editorial content, merge production changes or publish without explicit authorization for the exact operation. Keep drafts distinguishable from approved materials.\n\nGITHUB: When the github tool is available, use it to read the owner's repositories approved in Settings, create opencode/* review branches, save changed text files and open draft pull requests. It never merges or pushes to main. For source-file questions about the selected GitHub repository, use repo_read with the requested path FIRST (default branch is used if no ref is specified). Use repo_info for repository metadata, repo_pr_info/repo_issue_info for authenticated private PR and issue status, repo_pr_files/repo_pr_reviews/repo_checks for bounded evidence, and repo_review ONLY for diffs of existing opencode/* review branches. Do not substitute inspect_linux for an explicit GitHub API read; inspect_linux is for local isolated files. Execute the requested reads before summarizing, and never claim to have read a file from a directory listing alone. DO NOT inspect /bundle/.git/HEAD or use /bundle as a checkout of the selected GitHub repository. Generic workspace tools are blocked in project sessions because the Durable Object workspace is shared. Use the scoped inspect_linux or GitHub tools for reads. In Plan/Review use repo_review with the opencode/* branch directly. If the bridge is unavailable, ask the user to connect GitHub privately in Settings; never ask for a token in chat.\n\nCOST/SECURITY: Prefer inexpensive models for ordinary tasks. Never print API secrets. Do not disable authentication or launch billable infrastructure without informed authorization.\n\nOPERATIONS: State the actual available tools and constraints. A separate Linux Container is available through the scoped linux tool. Explain only genuine missing capabilities, and never fake command results, tools, or tests. Do not use the shared workspace tools in project sessions. Concise Spanish unless the user requests otherwise.`;

const DYNAMIC_WORKERS_GUIDANCE = `DYNAMIC WORKERS: Project sessions keep only the exec tool from the shared workspace tools, and the server forces it onto the dynamic-mcp backend. Use it for short JavaScript runs and sequences of existing remote MCP tools. Import servers, tools and call from codemode:mcp to find connected servers and their current input schemas. The host keeps OAuth and bearer credentials private and enforces the configured tool allowlist. This backend has no project file access. The codemode backend can access the shared workspace and is available only in unscoped sessions. Use direct MCP calls for a single simple operation when that is clearer.`;

/**
 * The shared `exec` description makes the two JavaScript backend choices clear.
 */
const EXEC_DESCRIPTION = `Run JavaScript in a fresh Dynamic Worker isolate. \`command\` is the source of an ES module. If the module default-exports a function, it is called with \`input\` and its return value comes back as \`result\`. console.log and console.error go to stdout and stderr. There is no shell, npm or package install.

Choose backend \`dynamic-mcp\` to run isolated code without workspace writes and to combine existing remote MCP tools. It can import \`codemode:mcp\`; configured OAuth and bearer credentials stay in the host. Example:

\`import { servers, tools, call } from "codemode:mcp";\`
\`const available = await servers();\`
\`const definitions = await tools({ server: "cdf-workbench" });\`
\`const result = await call({ server: "cdf-workbench", name: "workbench_read", arguments: { path: "..." } });\`

Use \`tools({server})\` first to discover real names and input schemas. The configured toolAllowlist is enforced. One dynamic run can make at most 32 MCP tool calls.

Choose backend \`codemode\` for the shared workspace, including its \`node:fs/promises\` and \`codemode:git\` modules. That backend is unavailable in project-bound conversations; use the scoped Linux and GitHub tools for project files.

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
  getBoundProject?: (sessionID: string) => Promise<string>,
  imageGeneration?: ImageGenerationRunner,
  subagents?: SubagentRunner,
  templateProposals?: TemplateProposalRunner
): Plugin.Plugin {
  const { tools, execute } = createPiTools({
    ...options,
    workspace,
    exec: {
      backends: {
        // The id `CodemodeBackend` registers under by default.
        codemode: {
          description: "Runs ES module source with read/write access to the shared workspace and codemode:git. Unscoped sessions only."
        },
        "dynamic-mcp": {
          description: "Runs ES module source in a read-only, network-isolated Dynamic Worker. It can call existing configured MCP tools through codemode:mcp and is available in project sessions."
        }
      }
    }
  });
  // The OpenCode code-mode entrypoint executes against this shared Worker
  // workspace too, but is registered by the runtime rather than createPiTools.
  const sharedWorkspaceToolNames = [
    ...tools.map((tool) => tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")),
    "execute"
  ];
  const projectToolNames = ["linux", "inspect_linux", "github", "repo_review", "repo_info", "repo_read", "repo_pr_info", "repo_issue_info", "repo_pr_files", "repo_pr_reviews", "repo_checks"];

  return {
    id: "example.workspace",
    async setup(ctx) {
      await ctx.agent.transform((editor) => {
        editor.update("build", (agent) => {
          agent.system = SYSTEM + "\n\n" + DYNAMIC_WORKERS_GUIDANCE;
        });
        editor.update("plan", (agent) => {
          agent.system = SYSTEM + "\n\n" + DYNAMIC_WORKERS_GUIDANCE +
            "\n\nREAD-ONLY STAGE: Only analyze and inspect. Do not modify files, change Git branches, perform deployments, publish narrative or install packages. Provide grounded observations and a concise result. The next workflow stage may act if it is explicitly configured to use tools.";
        });
      });
      if (scopeGuard && ctx.session) {
        // Tool definitions are shared by the Worker, but the model context is
        // per session. Expose the shared Workspace only for confirmed
        // unscoped conversations and isolated project tools after binding.
        await ctx.session.hook("context", async ({ sessionID, tools: available }) => {
          const isSubagent = await subagents?.isChild(sessionID) ?? false;
          if (!await imageGeneration?.getModel(sessionID)) delete available.generate_image;
          if (isSubagent) {
            delete available.start_subagent;
            delete available.subagent_result;
            delete available.propose_template;
          }
          let project: string | undefined;
          try {
            if (!getBoundProject) throw new Error("Session scope is unavailable");
            project = await getBoundProject(sessionID);
          } catch {
            project = undefined;
          }

          if (project !== "") {
            for (const name of sharedWorkspaceToolNames) {
              if (name !== "exec") delete available[name];
            }
          }
          if (!project) {
            for (const name of projectToolNames) delete available[name];
            if (isSubagent) {
              const allowed = new Set(["read", "glob", "grep", "ls", "find", "stat"]);
              for (const name of Object.keys(available)) if (!allowed.has(name)) delete available[name];
            }
            return;
          }

          let repository = "";
          try {
            repository = await getBoundRepository?.(sessionID) ?? "";
          } catch {
            // A project without an approved repository still has Linux tools.
          }
          if (!repository) {
            // Keep session-bound read tools discoverable even if the repository
            // lookup fails during context construction. Their execution still
            // resolves and authorizes the repository from Durable Object state.
            // Hiding them leaves the model unable to report a useful scope error.
            delete available.github;
          }
          if (isSubagent) {
            const allowed = new Set(["inspect_linux", ...(repository
              ? ["repo_review", "repo_info", "repo_read", "repo_pr_info", "repo_issue_info", "repo_pr_files", "repo_pr_reviews", "repo_checks"] : [])]);
            for (const name of Object.keys(available)) if (!allowed.has(name)) delete available[name];
          }
        });
      }
      await ctx.tool.transform((editor) => {
        for (const id of LOCAL_TOOLS) editor.remove(id);
        if (templateProposals) editor.add({
          name: "propose_template",
          description: "Prepara una plantilla de trabajo como borrador pendiente. Nunca la guarda como plantilla activa: la persona propietaria debe revisarla y aprobarla en Configurar → Plantillas.",
          input: { type: "object", properties: {
            templateJson: { type: "string", description: "Objeto JSON Specialization con id, name, instructions, enabled:true, model opcional y stages opcionales (name, instructions, model, mode). Máximo 20000 caracteres." }
          }, required: ["templateJson"], additionalProperties: false },
          options: { codemode: false },
          async execute(input) {
            const value = input as { templateJson?: unknown };
            if (typeof value.templateJson !== "string" || value.templateJson.length > 20_000)
              throw new Error("La plantilla debe ser JSON y no superar 20000 caracteres.");
            let parsed: unknown;
            try { parsed = JSON.parse(value.templateJson); }
            catch { throw new Error("El borrador no contiene JSON válido."); }
            const proposal = await templateProposals!.propose(parsed);
            return { content: JSON.stringify({ status: "pending-owner-approval", proposal: proposal.id,
              next: "La plantilla solo se activa cuando la persona propietaria la aprueba en Configurar → Plantillas." }) };
          }
        });
        if (imageGeneration) editor.add({
          name: "generate_image",
          description: "Genera una imagen mediante el modelo de OpenRouter elegido en la plantilla activa. Úsala solo cuando la persona pida una imagen; devuelve el archivo visual en la conversación.",
          input: { type: "object", properties: {
            prompt: { type: "string", description: "Descripción visual de la imagen, hasta 8000 caracteres" }
          }, required: ["prompt"], additionalProperties: false },
          options: { codemode: false },
          async execute(input, context) {
            const { prompt } = input as { prompt?: unknown };
            if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 8_000)
              throw new Error("Describe la imagen en un máximo de 8000 caracteres.");
            const generated = await imageGeneration!.generate(context.sessionID, prompt);
            return { content: [
              { type: "file", uri: `data:${generated.mime};base64,${generated.data}`,
                mime: generated.mime, name: "imagen-generada" },
              { type: "text", text: generated.cost === null ? "Imagen generada." :
                `Imagen generada. Coste informado por OpenRouter: $${generated.cost.toFixed(4)}.` }
            ] };
          }
        });
        if (subagents) {
          editor.add({
            name: "start_subagent",
            description: "Inicia un subagente de solo lectura en una sesión derivada, con el mismo proyecto y repositorio autorizados. Usa tareas acotadas y no repitas la misma delegación. Indica kind=decision solo para comparar opciones y recomendar una decisión; los demás encargos usan kind=analysis y el modelo heredado.",
            input: { type: "object", properties: {
              task: { type: "string", description: "Una tarea independiente y concreta, hasta 4000 caracteres" },
              kind: { type: "string", enum: ["analysis", "decision"], description: "analysis por defecto; decision solo para comparar y recomendar" }
            }, required: ["task"], additionalProperties: false },
            options: { codemode: false },
            async execute(input, context) {
              const { task, kind } = input as { task?: unknown; kind?: unknown };
              if (typeof task !== "string" || !task.trim() || task.length > 4_000)
                throw new Error("La tarea del subagente debe tener entre 1 y 4000 caracteres.");
              if (kind !== undefined && kind !== "analysis" && kind !== "decision")
                throw new Error("El tipo del subagente debe ser analysis o decision.");
              const result = await subagents!.start(context.sessionID, task, kind === "decision" ? "decision" : "analysis");
              return { content: JSON.stringify({ ...result, status: "started",
                next: "Consulta subagent_result con este session id cuando necesites su resultado." }) };
            }
          });
          editor.add({
            name: "subagent_result",
            description: "Consulta el estado y el resumen de un subagente iniciado por esta conversación.",
            input: { type: "object", properties: {
              session: { type: "string", description: "Identificador de la sesión devuelto por start_subagent" }
            }, required: ["session"], additionalProperties: false },
            options: { codemode: false },
            async execute(input, context) {
              const { session } = input as { session?: unknown };
              if (typeof session !== "string") throw new Error("Identificador de subagente inválido.");
              return { content: JSON.stringify(await subagents!.result(context.sessionID, session)) };
            }
          });
        }
        if (linux) {
          editor.add({
            name: "linux",
            description: "Run one real command in the selected project's separate Linux Container. The current directory is already the authorized project root: use relative paths such as dist/index.html, never /bundle or other absolute workspace paths. The conversation selects the project automatically; do not pass a project argument. A bound GitHub repository is prepared from a pinned source archive, without .git or credentials. Use github to write tested files to an opencode/* branch and open a draft PR. Output includes the real exitCode.",
            input: {
              type: "object",
              properties: {
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
            description: "READ-ONLY inspection of the Linux project selected in this conversation. The project is resolved automatically; do not pass a project argument. List one directory or read one UTF-8 text file (max 32 KiB) without running commands, installing packages or modifying files. Use this in Plan or Review. Hidden secrets, node_modules, and .git are excluded.",
            input: {
              type: "object",
              properties: {
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
            name: "repo_pr_info",
            description: "READ-ONLY: retrieve the exact private GitHub PR metadata: state, draft, merged, base, HEAD SHA. The repository is bound to this session. Use instead of unauthenticated webfetch for private PRs.",
            input: { type: "object", properties: { number: { type: "integer", minimum: 1 } }, required: ["number"], additionalProperties: false },
            options: { codemode: false },
            async execute(input, context) {
              return { content: JSON.stringify(await runBound(context, { action: "pr_info", number: (input as {number:number}).number })) };
            }
          });
          editor.add({
            name: "repo_issue_info",
            description: "READ-ONLY: fetch one private issue's authoritative GitHub state and linked PR marker for the selected repository.",
            input: { type: "object", properties: { number: { type: "integer", minimum: 1 } }, required: ["number"], additionalProperties: false },
            options: { codemode: false },
            async execute(input, context) {
              return { content: JSON.stringify(await runBound(context, { action: "issue_info", number: (input as {number:number}).number })) };
            }
          });
          editor.add({
            name: "repo_pr_files",
            description: "READ-ONLY: bounded file list for one PR. Check possibleNextPage and request next page only if needed; this does not download full patches.",
            input: { type: "object", properties: { number: { type: "integer", minimum: 1 }, page: { type: "integer", minimum: 1, maximum: 100 } }, required: ["number"], additionalProperties: false },
            options: { codemode: false },
            async execute(input, context) {
              const p = input as {number:number;page?:number};
              return { content: JSON.stringify(await runBound(context, { action: "pr_files", number: p.number, ...(p.page===undefined?{}:{page:p.page}) })) };
            }
          });
          editor.add({
            name: "repo_pr_reviews",
            description: "READ-ONLY: bounded submitted review statuses for one PR; review submissions are not CI and do not imply merge approval.",
            input: { type: "object", properties: { number: { type: "integer", minimum: 1 }, page: { type: "integer", minimum: 1, maximum: 100 } }, required: ["number"], additionalProperties: false },
            options: { codemode: false },
            async execute(input, context) {
              const p = input as {number:number;page?:number};
              return { content: JSON.stringify(await runBound(context, { action: "pr_reviews", number: p.number, ...(p.page===undefined?{}:{page:p.page}) })) };
            }
          });
          editor.add({
            name: "repo_checks",
            description: "READ-ONLY: get GitHub status contexts and check runs for the exact 40-hex commit SHA (usually HEAD SHA from repo_pr_info). Does not prove deployment.",
            input: { type: "object", properties: { sha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" } }, required: ["sha"], additionalProperties: false },
            options: { codemode: false },
            async execute(input, context) {
              return { content: JSON.stringify(await runBound(context, { action: "pr_checks", sha: (input as {sha:string}).sha })) };
            }
          });
          editor.add({
            name: "repo_read",
            description: "READ FIRST when asked for a specific source file in the selected GitHub repository. Read its actual text using the authenticated GitHub API. Supply path only for the default branch (main); optionally supply ref for another branch/commit. Repository is bound to this session. This is NOT a local /bundle read. Never claim a file was read without a successful tool result.",
            input: {
              type: "object",
              properties: {
                path: { type: "string", description: "Repository-relative path, e.g. docs/opencode-g8/isolated-review-20261110.md" },
                ref: { type: "string", description: "Optional branch or commit; omit to read the repository default branch (normally main)" }
              },
              required: ["path"],
              additionalProperties: false
            },
            options: { codemode: false },
            async execute(input, context) {
              const p = input as { path: string; ref?: string };
              return { content: JSON.stringify(await runBound(context, { action: "read", path: p.path, ...(p.ref ? { ref: p.ref } : {}) })) };
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
              let boundProject = "";
              try { boundProject = await getBoundProject?.(context.sessionID) ?? ""; }
              catch { boundProject = ""; }
              const projectMcpRun = tool.name === "exec" && Boolean(boundProject);
              // Project sessions get the isolated read-only backend only;
              // the shared workspace backend stays behind the scope guard.
              if (scopeGuard && !projectMcpRun) {
                await scopeGuard(context.sessionID, { kind: "workspace-write" });
              }
              const runInput = projectMcpRun && typeof input === "object" && input !== null
                ? { ...(input as Record<string, unknown>), backend: "dynamic-mcp", cwd: undefined, env: undefined }
                : input;
              const { content, isError } = await execute(
                { id: context.id, name: tool.name, arguments: runInput },
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

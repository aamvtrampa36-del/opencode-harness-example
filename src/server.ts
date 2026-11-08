import { DurableObject } from "cloudflare:workers";
import { DevContainer } from "./dev-container";
export { DevContainer };
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { routeAgentRequest } from "agents";
import { OpenCodeHarness } from "agents/harness/opencode";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/opencode";
import { WebSockets } from "agents/websockets";
import { OpenCodeSessionSockets } from "./sockets";
import { workspacePlugin } from "./workspace";
import { openRouterCredentialPlugin } from "./openrouter";
import { MODEL_PRESETS } from "./model-presets";
import { GitHubBridge } from "./github";

export const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/** A playable OpenCode instance backed by one Durable Object. */
export class OpenCodeAgent extends DurableObject<Env> {
  // The optional secret is read only in the Worker runtime, never in React.
  private readonly openRouterKey = (this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
  private readonly githubToken = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN;
  private readonly github = this.githubToken ? new GitHubBridge(this.githubToken) : undefined;
  // Workers AI over the AI binding, as an OpenCode provider plugin.
  readonly ai = createAI({ binding: this.env.AI });
  // Files in the object's own storage. `exec` runs JavaScript in a Worker
  // Loader isolate with no network of its own. `git` turns on
  // `workspace.git`, which `codemode:git` uses to clone over HTTPS from the host.
  readonly workspace = new Workspace({
    // SAFETY: DurableObjectStorage has every member DurableObjectStorageLike
    // names; computer declares its own narrower type to avoid depending on
    // workers-types.
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    backends: [
      new CodemodeBackend({
        loader: this.env.LOADER,
        root: "/workspace",
        access: "read-write",
        modules: { "codemode:git": createGitModule({ allowNetwork: true }) }
      })
    ]
  });
  readonly linuxRunner = {
    run: (project: string, command: string) =>
      this.env.DEV.getByName("personal").run(project, command)
  };

  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) =>
      OpenCodeWorkerd.create({
        // The object's storage, with OpenCode's tables under `opencode_`.
        storage,
        config: { default_agent: "build" },
        // Native OpenRouter discovery is opt-in and only activated when
        // the private Cloudflare Secret is available.
        models: { fetch: Boolean(this.openRouterKey) },
        // OpenCode is silent unless given a log writer.
        log: {
          level: "warn",
          emit: (entry) =>
            console.warn(
              `opencode ${entry.level}: ${entry.message}`,
              entry.attributes,
              entry.cause
            )
        },
        plugins: [
          this.ai.plugin,
          ...(this.openRouterKey ? [openRouterCredentialPlugin(this.openRouterKey)] : []),
          workspacePlugin(this.workspace, {}, this.linuxRunner, this.github)
        ]
      }),
    // Low effort: with more, the model sometimes writes its whole answer
    // into its reasoning.
    defaults: {
      model: this.openRouterKey
        ? { providerID: MODEL_PRESETS.economy.providerID, id: MODEL_PRESETS.economy.id }
        : this.ai(MODEL_ID, { reasoningEffort: "low" }),
      agent: "build"
    }
  });

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new OpenCodeSessionSockets(
    this.harness,
    (tag) => this.ctx.getWebSockets(tag),
    Boolean(this.openRouterKey)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened OpenCode. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/dev/status" && request.method === "GET") {
        return Response.json(await env.DEV.getByName("personal").status(), {
          headers: { "Cache-Control": "no-store" }
        });
      }
      const downloadMatch = url.pathname.match(/^\/api\/dev\/download\/([a-z][a-z0-9-]{0,39})$/);
      if (downloadMatch) {
        if (request.method !== "GET") return new Response("GET only", { status: 405 });
        const project = downloadMatch[1];
        const file = await env.DEV.getByName("personal").download(project);
        const headers = new Headers(file.headers);
        headers.set("Content-Type", "application/gzip");
        headers.set("Content-Disposition", 'attachment; filename="' + project + '.tar.gz"');
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Cache-Control", "no-store");
        return new Response(file.body, { status: file.status, headers });
      }
      const previewMatch = url.pathname.match(/^\/api\/dev\/preview\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/);
      if (previewMatch) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("GET only", { status: 405 });
        }
        const project = previewMatch[1];
        const path = previewMatch[2] || "index.html";
        const result = await env.DEV.getByName("personal").preview(project, path);
        const headers = new Headers(result.headers);
        // A generated application must not inherit the authenticated
        // OpenCode origin or invoke /api/dev/run from its own scripts.
        // CSP sandbox applies even when a preview URL is opened directly.
        headers.set("Content-Security-Policy",
          "sandbox allow-scripts; default-src https: data: blob:; script-src https: 'unsafe-inline' blob: data:; style-src https: 'unsafe-inline'; connect-src https:; img-src https: data: blob:; font-src https: data:; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("Cache-Control", "no-store");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(request.method === "HEAD" ? null : result.body, {
          status: result.status,
          headers
        });
      }
      if (url.pathname === "/api/dev/run" && request.method === "POST") {
        // Cloudflare Access protects this same-origin endpoint. A third-party
        // website cannot drive the private container with a cross-site POST.
        if (request.headers.get("Origin") !== url.origin ||
            !request.headers.get("Content-Type")?.startsWith("application/json")) {
          return Response.json({ error: "Same-origin JSON request required" }, { status: 403 });
        }
        const body = await request.text();
        if (body.length > 16_000) {
          return Response.json({ error: "Request too large" }, { status: 413 });
        }
        const { project, command } = JSON.parse(body) as { project: string; command: string };
        return Response.json(await env.DEV.getByName("personal").run(project, command), {
          headers: { "Cache-Control": "no-store" }
        });
      }
      if (url.pathname === "/api/health") {
        return Response.json(
          {
            status: "ok",
            runtime: "workerd",
            openRouterConfigured: Boolean((env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY),
            githubConfigured: Boolean((env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN),
            features: {
              durableSessions: true,
              workspaceFiles: true,
              javascriptExec: true,
              gitClone: true,
              linuxShell: Boolean(env.DEV),
              npm: Boolean(env.DEV),
              githubWrite: false
            }
          },
          { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }
        );
      }
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("OpenCode playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;

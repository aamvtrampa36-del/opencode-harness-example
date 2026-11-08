import { DurableObject } from "cloudflare:workers";
import { PersonalSettings } from "./personal-settings";
export { PersonalSettings };
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

export const MODEL_ID = "@cf/openai/gpt-oss-20b";

/** A playable OpenCode instance backed by one Durable Object. */
export class OpenCodeAgent extends DurableObject<Env> {
  // Credentials are resolved server-side. All browsers share one owner config.
  private readonly personalConfig = this.env.SETTINGS.getByName("personal");
  private readonly providerConnection: {
    connect?: (key: string) => Promise<void>;
  } = {};
  private readonly githubRunner = {
    execute: async (input: Parameters<GitHubBridge["execute"]>[0]) => {
      const key = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN
        || await this.personalConfig.getGitHubKey();
      if (!key) throw new Error("Conecta GitHub desde Configuración para trabajar con repositorios privados.");
      return new GitHubBridge(key).execute(input);
    }
  };
  async isOpenRouterConfigured(): Promise<boolean> {
    const envKey = (this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
    return Boolean(envKey || await this.personalConfig.getOpenRouterKey());
  }
  async refreshOpenRouter(): Promise<{ active: boolean }> {
    const key = (this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY
      || await this.personalConfig.getOpenRouterKey();
    if (!key || !this.providerConnection.connect) return { active: false };
    await this.providerConnection.connect(key);
    return { active: true };
  }
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
        models: { fetch: true },
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
          openRouterCredentialPlugin(
            async () => (this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY
              || await this.personalConfig.getOpenRouterKey(),
            (connect) => { this.providerConnection.connect = connect; }
          ),
          workspacePlugin(this.workspace, {}, this.linuxRunner, this.githubRunner)
        ]
      }),
    // Low effort: with more, the model sometimes writes its whole answer
    // into its reasoning.
    defaults: {
      model: this.ai(MODEL_ID),
      agent: "build"
    }
  });

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new OpenCodeSessionSockets(
    this.harness,
    (tag) => this.ctx.getWebSockets(tag),
    () => this.isOpenRouterConfigured()
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Temporary synthetic acceptance test. Does not touch owner projects. */
  async runAgentAcceptanceOnce() {
    const existing = await this.ctx.storage.get<string>("acceptanceSession20261108");
    if (existing) return { status: "already-submitted", session: existing };
    const handle = await this.harness.sessions.create();
    await this.ctx.storage.put("acceptanceSession20261108", handle.id);
    await handle.setModel(this.ai(MODEL_ID));
    await handle.setAgent("build");
    const input =
      "Prueba real y económica de herramientas. En la herramienta linux ejecuta " +
      "EXACTAMENTE project=agent-verify-nov y command=\"printf 'agent-success' > proof.txt; " +
      "node -e 'const fs=require(\\\"fs\\\"); if(fs.readFileSync(\\\"proof.txt\\\",\\\"utf8\\\")!==\\\"agent-success\\\") process.exit(1); console.log(\\\"PASS_VERIFIED\\\")'\". " +
      "No escribas código en tu respuesta como sustituto. Llama a la herramienta y revisa exitCode; " +
      "solo si retorna 0 indica que tuvo éxito. No toques otros proyectos.";
    try {
      const receipt = await handle.submit(input);
      return { status: "submitted", session: handle.id, operation: receipt.operationId };
    } catch (error) {
      return { status: "submit-failed", session: handle.id, error: error instanceof Error ? error.message.slice(0,200) : "unknown" };
    }
  }

  async agentAcceptanceStatus() {
    const id = await this.ctx.storage.get<string>("acceptanceSession20261108");
    if (!id) return { status: "not-started" };
    const handle = this.harness.session(id);
    const [busy, history] = await Promise.all([handle.busy(), handle.history()]);
    const assistant = history.filter((m) => m.type === "assistant");
    const tools = assistant.flatMap((m) => m.content
      .filter((p) => p.type === "tool")
      .map((p) => ({
        name: p.name,
        status: p.state.status,
        result: p.state.status === "completed" ? JSON.stringify(p.state.output).slice(0,300) : undefined,
        error: p.state.status === "error" ? p.state.error.message.slice(0,300) : undefined
      })));
    const text = assistant.flatMap((m) => m.content
      .filter((p) => p.type === "text")
      .map((p) => p.text.slice(-280))).slice(-2);
    return { status: busy ? "running" : "idle", session: id,
      messages: history.length, assistantMessages: assistant.length, tools, text };
  }

  /** Host startup, after the harness has opened OpenCode. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const stub = env.OpenCodeAgent.getByName("acceptance-gptoss-nov08");
      const submission = await stub.runAgentAcceptanceOnce();
      console.log("OPENCODE_AGENT_ACCEPT_SUBMISSION", JSON.stringify(submission));
      const result = await stub.agentAcceptanceStatus();
      console.log("OPENCODE_AGENT_ACCEPT_RESULT", JSON.stringify(result));
    })());
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const personal = env.SETTINGS.getByName("personal");
      const settingsOriginAllowed =
        request.headers.get("Origin") === url.origin &&
        request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json");
      if (url.pathname === "/api/settings" && request.method === "GET") {
        const existing = await personal.status();
        return Response.json({
          ...existing,
          openRouterConfigured: existing.openRouterConfigured ||
            Boolean((env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY),
          githubConfigured: existing.githubConfigured ||
            Boolean((env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN)
        }, { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/settings/openrouter/usage" && request.method === "GET") {
        const usage = await personal.openRouterUsage();
        return Response.json({ usage }, { headers: { "Cache-Control": "no-store" } });
      }
      if ((url.pathname === "/api/settings/openrouter" ||
           url.pathname === "/api/settings/github") && request.method === "POST") {
        if (!settingsOriginAllowed) {
          return Response.json({ error: "Solicitud de origen no permitido." }, { status: 403 });
        }
        const raw = await request.text();
        if (raw.length > 1500) return Response.json({ error: "Solicitud demasiado grande." }, { status: 413 });
        const body = JSON.parse(raw) as { key?: string; workspace?: string };
        if (url.pathname.endsWith("/openrouter")) {
          const result = await personal.connectOpenRouter(body.key);
          // Apply to the currently open browser's host. Other hosts receive
          // the credential on their next OpenCode initialization.
          const workspace = body.workspace;
          let applied = false;
          if (workspace && /^[a-f0-9-]{36}$/i.test(workspace)) {
            try {
              const state = await env.OpenCodeAgent.getByName(workspace).refreshOpenRouter();
              applied = state.active;
            } catch {
              // Safe fallback: the next session host initialization connects it.
            }
          }
          return Response.json({ ...result, activeOnCurrentHost: applied },
            { headers: { "Cache-Control": "no-store" } });
        }
        return Response.json(await personal.connectGitHub(body.key),
          { headers: { "Cache-Control": "no-store" } });
      }
      if ((url.pathname === "/api/settings/openrouter" ||
           url.pathname === "/api/settings/github") && request.method === "DELETE") {
        // The UI labels removal as disconnecting from this app; the provider
        // key itself must be revoked upstream to prevent stale stored hosts.
        if (request.headers.get("Origin") !== url.origin) {
          return Response.json({ error: "Origen no permitido." }, { status: 403 });
        }
        if (url.pathname.endsWith("/openrouter")) {
          await personal.disconnectOpenRouter();
        } else {
          await personal.disconnectGitHub();
        }
        return Response.json({ configured: false, revokeAtProvider: true },
          { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/dev/projects" && request.method === "GET") {
        return Response.json({
          projects: await env.DEV.getByName("personal").listProjects()
        }, { headers: { "Cache-Control": "no-store" } });
      }
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
            openRouterConfigured: Boolean((env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY) || (await personal.status()).openRouterConfigured,
            githubConfigured: Boolean((env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN) || (await personal.status()).githubConfigured,
            features: {
              durableSessions: true,
              workspaceFiles: true,
              javascriptExec: true,
              gitClone: true,
              linuxShell: Boolean(env.DEV),
              npm: Boolean(env.DEV),
              githubWrite: Boolean((env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN) || (await personal.status()).githubConfigured
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

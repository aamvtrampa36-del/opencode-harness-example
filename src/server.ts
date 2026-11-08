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
import { remoteMcpPlugin } from "./mcp-plugin";
import { assessAgentToolEvidence } from "./agent-check";

export const MODEL_ID = "@cf/openai/gpt-oss-20b";

/** A playable OpenCode instance backed by one Durable Object. */
export class OpenCodeAgent extends DurableObject<Env> {
  // Credentials are resolved server-side. All browsers share one owner config.
  private readonly personalConfig = this.env.SETTINGS.getByName("personal");
  private readonly providerConnection: {
    connect?: (key: string) => Promise<void>;
  } = {};
  private readonly mcpLifecycle: { reload?: () => Promise<void> } = {};
  async refreshMcps(): Promise<{ refreshed: boolean }> {
    if (!this.mcpLifecycle.reload) return { refreshed: false };
    await this.mcpLifecycle.reload();
    return { refreshed: true };
  }
  private readonly githubRunner = {
    execute: async (input: Parameters<GitHubBridge["execute"]>[0]) => {
      const key = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN
        || await this.personalConfig.getGitHubKey();
      if (!key) throw new Error("Conecta GitHub desde Configuración para trabajar con repositorios privados.");
      return new GitHubBridge(key, fetch, await this.personalConfig.getAllowedRepositories()).execute(input);
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
  /** Explicit owner-initiated real-model/tool test, never a recurring cron. */
  async startAgentCheck(): Promise<{ status: string; session?: string; project?: string; message?: string }> {
    const previous = await this.ctx.storage.get<{
      session: string; project: string; token: string; startedAt: number; error?: string
    }>("agent-check-v1");
    if (previous) return { status: "existing", session: previous.session, project: previous.project };
    if (!(await this.personalConfig.reserveAgentCheck())) {
      return { status: "daily-limit", message: "Límite de dos verificaciones diarias para evitar gastos de IA" };
    }
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const project = "agent-check-" + token;
    const created = await this.harness.sessions.create();
    const state = { session: created.id, project, token, startedAt: Date.now() };
    await this.ctx.storage.put("agent-check-v1", state);
    try {
      const handle = this.harness.session(created.id);
      await handle.setAgent("build");
      await handle.setModel(this.ai(MODEL_ID));
      const command = "printf '" + token + "' > proof.txt && node -e " +
        JSON.stringify("const fs=require('node:fs');if(fs.readFileSync('proof.txt','utf8')!==" +
          JSON.stringify(token) + ")process.exit(2);console.log('AGENT_PROOF_OK:" + token + "')");
      const prompt = "Esta es una autoprueba REAL de herramientas, no una tarea de conversación. " +
        "Usa la herramienta linux con project=" + project + " y command=" +
        JSON.stringify(command) + ". Debes CREAR el archivo proof.txt en el Container y VERIFICARLO con Node. " +
        "No generes código solamente en tu respuesta. Espera el resultado real de linux " +
        "y describe su exitCode. No alteres ningún otro proyecto.";
      await handle.submit(prompt, { whenBusy: "followUp" });
      return { status: "started", session: created.id, project };
    } catch (error) {
      const failed = {
        ...state, error: error instanceof Error ? error.message.slice(0, 250) : "No se pudo iniciar"
      };
      await this.ctx.storage.put("agent-check-v1", failed);
      return { status: "failed", message: failed.error };
    }
  }

  async agentCheckStatus(): Promise<unknown> {
    const saved = await this.ctx.storage.get<{
      status: string; toolCalls: number; fileVerified: boolean; project: string; reason?: string
    }>("agent-check-result-v1");
    if (saved) return saved;
    const state = await this.ctx.storage.get<{
      session: string; project: string; token: string; startedAt: number; error?: string
    }>("agent-check-v1");
    if (!state) return { status: "not-started" };
    if (state.error) return { status: "failed", reason: state.error, project: state.project };
    const handle = this.harness.session(state.session);
    const [running, history] = await Promise.all([handle.busy(), handle.history()]);
    const evidence = assessAgentToolEvidence(history, state.project, state.token);
    if (running) return { status: "running", toolCalls: evidence.requestedTools, project: state.project };
    let fileVerified = false;
    if (evidence.correctLinuxResult) {
      try {
        const actual = await this.env.DEV.getByName("personal").inspect(state.project, "read", "proof.txt") as
          { contents?: string };
        fileVerified = actual.contents === state.token;
      } catch { /* An absent file or failed restore is NOT a successful test. */ }
    }
    const outcome = {
      status: evidence.correctLinuxResult && fileVerified ? "passed" : "failed",
      toolCalls: evidence.requestedTools,
      fileVerified, project: state.project,
      ...(!evidence.correctLinuxResult ? { reason: "OpenCode no devolvió una ejecución Linux verificada" } : {})
    };
    await this.ctx.storage.put("agent-check-result-v1", outcome);
    return outcome;
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
      this.env.DEV.getByName("personal").run(project, command),
    inspect: (project: string, action: "list" | "read", path: string) =>
      this.env.DEV.getByName("personal").inspect(project, action, path)
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
          remoteMcpPlugin(
            () => this.personalConfig.getRemoteMcps(),
            (reload) => { this.mcpLifecycle.reload = reload; }
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
    () => this.isOpenRouterConfigured(),
    (id: string) => this.personalConfig.getSpecialization(id)
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
      if (url.pathname === "/api/settings/mcp") {
        if (request.method === "GET") {
          return Response.json({ servers: await personal.listPublicMcps() },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST" || request.method === "DELETE") {
          if (!settingsOriginAllowed) return Response.json({ error: "Origin and JSON required" }, { status: 403 });
          const raw = await request.text();
          if (raw.length > 1_800) return Response.json({ error: "Request too large" }, { status: 413 });
          try {
            const body = JSON.parse(raw) as { id?: string; workspace?: string };
            const result = request.method === "POST"
              ? await personal.saveRemoteMcp(body)
              : await personal.removeRemoteMcp(body.id ?? "");
            let live = false;
            if (body.workspace && /^[a-f0-9-]{36}$/i.test(body.workspace)) {
              try {
                live = (await env.OpenCodeAgent.getByName(body.workspace).refreshMcps()).refreshed;
              } catch { /* Next session host initialization picks up settings. */ }
            }
            return Response.json({ ...(result ?? {}), refreshedCurrentHost: live },
              { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Invalid MCP request" },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/api/settings/specializations") {
        if (request.method === "GET") {
          return Response.json({ specializations: await personal.listSpecializations() },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST" || request.method === "DELETE") {
          if (!settingsOriginAllowed) return Response.json({ error: "Origin and JSON required" }, { status: 403 });
          const raw = await request.text();
          if (raw.length > 5_000) return Response.json({ error: "Request too large" }, { status: 413 });
          try {
            const body = JSON.parse(raw) as { id?: string };
            if (request.method === "POST") {
              return Response.json({ specialization: await personal.saveSpecialization(body) },
                { headers: { "Cache-Control": "no-store" } });
            }
            await personal.removeSpecialization(body.id ?? "");
            return Response.json({ removed: true }, { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Invalid specialization" },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/api/settings/repositories") {
        if (request.method === "GET") {
          return Response.json({ repositories: await personal.getAllowedRepositories() },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST" || request.method === "DELETE") {
          if (!settingsOriginAllowed) return Response.json({ error: "Origin and JSON required" }, { status: 403 });
          const raw = await request.text();
          if (raw.length > 600) return Response.json({ error: "Request too large" }, { status: 413 });
          const body = JSON.parse(raw) as { repository?: string };
          try {
            if (request.method === "POST") {
              const result = await personal.authorizeRepository(body.repository);
              return Response.json(result, { headers: { "Cache-Control": "no-store" } });
            }
            await personal.revokeRepository(body.repository);
            return Response.json({ removed: true }, { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Invalid repository" },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/api/dev/agent-check") {
        const workspace = request.method === "GET"
          ? url.searchParams.get("workspace")
          : (request.headers.get("Origin") === url.origin &&
             request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")
            ? ((await request.json()) as { workspace?: string }).workspace : null);
        if (!workspace || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(workspace)) {
          return Response.json({ error: "Se requiere un espacio autenticado válido" }, { status: 403 });
        }
        const host = env.OpenCodeAgent.getByName(workspace);
        if (request.method === "GET") {
          return Response.json(await host.agentCheckStatus(), { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST") {
          return Response.json(await host.startAgentCheck(), { headers: { "Cache-Control": "no-store" } });
        }
        return new Response("Method not allowed", { status: 405 });
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

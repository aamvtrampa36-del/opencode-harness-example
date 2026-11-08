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

  /**
   * One-time, model-driven Android app experiment. No public HTTP endpoint.
   * A scheduled event calls this only after deployment, and the durable
   * marker prevents repeatedly paying for inference.
   */
  async startAndroidDemoOnce() {
    const previous = await this.ctx.storage.get<string>("androidDemoSession20261108");
    if (previous) return { status: "existing", session: previous };
    const created = await this.harness.sessions.create();
    await this.ctx.storage.put("androidDemoSession20261108", created.id);
    const prompt = [
      "Eres OpenCode Cloud ejecutando una prueba REAL de desarrollo Android con tu modelo de IA.",
      "Crea una aplicacion Android de tareas, simple y SIN INTERNET, en el Linux tool, project=apk-tareas-demo.",
      "Usa Java y Gradle Groovy (NO Kotlin, NO Compose, NO Android SDK en este Container).",
      "Usa nombre Tareas Nube, applicationId com.example.tareasnube, minSdk 23, targetSdk/compileSdk 35.",
      "La app debe permitir AGREGAR tareas, marcarlas como COMPLETADAS, ELIMINAR y persistir localmente en SharedPreferences usando JSON.",
      "Interfaz Android programatica en MainActivity.java, sin dependencias de UI externas, sin permiso INTERNET.",
      "Genera: settings.gradle, build.gradle, gradle.properties, app/build.gradle, app/src/main/AndroidManifest.xml,",
      "app/src/main/java/com/example/tareasnube/MainActivity.java y al menos una clase de logica de tareas pura Java.",
      "Incluye app/src/test/java/com/example/tareasnube/TaskLogicTest.java con una prueba JUnit4 de logica sin Android runtime.",
      "Gradle Android plugin com.android.application 8.10.1, Google Maven/Maven Central; Java 17.",
      "Usa herramienta linux para crear los archivos de verdad con heredocs y verificar find/git status.",
      "NO necesitas instalar Gradle ni Android SDK ahora: GitHub Actions compilara la APK tras exportar el codigo.",
      "Trabaja SOLO en el proyecto apk-tareas-demo. No escribas en CDF, produccion ni otros repositorios.",
      "Reduce llamadas: usa una sola herramienta linux con un script bash si es viable.",
      "Tras guardar archivos, informa las rutas y los resultados observados. Si alguna herramienta falla, dilo.",
      "IMPORTANT: The code must be complete and buildable; use no secrets."
    ].join("\n");
    try {
      const receipt = await this.harness.session(created.id).submit(prompt, { whenBusy: "followUp" });
      await this.ctx.storage.put("androidDemoOperation20261108", receipt.operationId);
      return { status: "submitted", session: created.id, operation: receipt.operationId };
    } catch (error) {
      return { status: "submission-failed", session: created.id, error: error instanceof Error ? error.message.slice(0,250) : String(error).slice(0,250) };
    }
  }

  async androidDemoStatus() {
    const session = await this.ctx.storage.get<string>("androidDemoSession20261108");
    if (!session) return { status: "not-started" };
    const handle = this.harness.session(session);
    const [busy, messages] = await Promise.all([handle.busy(), handle.history()]);
    const assistants = messages.filter((m) => m.type === "assistant");
    const last = assistants.slice(-2).map((m) => ({
      error: m.error?.message?.slice(0,250) ?? null,
      completed: m.time.completed !== undefined,
      parts: m.content.map((p) => p.type === "tool"
        ? { kind: "tool", name: p.name, status: p.state.status,
          result: p.state.status === "error" ? p.state.error?.message?.slice(0,500) : undefined }
        : p.type === "text" ? { kind: "text", value: p.text.slice(-800) }
        : { kind: p.type })
    }));
    return { status: busy ? "running" : "idle", session, messageCount: messages.length, assistants: assistants.length, last };
  }

  /** Host startup, after the harness has opened OpenCode. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const agent = env.OpenCodeAgent.getByName("7c86f9c3-331d-418e-a58c-269cde16fc23");
      const started = await agent.startAndroidDemoOnce();
      console.log("ANDROID_AGENT_SUBMISSION_V1", JSON.stringify(started));
      const progress = await agent.androidDemoStatus();
      console.log("ANDROID_AGENT_STATUS_V1", JSON.stringify(progress));
    })());
  },
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
              githubWrite: Boolean((env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN)
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

import { SettingsPanel } from "./settings-panel";
import { MODEL_PRESETS, isModelPreset, type ModelPresetID } from "./model-presets";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  BrainIcon,
  CheckCircleIcon,
  CodeIcon,
  FilePlusIcon,
  GearIcon,
  GitBranchIcon,
  InfoIcon,
  ListIcon,
  LinkIcon,
  DownloadSimpleIcon,
  EyeIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  StopIcon,
  SunIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import type { OpenCodeMessage } from "agents/harness/opencode";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import {
  partTexts,
  useOpenCodeSession,
  type LiveText
} from "./use-opencode-session";
import "./styles.css";

const OBJECT_KEY = "opencode-harness-object";
const SESSION_KEY = "opencode-harness-session";
const ROOT_SESSION = "ses_root";
const MODEL_KEY = "opencode-model-preset";
const PROJECT_PREFIX = "opencode-active-project:";

const SUGGESTIONS = [
  {
    icon: <FilePlusIcon size={15} />,
    label: "Escribir borrador CDF",
    value: "Ayúdame a desarrollar un borrador narrativo NO CANÓNICO para Cenizas del Futuro. Primero pregunta por la escena; no cambies ninguna fuente oficial."
  },
  {
    icon: <CodeIcon size={15} />,
    label: "Explorar herramientas",
    value: "Explícame brevemente qué herramientas tienes disponibles ahora mismo para crear apps, ejecutar Linux, trabajar con archivos y usar GitHub. Distingue las que funcionan de las que necesitan configuración."
  },
  {
    icon: <GitBranchIcon size={15} />,
    label: "Revisar un proyecto",
    value: "Ayúdame a revisar un proyecto existente. Primero pídeme el repositorio o nombre de proyecto; analiza antes de modificar y no cambies producción."
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

type Assistant = Extract<OpenCodeMessage, { type: "assistant" }>;
type AssistantPart = Assistant["content"][number];
type ToolPart = Extract<AssistantPart, { type: "tool" }>;

/** Reuse this browser's existing Durable Object, or join one with an Access-protected link. */
function getObject(): string {
  const url = new URL(window.location.href);
  const linked = url.searchParams.get("object");
  // Only UUIDs may be accepted as session containers. Access still authenticates the user.
  if (linked && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(linked)) {
    const sharedSession = url.searchParams.get("session");
    const sharedProject = url.searchParams.get("project");
    if (sharedSession && /^ses[A-Za-z0-9_]{1,64}$/.test(sharedSession)) {
      localStorage.setItem(SESSION_KEY, sharedSession);
      if (sharedProject && /^[a-z][a-z0-9-]{0,39}$/.test(sharedProject)) {
        localStorage.setItem(PROJECT_PREFIX + sharedSession, sharedProject);
      }
    }
    localStorage.setItem(OBJECT_KEY, linked);
    url.searchParams.delete("object");
    url.searchParams.delete("session");
    url.searchParams.delete("project");
    window.history.replaceState(null, "", url);
    return linked;
  }
  const existing = localStorage.getItem(OBJECT_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(OBJECT_KEY, created);
  return created;
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Cambiar tema"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function Block({ value }: { value: unknown }) {
  return (
    <pre className="max-h-48 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function toolOutput(part: ToolPart): string {
  const state = part.state;
  if (state.status === "completed" || state.status === "error") {
    return (state.content ?? [])
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n");
  }
  return "";
}

function ToolCard({ part }: { part: ToolPart }) {
  const { status } = part.state;
  const output = toolOutput(part);
  const failed = status === "error";
  const done = status === "completed";
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {failed ? (
          <XCircleIcon size={14} className="text-kumo-danger" />
        ) : done ? (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        ) : (
          <GearIcon size={14} className="animate-spin text-kumo-inactive" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold">{part.name}</span>
          {output ? (
            <span className="ml-2 text-kumo-subtle">{output}</span>
          ) : null}
        </span>
        <Badge variant={failed ? "destructive" : "secondary"}>
          {failed ? "Error" : done ? "Terminado" : "En curso"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
            Input
          </p>
          <Block value={part.state.input} />
        </div>
        {output ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Output
            </p>
            <Block value={output} />
          </div>
        ) : null}
        {part.state.status === "error" ? (
          <Block value={part.state.error.message} />
        ) : null}
      </div>
    </details>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <Streamdown
      className="sd-theme text-sm leading-6"
      plugins={{ code }}
      controls={false}
    >
      {text}
    </Streamdown>
  );
}

function Reasoning({ text, open = false }: { text: string; open?: boolean }) {
  return (
    <details
      className="rounded-xl border border-kumo-line px-3 py-2"
      open={open}
    >
      <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
        Thinking
      </summary>
      <p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
        {text}
      </p>
    </details>
  );
}

function Avatar() {
  return (
    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
      <BrainIcon size={17} weight="bold" />
    </div>
  );
}

function AssistantMessage({
  message,
  live
}: {
  message: Assistant;
  live: LiveText | undefined;
}) {
  const streaming = message.time.completed === undefined;
  // A finished answer with nothing but reasoning: show it, or the turn
  // looks empty.
  const onlyReasoning =
    !streaming &&
    !message.content.some(
      (part) => part.type === "tool" || (part.type === "text" && part.text)
    );
  const texts = partTexts(live, message, "text");
  const reasonings = partTexts(live, message, "reasoning");
  const ordinals = { text: 0, reasoning: 0 };
  return (
    <div className="flex items-start gap-3">
      <Avatar />
      <div className="min-w-0 flex-1 space-y-3">
        {message.content.map((part, index) => {
          const key = `${message.id}-${index}`;
          switch (part.type) {
            case "text": {
              const text = texts[ordinals.text++] ?? "";
              return text ? <Markdown key={key} text={text} /> : null;
            }
            case "reasoning": {
              const text = reasonings[ordinals.reasoning++] ?? "";
              return text ? (
                <Reasoning key={key} text={text} open={onlyReasoning} />
              ) : null;
            }
            case "tool":
              return <ToolCard key={key} part={part} />;
          }
        })}
        {/* Parts still streaming that the snapshot does not have yet. */}
        {reasonings
          .slice(ordinals.reasoning)
          .map((text, index) =>
            text ? (
              <Reasoning key={`live-reasoning-${index}`} text={text} />
            ) : null
          )}
        {texts
          .slice(ordinals.text)
          .map((text, index) =>
            text ? <Markdown key={`live-text-${index}`} text={text} /> : null
          )}
        {streaming ? <span className="streaming-cursor" /> : null}
        {message.error ? (
          <div
            role="alert"
            className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {message.error.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Message({
  message,
  live
}: {
  message: OpenCodeMessage;
  live: Readonly<Record<string, LiveText>>;
}) {
  switch (message.type) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed text-kumo-inverse">
            {message.text}
          </div>
        </div>
      );
    case "assistant":
      return <AssistantMessage message={message} live={live[message.id]} />;
    case "synthetic":
      return (
        <p className="text-center text-xs text-kumo-inactive">
          {message.description ?? message.text}
        </p>
      );
    case "compaction":
      return (
        <p className="text-center text-xs text-kumo-inactive">
          {message.status === "running"
            ? "Resumiendo los mensajes anteriores…"
            : message.status === "failed"
              ? "No se pudieron resumir los mensajes anteriores"
              : "Se resumió el contexto anterior"}
        </p>
      );
    case "idle":
      return message.outcome === "succeeded" ? null : (
        <p className="text-center text-xs text-kumo-inactive">
          Ejecución: {message.outcome}
        </p>
      );
    default:
      return null;
  }
}

function App() {
  const [object] = useState(getObject);
  const [session, setSession] = useState(
    () => localStorage.getItem(SESSION_KEY) ?? ROOT_SESSION
  );
  const [prompt, setPrompt] = useState("");
  const [project, setProject] = useState(() => localStorage.getItem(PROJECT_PREFIX + (localStorage.getItem(SESSION_KEY) ?? ROOT_SESSION)) ?? "");
  const [linkCopied, setLinkCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [integrations, setIntegrations] = useState<{
    openRouterConfigured: boolean;
    githubConfigured: boolean;
  } | null>(null);
  const refreshIntegrations = async () => {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { openRouterConfigured?: boolean; githubConfigured?: boolean };
      setIntegrations({
        openRouterConfigured: Boolean(data.openRouterConfigured),
        githubConfigured: Boolean(data.githubConfigured)
      });
    } catch {
      // The chat continues when diagnostics are unavailable.
    }
  };
  useEffect(() => { void refreshIntegrations(); }, []);
  const [modelPreset, setModelPreset] = useState<ModelPresetID>(() => {
    const stored = localStorage.getItem(MODEL_KEY);
    return isModelPreset(stored) ? stored : "economy";
  });
  const [sessionsOpen, setSessionsOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const endRef = useRef<HTMLDivElement>(null);
  const {
    status,
    openRouterAvailable,
    messages,
    busy,
    pending,
    sessions,
    live,
    error,
    submit: submitPrompt,
    abort,
    create,
    fail
  } = useOpenCodeSession(object, session, () => {
    // A session this object does not have, such as one from an old
    // deployment: fall back to the root session.
    localStorage.setItem(SESSION_KEY, ROOT_SESSION);
    setSession(ROOT_SESSION);
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, busy]);

  const exportSession = () => {
    const data = { format: "opencode-harness-session-v1", exportedAt: new Date().toISOString(), session, messages };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const objectURL = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectURL;
    anchor.download = `opencode-session-${session}.json`;
    anchor.click();
    URL.revokeObjectURL(objectURL);
  };

  const connected = status === "open";
  const queued = pending.filter((operation) => operation.status === "queued");

  const choose = (next: string) => {
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
    setProject(localStorage.getItem(PROJECT_PREFIX + next) ?? "");
  };
  /** One guided new-project entrypoint for web and native Android work. */
  const startNewApp = (kind: "web" | "android" = "web") => {
    create().then((next) => {
      const slug = (kind === "android" ? "apk-" : "app-") + Date.now().toString(36);
      choose(next);
      localStorage.setItem(PROJECT_PREFIX + next, slug);
      setProject(slug);
      setPrompt(kind === "android" ?
        "Crea una app Android nativa para esta idea: [describe aquí tu app]. " +
        "Usa la herramienta linux con project=" + slug + ". " +
        "Genera los archivos Android completos en Java y Gradle, incluidas pruebas. " +
        "Prefiere funcionamiento offline y almacenamiento local. " +
        "No presupongas que Android SDK o Gradle están instalados en el Container. " +
        "Para crear una APK utiliza el flujo GitHub Actions android-apk.yml del repositorio autorizado cuando tengas la herramienta github conectada. " +
        "Si no puedes publicar a GitHub, deja el proyecto en Linux para descargarlo, indica el paso pendiente y no afirmes haber creado una APK. " +
        "No modifiques servicios de producción."
        :
        "Crea una aplicación web a partir de esta idea: [describe aquí tu app]. " +
        "Usa la herramienta linux con project=" + slug + " para crear archivos, instalar dependencias, " +
        "probar el código, corregir errores y compilar una versión de producción. " +
        "Usa rutas relativas para recursos (por ejemplo Vite base='./'). " +
        "La vista previa debe quedar en una carpeta dist/ con index.html. " +
        "No modifiques producción ni otros proyectos. Explica brevemente el resultado y las pruebas."
      );
    }, fail);
  };


  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    submitPrompt(text, whenBusy, openRouterAvailable ? modelPreset : "cloudflare");
  };

  // Live text for an assistant message no snapshot has yet.
  const unseen = Object.entries(live).filter(
    ([id]) => !messages.some((message) => message.id === id)
  );
  const visible = messages.filter(
    (message) => message.type !== "idle" || message.outcome !== "succeeded"
  );
  const empty = visible.length === 0 && unseen.length === 0 && !busy;
  const waiting =
    busy &&
    unseen.length === 0 &&
    !messages.some(
      (message) =>
        message.type === "assistant" && message.time.completed === undefined
    );

  return (
    <div
      className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        sessionsOpen
          ? "lg:grid-cols-[minmax(220px,18vw)_minmax(520px,1fr)]"
          : "grid-cols-1"
      }`}
    >
      {sessionsOpen ? (
        <aside
          className="flex min-h-0 flex-col border-r border-kumo-line bg-kumo-base"
          aria-label="Conversaciones"
        >
          <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
            <span className="text-sm font-semibold">Conversaciones</span>
            <Button
              variant="ghost"
              shape="square"
              aria-label="Nueva conversación"
              disabled={!connected}
              onClick={() => {
                create().then(choose, fail);
              }}
              icon={<PlusIcon size={16} />}
            />
          </div>
          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {sessions.map((info) => (
              <button
                type="button"
                key={info.id}
                onClick={() => choose(info.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${
                  info.id === session
                    ? "bg-kumo-elevated font-semibold"
                    : "hover:bg-kumo-elevated"
                }`}
              >
                {info.busy ? (
                  <GearIcon size={12} className="animate-spin" />
                ) : (
                  <span className="size-3" />
                )}
                <span className="truncate">
                  {info.title ??
                    (info.id === ROOT_SESSION ? "Principal" : info.id.slice(-10))}
                </span>
                {info.parent ? (
                  <span className="text-kumo-inactive">derivada</span>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="border-t border-kumo-line p-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!connected}
              onClick={exportSession}
              aria-label="Exportar conversación actual como copia local"
            >
              <DownloadSimpleIcon size={16} />
              Exportar sesión
            </Button>
          </div>
        </aside>
      ) : null}

      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex min-h-[68px] max-w-3xl flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                shape="square"
                aria-label="Conversaciones"
                aria-expanded={sessionsOpen}
                onClick={() => setSessionsOpen((open) => !open)}
                icon={<ListIcon size={16} />}
              />
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">
                  OpenCode Cloud
                </h1>
                <p className="truncate text-xs text-kumo-subtle">
                  Sesión <code>{session}</code>
                </p>
              </div>
            </div>
            <div className="flex w-full min-w-0 items-center gap-1.5 overflow-x-auto pb-1 sm:w-auto sm:shrink-0 sm:pb-0">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!connected}
                onClick={() => startNewApp("web")}
                aria-label="Crear nueva aplicación"
                title="Crea una sesión nueva y redacta tu idea de aplicación"
              >
                <PlusIcon size={14} />
                <span className="hidden sm:inline">Crear app</span>
              </Button>
              {project ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title={"Ver versión compilada del proyecto " + project}
                  aria-label="Vista previa de la aplicación"
                  onClick={() => window.open(
                    "/api/dev/preview/" + project + "/dist/",
                    "_blank",
                    "noopener,noreferrer"
                  )}
                >
                  <EyeIcon size={16} />
                  <span className="hidden sm:inline">Ver app</span>
                </Button>
              ) : null}
              {project ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title={"Descargar archivos del proyecto " + project}
                  aria-label="Descargar proyecto"
                  onClick={() => window.open(
                    "/api/dev/download/" + project,
                    "_blank",
                    "noopener,noreferrer"
                  )}
                >
                  <DownloadSimpleIcon size={16} />
                  <span className="hidden sm:inline">Descargar</span>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Copiar vínculo de mi espacio de trabajo"
                title="Copia un enlace para abrir este mismo espacio de trabajo desde otro dispositivo. Requiere tu inicio de sesión de Cloudflare Access."
                onClick={() => {
                  const shared = new URL(window.location.origin);
                  shared.searchParams.set("object", object);
                  shared.searchParams.set("session", session);
                  if (project) shared.searchParams.set("project", project);
                  navigator.clipboard.writeText(shared.toString())
                    .then(() => setLinkCopied(true))
                    .catch(() => setLinkCopied(false));
                }}
              >
                <LinkIcon size={16} />
                <span className="hidden sm:inline">{linkCopied ? "Copiado" : "Vincular"}</span>
              </Button>
              <select
                aria-label="Modelo de IA"
                title={openRouterAvailable ? "Seleccionar modelo" : "Conecta OpenRouter desde Configuración"}
                value={openRouterAvailable ? modelPreset : "cloudflare"}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  if (!isModelPreset(next)) return;
                  setModelPreset(next);
                  localStorage.setItem(MODEL_KEY, next);
                }}
                className="max-w-[152px] rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-xs text-kumo-default sm:max-w-[240px]"
              >
                {Object.entries(MODEL_PRESETS).map(([id, preset]) => (
                  <option
                    key={id}
                    value={id}
                    disabled={preset.providerID === "openrouter" && !openRouterAvailable}
                  >
                    {preset.label}{preset.tier === "premium" ? " ($$)" : ""}
                  </option>
                ))}
              </select>
              <Button type="button" variant="ghost" size="sm"
                aria-label="Configurar conexiones y modelos"
                title="OpenRouter, GitHub y presupuesto"
                onClick={() => setSettingsOpen(open => !open)}>
                <GearIcon size={17} />
                <span className="hidden sm:inline">Configurar</span>
              </Button>
              <Badge variant={connected ? "success" : "secondary"}>
                {connected
                  ? "En línea"
                  : status === "connecting"
                    ? "Conectando"
                    : "Reconectando"}
              </Badge>
              <ModeToggle />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            {settingsOpen ? (
              <SettingsPanel workspace={object} onClose={() => setSettingsOpen(false)}
                onChanged={() => { void refreshIntegrations(); }} />
            ) : null}
            <Surface className="rounded-xl p-3 ring ring-kumo-line">
              <div className="flex gap-3">
                <InfoIcon size={18} weight="bold" className="mt-0.5 shrink-0 text-kumo-accent" />
                <div className="min-w-0 space-y-1">
                  <Text size="sm" bold>Tu espacio de desarrollo</Text>
                  <p className="text-xs text-kumo-subtle">
                    Crea aplicaciones con Linux, consulta conversaciones anteriores o prepara borradores narrativos.
                    Los proyectos pueden descargarse; las copias automáticas externas aún no están configuradas.
                  </p>
                  {integrations ? (
                    <p className="text-xs text-kumo-subtle">
                      OpenRouter: {integrations.openRouterConfigured ? "configurado" : "pendiente"} ·
                      GitHub: {integrations.githubConfigured ? "configurado" : "pendiente"}.
                      {(!integrations.openRouterConfigured || !integrations.githubConfigured) ? (
                        <> <button className="underline" type="button" onClick={() => setSettingsOpen(true)}>Conectar desde aquí</button></>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              </div>
            </Surface>

            {empty ? (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<BrainIcon size={32} />}
                  title="¿Qué te gustaría crear?"
                  description="Describe una aplicación, trabaja sobre un proyecto o prepara una escena de CDF."
                />
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<CodeIcon size={15} />}
                    disabled={!connected}
                    onClick={() => startNewApp("android")}
                  >
                    Crear APK Android
                  </Button>
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion.label}
                      variant="secondary"
                      size="sm"
                      icon={suggestion.icon}
                      disabled={!connected}
                      onClick={() => setPrompt(suggestion.value)}
                    >
                      {suggestion.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {visible.map((message) => (
              <Message key={message.id} message={message} live={live} />
            ))}

            {unseen.map(([id, text]) => (
              <div key={id} className="flex items-start gap-3">
                <Avatar />
                <div className="min-w-0 flex-1 space-y-3">
                  {partTexts(text, undefined, "reasoning").map((part, index) =>
                    part ? <Reasoning key={`r-${index}`} text={part} /> : null
                  )}
                  {partTexts(text, undefined, "text").map((part, index) =>
                    part ? <Markdown key={`t-${index}`} text={part} /> : null
                  )}
                  <span className="streaming-cursor" />
                </div>
              </div>
            ))}

            {waiting ? (
              <div className="flex items-start gap-3">
                <Avatar />
                <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
                  <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                    <GearIcon size={15} className="animate-spin" />
                    El modelo está trabajando
                  </div>
                </Surface>
              </div>
            ) : null}

            {queued.length > 0 ? (
              <p className="ml-11 text-xs text-kumo-subtle">
                {queued.length} mensajes en espera
              </p>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
              >
                {error}
              </div>
            ) : null}

            <div ref={endRef} />
          </div>
        </main>

        <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="mx-auto max-w-3xl px-5 pt-4"
          >
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
              <InputArea
                value={prompt}
                onValueChange={setPrompt}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  busy
                    ? "Escribe una instrucción para continuar la tarea"
                    : "Describe qué quieres hacer con OpenCode"
                }
                aria-label="Escribir a OpenCode"
                disabled={!connected}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              {busy ? (
                <div className="mb-0.5 flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Intervenir en tarea"
                    disabled={prompt.trim() === ""}
                    onClick={() => submit("steer")}
                  >
                    Steer
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Detener"
                    onClick={abort}
                    icon={<StopIcon size={18} weight="fill" />}
                  />
                </div>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Enviar mensaje"
                  disabled={!connected || prompt.trim() === ""}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
          <div className="flex items-center justify-center gap-2 px-5 py-3">
            <span className="hidden text-[10px] text-kumo-inactive sm:inline">
              Enter para enviar · Shift+Enter para salto de línea
            </span>
            <span className="hidden text-kumo-line sm:inline">·</span>
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </section>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);

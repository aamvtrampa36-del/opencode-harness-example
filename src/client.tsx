import type { AgentMode } from "./protocol";
import { readSessionMode, saveSessionMode } from "./session-mode";
import { isInternalReminder } from "./message-display";
import { repositoryProjectSlug } from "./project-container";
import { SettingsPanel } from "./settings-panel";
import { MODEL_PRESETS, isModelPreset, type ModelPresetID } from "./model-presets";
import type { Specialization } from "./specializations";
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
const SPECIALIZATION_KEY = "opencode-specialization";
const REPOSITORY_PREFIX = "opencode-session-repository:";

const SUGGESTIONS = [
  {
    icon: <FilePlusIcon size={15} />,
    label: "Escribir borrador",
    value: "Ayúdame a preparar un borrador de texto. Pregunta el tema y el propósito antes de escribir; no sobrescribas fuentes oficiales."
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
  saveSessionMode(localStorage, created, ROOT_SESSION, "build");
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
    case "synthetic": {
      const text = message.description ?? message.text;
      if (isInternalReminder(text)) return null;
      return <p className="text-center text-xs text-kumo-inactive">{text}</p>;
    }
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
  const [repository, setRepository] = useState(() =>
    localStorage.getItem(REPOSITORY_PREFIX + (localStorage.getItem(SESSION_KEY) ?? ROOT_SESSION)) ?? "");
  const [authorizedRepos, setAuthorizedRepos] = useState<string[]>([]);
  const [g8Busy, setG8Busy] = useState(false);
  const [isolationBusy, setIsolationBusy] = useState(false);
  const [isolationResult, setIsolationResult] = useState("");
  const [importProbeBusy, setImportProbeBusy] = useState(false);
  const [importProbeResult, setImportProbeResult] = useState("");
  const [isolatedBackupBusy, setIsolatedBackupBusy] = useState(false);
  const [isolatedBackupResult, setIsolatedBackupResult] = useState("");
  const [g8Result, setG8Result] = useState("");
  const [g8LiveStatus, setG8LiveStatus] = useState("not-started");
  const [g8LiveMessage, setG8LiveMessage] = useState("");
  const [g8LiveBusy, setG8LiveBusy] = useState(false);
  const [g9Status, setG9Status] = useState("not-started");
  const [g9Busy, setG9Busy] = useState(false);
  const [g9Message, setG9Message] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<{ name: string; lastUsedAt: number }[]>([]);
  const [projectError, setProjectError] = useState("");
  const [savedBackups, setSavedBackups] = useState<{ project: string; createdAt: string; bytes: number }[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [projectReview, setProjectReview] = useState<{ project: string; output: string } | null>(null);
  const [lastCost, setLastCost] = useState("No hay una medición individual disponible.");
  const [restoreFrom, setRestoreFrom] = useState("");
  const [restoreTo, setRestoreTo] = useState("");
  const [agentMode, setAgentMode] = useState<AgentMode>(() => readSessionMode(localStorage, object, session));
  const setModeForSession = (targetSession: string, mode: AgentMode) => {
    saveSessionMode(localStorage, object, targetSession, mode);
    setAgentMode(mode);
  };
  const [specializations, setSpecializations] = useState<Specialization[]>([]);
  const [specialization, setSpecialization] = useState(() => localStorage.getItem(SPECIALIZATION_KEY) ?? "");
  const [integrations, setIntegrations] = useState<{
    openRouterConfigured: boolean;
    githubConfigured: boolean;
  } | null>(null);
  const refreshSpecializations = async () => {
    try {
      const response = await fetch("/api/settings/specializations", { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json() as { specializations?: Specialization[] };
      setSpecializations((result.specializations ?? []).filter(item => item.enabled));
    } catch { /* Optional profiles do not prevent normal development. */ }
  };
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
  useEffect(() => {
    void refreshIntegrations(); void refreshSpecializations();
    void fetch("/api/settings/repositories", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("GitHub repos unavailable");
        return response.json() as Promise<{ repositories?: string[] }>;
      })
      .then(data => setAuthorizedRepos(data.repositories ?? []))
      .catch(() => setAuthorizedRepos([]));
  }, []);
  const [modelPreset, setModelPreset] = useState<ModelPresetID>(() => {
    const stored = localStorage.getItem(MODEL_KEY);
    return isModelPreset(stored) ? stored : "economy";
  });
  const [sessionsOpen, setSessionsOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const endRef = useRef<HTMLDivElement>(null);
  const pendingUsage = useRef<{ session: string; project: string; base: number } | null>(null);
  const wasBusy = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (projectsOpen) mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [projectsOpen]);
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
    setAgentMode(readSessionMode(localStorage, object, ROOT_SESSION));
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, busy]);

  useEffect(() => {
    // OpenRouter reports account/key usage, not a session invoice. This delta
    // is an estimate only and may include other simultaneous requests.
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const baseline = pendingUsage.current;
    pendingUsage.current = null;
    if (!baseline || baseline.session !== session) return;
    void fetch("/api/settings/openrouter/usage", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("usage-unavailable");
        const body = await response.json() as { usage?: { usage?: number } };
        const total = body.usage?.usage;
        if (typeof total !== "number" || !Number.isFinite(total) || total < baseline.base) {
          throw new Error("usage-unavailable");
        }
        setLastCost("Variación aproximada de la cuenta OpenRouter: $" +
          (total - baseline.base).toFixed(4) +
          " USD; incluye otras sesiones si estuvieron activas.");
      })
      .catch(() => setLastCost("El proveedor no devolvió una variación verificable de consumo."));
  }, [busy, session]);


  const connected = status === "open";
  const queued = pending.filter((operation) => operation.status === "queued");
  const toolsObserved = messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.filter((part): part is ToolPart => part.type === "tool")
      : []
  );
  const toolsCompleted = toolsObserved.filter((part) => part.state.status === "completed").length;
  const toolsFailed = toolsObserved.filter((part) => part.state.status === "error").length;

  const choose = (next: string) => {
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
    setAgentMode(readSessionMode(localStorage, object, next));
    setProject(localStorage.getItem(PROJECT_PREFIX + next) ?? "");
    setRepository(localStorage.getItem(REPOSITORY_PREFIX + next) ?? "");
    // On narrow screens the conversation list is an overlay, not a second grid row.
    if (window.matchMedia("(max-width: 1099px)").matches) setSessionsOpen(false);
  };
  const loadProjects = async () => {
    try {
      const response = await fetch("/api/dev/projects", { cache: "no-store" });
      if (!response.ok) throw new Error("No se pudieron consultar los proyectos.");
      const result = await response.json() as {
        projects?: { name: string; lastUsedAt: number }[];
      };
      setAvailableProjects(result.projects ?? []);
      const backups = await fetch("/api/dev/backups", { cache: "no-store" });
      if (backups.ok) {
        const saved = await backups.json() as { backups?: { project: string; createdAt: string; bytes: number }[] };
        setSavedBackups(saved.backups ?? []);
      }
      setProjectError("");
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Error consultando proyectos.");
    }
  };
  const saveProjectBackup = async (name: string) => {
    setBackupBusy(true);
    setProjectError("");
    try {
      const response = await fetch("/api/dev/backup/" + encodeURIComponent(name), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(name === project ? { sessionRef: session } : {})
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "No se pudo guardar el respaldo");
      await loadProjects();
      setProjectError("Respaldo recuperable guardado en Cloudflare para " + name + ".");
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "No se pudo guardar el respaldo");
    } finally {
      setBackupBusy(false);
    }
  };
  /** G5: recover a saved project through the existing non-destructive G4 API. */
  const restoreProject = async () => {
    const source = restoreFrom || savedBackups[0]?.project;
    const target = restoreTo.trim();
    if (!source || !savedBackups.some((item) => item.project === source)) {
      setProjectError("Selecciona un respaldo guardado."); return;
    }
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(target)) {
      setProjectError("Usa un nombre nuevo de 1 a 40 caracteres: minúsculas, números y guiones; empieza con letra.");
      return;
    }
    if (availableProjects.some((item) => item.name === target)) {
      setProjectError("Ese proyecto ya existe. La restauración nunca sobrescribe archivos.");
      return;
    }
    setBackupBusy(true);
    setProjectError("");
    try {
      const response = await fetch("/api/dev/restore/" + encodeURIComponent(source), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "La restauración falló.");
      await loadProjects();
      localStorage.setItem(PROJECT_PREFIX + session, target);
      setProject(target);
      setRestoreTo("");
      setProjectError("Restaurado como " + target + ". Revisa los archivos y ejecuta sus pruebas antes de continuar.");
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "No se pudo restaurar el respaldo.");
    } finally {
      setBackupBusy(false);
    }
  };
  /** Owner-triggered, read-only Git review. No extra executor or server API. */
  const reviewChanges = async (name: string) => {
    setReviewBusy(true);
    setProjectError("");
    setProjectReview(null);
    try {
      const response = await fetch("/api/dev/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: name })
      });
      const result = await response.json() as {
        exitCode?: number | null; stdout?: string; stderr?: string; error?: string
      };
      if (!response.ok || result.exitCode !== 0) {
        throw new Error(result.error ?? result.stderr ?? "No se pudo revisar el proyecto.");
      }
      setProjectReview({ project: name, output: result.stdout || "No hay cambios locales registrados." });
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "No se pudieron consultar los archivos.");
    } finally {
      setReviewBusy(false);
    }
  };
  const chooseProject = (name: string) => {
    localStorage.setItem(PROJECT_PREFIX + session, name);
    setProject(name);
    setProjectsOpen(false);
  };
  /** Each GitHub repository receives its own new session and Linux project. */
  /** Tests both real GitHub draft PRs without changes, model calls or new branches. */
  const verifyG8 = async () => {
    setG8Busy(true);
    setG8Result("");
    try {
      const response = await fetch("/api/dev/g8-verify", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      const data = await response.json() as {
        status?: string; error?: string;
        results?: { repo: string; pr: number; passed: boolean }[]
      };
      if (!response.ok || data.status !== "passed" || data.results?.length !== 2) {
        throw new Error(data.error ?? "No se pudieron verificar ambos repositorios");
      }
      setG8Result("Verificados los dos diffs de GitHub; esta revisión no comprueba el aislamiento de Linux.");
    } catch (error) {
      setG8Result("G8 pendiente: " + (error instanceof Error ? error.message : "Error al comprobar el acceso"));
    } finally {
      setG8Busy(false);
    }
  };
  const verifyContainerIsolation = async () => {
    setIsolationBusy(true);
    setIsolationResult("");
    try {
      const response = await fetch("/api/dev/isolation-probe", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      const result = await response.json() as { passed?: boolean; error?: string };
      if (!response.ok || !result.passed) throw new Error(result.error ?? "Prueba incompleta");
      setIsolationResult("Prueba superada: dos Containers sintéticos no compartieron archivos. El shell sigue pausado hasta terminar las demás verificaciones.");
    } catch (error) {
      setIsolationResult("No se comprobó el aislamiento: " + (error instanceof Error ? error.message : "Error"));
    } finally {
      setIsolationBusy(false);
    }
  };
  const verifyRepositoryImport = async () => {
    setImportProbeBusy(true);
    setImportProbeResult("");
    try {
      const response = await fetch("/api/dev/repository-import-probe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object, session })
      });
      const result = await response.json() as {
        receipt?: { repository: string; commit: string; files: number }; error?: string
      };
      if (!response.ok || !result.receipt) throw Error(result.error ?? "Importación incompleta");
      setImportProbeResult("Importado en un Container de prueba: " + result.receipt.repository +
        " · commit " + result.receipt.commit.slice(0, 12) + " · " + result.receipt.files + " archivos.");
    } catch (error) {
      setImportProbeResult("No se completó la importación: " + (error instanceof Error ? error.message : "Error"));
    } finally { setImportProbeBusy(false); }
  };
  const verifyIsolatedBackup = async () => {
    setIsolatedBackupBusy(true);
    setIsolatedBackupResult("");
    try {
      const response = await fetch("/api/dev/isolated-backup-probe", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      const result = await response.json() as { passed?: boolean; error?: string };
      if (!response.ok || !result.passed) throw Error(result.error ?? "Prueba incompleta");
      setIsolatedBackupResult("Respaldo y restauración verificados entre dos Containers de prueba.");
    } catch (error) {
      setIsolatedBackupResult("No se verificó la restauración: " + (error instanceof Error ? error.message : "Error"));
    } finally { setIsolatedBackupBusy(false); }
  };
  /** One explicit tap runs two cheap, real, read-only agent sessions on staging. */
  const fetchG8LiveStatus = async () => {
    const response = await fetch("/api/dev/g8-agent-check?object=" + encodeURIComponent(object),
      { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo consultar la prueba del agente");
    const data = await response.json() as {
      status?: string; reason?: string;
      results?: {repo: string;status: string;reason: string;toolCalls: number}[];
    };
    const current = data.status ?? "not-started";
    setG8LiveStatus(current);
    if (current === "passed") {
      setG8LiveMessage("G8 verificado: ambos agentes reales ejecutaron repo_review, devolvieron los diffs correctos y no modificaron archivos.");
    } else if (current === "failed") {
      setG8LiveMessage("G8 pendiente: " + (data.results?.filter(x=>x.status==="failed")
        .map(x=>x.repo.split("/")[1] + ": " + x.reason).join("; ") || data.reason || "No se completó la prueba real"));
    } else if (current === "running") {
      setG8LiveMessage("Comprobando dos repositorios con el modelo real (solo lectura). " +
        (data.results?.filter(x=>x.status === "passed").length ?? 0) + " de 2 revisiones completadas.");
    }
    return data;
  };
  const startG8Live = async () => {
    setG8LiveBusy(true);
    setG8LiveMessage("");
    try {
      const response = await fetch("/api/dev/g8-agent-check?object=" + encodeURIComponent(object), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      const result = await response.json() as {status?:string;message?:string;error?:string};
      if (!response.ok || result.status === "rejected" || result.status === "failed") {
        throw new Error(result.message ?? result.error ?? "No se pudo iniciar G8");
      }
      await fetchG8LiveStatus();
    } catch (error) {
      setG8LiveMessage("G8 pendiente: " + (error instanceof Error ? error.message : "Error iniciando la prueba"));
    } finally {
      setG8LiveBusy(false);
    }
  };
  useEffect(() => {
    void fetchG8LiveStatus().catch(() => undefined);
  }, [object]);
  useEffect(() => {
    if (g8LiveStatus !== "running") return;
    const poll = window.setInterval(() => {
      void fetchG8LiveStatus().catch(err =>
        setG8LiveMessage("No se pudo consultar el progreso: " + String(err)));
    }, 3500);
    return () => window.clearInterval(poll);
  }, [object, g8LiveStatus]);
  /** One explicit owner action starts a real, isolated selfdevelopment PR. */
  const fetchG9Status = async () => {
    const response=await fetch("/api/dev/g9-selfdev?object="+encodeURIComponent(object),
      {cache:"no-store"});
    if(!response.ok) throw new Error("No se pudo consultar G9");
    const data=await response.json() as {
      status?:string;reason?:string;session?:string;branch?:string;
      toolCalls?:number;result?:{prUrl?:string;toolCalls?:number;failedTools?:number}
    };
    setG9Status(data.status ?? "not-started");
    if(data.status==="passed"){
      setG9Message("Desarrollo autónomo G9 aprobado: arreglo, prueba roja→verde, commit, diff, PR borrador y verificación independiente. " +
        (data.result?.prUrl ?? ""));
    }else if(data.status==="failed"){
      setG9Message("G9 pendiente: "+(data.reason ?? "No se completó la prueba independiente."));
    }else if(data.status==="running"){
      setG9Message("G9 en prueba de desarrollo aislado: "+
        (data.toolCalls ?? 0)+" llamadas de herramienta observadas.");
    }
    return data;
  };
  const startG9 = async () => {
    setG9Busy(true);
    setG9Message("");
    try{
      const response=await fetch("/api/dev/g9-selfdev?object="+encodeURIComponent(object),{
        method:"POST",headers:{"Content-Type":"application/json"},body:"{}"
      });
      const result=await response.json() as {status?:string;reason?:string;error?:string};
      if(!response.ok || result.status==="rejected" || result.status==="failed"){
        throw new Error(result.reason ?? result.error ?? "No se pudo iniciar G9");
      }
      await fetchG9Status();
    }catch(error){
      setG9Message("G9 pendiente: "+(error instanceof Error ? error.message : "Error desconocido"));
    }finally{
      setG9Busy(false);
    }
  };
  useEffect(() => {
    void fetchG9Status().catch(()=>undefined);
  },[object]);
  useEffect(() => {
    if(g9Status!=="running")return;
    const timer=window.setInterval(()=>{
      void fetchG9Status().catch(err=>setG9Message("Error leyendo estado G9: "+String(err)));
    },3500);
    return ()=>window.clearInterval(timer);
  },[object,g9Status]);
  const selectRepository = (repo: string) => {
    if (!repo || !authorizedRepos.includes(repo)) {
      setProjectError("Elige un repositorio autorizado en Configuración.");
      return;
    }
    const slug = repositoryProjectSlug(repo);
    create().then(next => {
      choose(next);
      localStorage.setItem(PROJECT_PREFIX + next, slug);
      localStorage.setItem(REPOSITORY_PREFIX + next, repo);
      setProject(slug);
      setRepository(repo);
      setProjectsOpen(false);
      setProjectError("");
      setModeForSession(next, "review");
      // Start project reviews without carrying another task's saved template.
      setSpecialization("");
      localStorage.setItem(SPECIALIZATION_KEY, "");
      const branch = repo.toLowerCase() === "aamvtrampa36-del/cdf-cloud-engine"
        ? "opencode/g8-cdf-isolation-20261110"
        : repo.toLowerCase() === "aamvtrampa36-del/cdf-workbench-"
          ? "opencode/g8-workbench-isolation-20261110" : "";
      setPrompt(branch
        ? "Usa exclusivamente la herramienta repo_review con branch '" + branch +
          "'. El repositorio ya está vinculado a esta conversación. Revisa el diff contra main, " +
          "los archivos cambiados y los posibles riesgos. No uses ls, find, read, exec, inspect_linux " +
          "ni la ruta /bundle, que NO es un checkout de GitHub. Solo lectura; no modifiques nada."
        : "Usa repo_info para consultar el repositorio vinculado a esta conversación. " +
          "Para revisar ramas opencode/* usa repo_review, y para leer archivos usa repo_read. " +
          "No uses /bundle como repositorio GitHub ni modifiques nada sin autorización.");
    }, fail);
  };

  /** One guided new-project entrypoint for web and native Android work. */
  const startNewApp = (kind: "web" | "android" = "web") => {
    create().then((next) => {
      const slug = (kind === "android" ? "apk-" : "app-") + Date.now().toString(36);
      choose(next);
      setModeForSession(next, "build");
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
    // Clear only after the client socket accepts the message; never lose the
    // task draft on an immediate connection failure.
    // Link the chosen project to the task; server-side isolation is addressed in G8.
    const task = project && agentMode === "build"
      ? "Proyecto Linux seleccionado: " + project + ". Si usas la herramienta linux, utiliza project=" + project +
        ". No modifiques otros proyectos ni producción sin autorización.\n\nTarea: " + text
      : text;
    const selectedModel = openRouterAvailable ? modelPreset : "cloudflare";
    const deliver = () => {
      const accepted = submitPrompt(task, whenBusy, selectedModel, agentMode,
        specialization || undefined, project || undefined, repository || undefined);
      if (accepted) setPrompt((current) => current.trim() === text ? "" : current);
    };
    if (!busy && MODEL_PRESETS[selectedModel].providerID === "openrouter") {
      setLastCost("Consultando consumo de la clave OpenRouter…");
      void fetch("/api/settings/openrouter/usage", { cache: "no-store" })
        .then(async response => {
          if (!response.ok) throw new Error("usage-unavailable");
          const body = await response.json() as { usage?: { usage?: number } };
          const base = body.usage?.usage;
          if (typeof base !== "number" || !Number.isFinite(base)) throw new Error("usage-unavailable");
          pendingUsage.current = { session, project, base };
        })
        .catch(() => { pendingUsage.current = null; setLastCost("Consumo por tarea no disponible."); })
        .finally(deliver);
      return;
    }
    if (!busy) {
      pendingUsage.current = null;
      setLastCost("Workers AI u otro proveedor: costo por tarea no disponible en esta interfaz.");
    }
    deliver();
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
      className={`relative grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        sessionsOpen
          ? "lg:grid-cols-[minmax(220px,18vw)_minmax(520px,1fr)]"
          : "grid-cols-1"
      }`}
    >
      {sessionsOpen ? (
        <aside
          className="absolute inset-0 z-20 flex min-h-0 flex-col border-r border-kumo-line bg-kumo-base lg:static"
          aria-label="Conversaciones"
        >
          <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
            <span className="text-sm font-semibold">Conversaciones</span>
            <Button type="button" variant="ghost" shape="square"
              aria-label="Cerrar lista de conversaciones"
              className="lg:hidden"
              onClick={() => setSessionsOpen(false)}
              icon={<XCircleIcon size={16} />} />
            <Button
              variant="ghost"
              shape="square"
              aria-label="Nueva conversación"
              disabled={!connected}
              onClick={() => {
                create().then(next => {
                  saveSessionMode(localStorage, object, next, "build");
                  choose(next);
                }, fail);
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
            <a
              href={"/api/session/export?" + new URLSearchParams({ object, session }).toString()}
              download={`opencode-session-${session}.json`}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2 text-sm hover:bg-kumo-surface"
              aria-label="Descargar conversación guardada como archivo JSON"
            >
              <DownloadSimpleIcon size={16} />
              Exportar sesión
            </a>
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
              <Button type="button" variant="ghost" size="sm"
                aria-label="Gestionar mis proyectos" title="Ver proyectos creados"
                onClick={() => { setProjectsOpen(v => !v); void loadProjects(); }}>
                <CodeIcon size={16} />
                <span className="hidden sm:inline">Proyectos</span>
              </Button>
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
                <a
                  href={"/api/dev/download/" + encodeURIComponent(project) +
                    (repository ? "?" + new URLSearchParams({ source: "github", object, session }).toString() : "")}
                  download={repository ? project + "-github.zip" : project + ".tar.gz"}
                  className="inline-flex min-h-9 items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-kumo-elevated"
                  title={repository ? "Descargar ZIP del repositorio GitHub seleccionado" : "Descargar archivos del proyecto Linux"}
                  aria-label={repository ? "Descargar repositorio GitHub" : "Descargar proyecto Linux"}
                >
                  <DownloadSimpleIcon size={16} />
                  <span className="hidden sm:inline">{repository ? "Descargar repo" : "Descargar"}</span>
                </a>
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
              <select aria-label="Plantilla de trabajo" title="Plantilla editable: cambia instrucciones, modo y modelo sugerido"
                disabled={busy} value={specialization} onChange={(e) => {
                  const id = e.target.value;
                  localStorage.setItem(SPECIALIZATION_KEY, id);
                  setSpecialization(id);
                  const selected = specializations.find(item => item.id === id);
                  if (selected) {
                    setModeForSession(session, selected.mode ?? "build");
                    const preferred = selected.model ?? "cloudflare";
                    const available = openRouterAvailable ||
                      MODEL_PRESETS[preferred].providerID !== "openrouter";
                    const nextModel = available ? preferred : "cloudflare";
                    setModelPreset(nextModel);
                    localStorage.setItem(MODEL_KEY, nextModel);
                  }
                }}
                className="max-w-[132px] rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-xs text-kumo-default">
                <option value="">Sin plantilla</option>
                {specializations.map(item => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <select aria-label="Modo de agente" title="Los roles de revisión y narrativa no modifican archivos"
                disabled={busy} value={agentMode} onChange={(event) => setModeForSession(session, event.target.value as AgentMode)}
                className="max-w-[128px] rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-xs text-kumo-default">
                <option value="build">Desarrollar</option>
                <option value="plan">Planificar</option>
                <option value="review">Revisar</option>
                <option value="creative">Escritura</option>
              </select>
              <select
                aria-label="Modelo de IA"
                disabled={busy}
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
              {!connected ? (
                <Button type="button" variant="secondary" size="sm"
                  aria-label="Reintentar conexión conservando la sesión"
                  onClick={() => window.location.reload()}>
                  Reintentar
                </Button>
              ) : null}
              <ModeToggle />
            </div>
          </div>
        </header>

        <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            {projectsOpen ? (
              <section className="rounded-xl border border-kumo-line bg-kumo-base p-4" aria-label="Mis proyectos">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold">Proyectos del entorno Linux</h2>
                  <button className="rounded border border-kumo-line px-2 py-1 text-xs" type="button"
                    onClick={() => void loadProjects()}>Actualizar</button>
                </div>
                <div className="mt-3 space-y-2 rounded-md border border-kumo-line p-3" aria-label="Repositorio aislado G8">
                  <label className="block text-sm font-medium" htmlFor="repo-g8">Repositorio GitHub para la tarea</label>
                  <p className="text-xs text-kumo-subtle">
                    Elegir un repositorio crea una conversación nueva vinculada exclusivamente a él.
                    Las herramientas del agente no pueden escribir en otros proyectos ni repositorios.
                  </p>
                  <select id="repo-g8" value="" className="w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm"
                    disabled={!connected || !integrations?.githubConfigured}
                    onChange={e => selectRepository(e.target.value)}>
                    <option value="">Seleccionar repositorio y crear conversación</option>
                    {authorizedRepos.map(repo => <option value={repo} key={repo}>{repo}</option>)}
                  </select>
                  {repository ? <p className="text-xs">Repositorio de esta sesión: <strong>{repository}</strong></p> : null}
                  <div className="mt-2 flex flex-col gap-2 rounded-md border border-kumo-line p-3" aria-label="Prueba de desarrollo autónomo G9">
                    <strong className="text-sm">G9 · Desarrollo autónomo</strong>
                    <p className="text-xs text-kumo-subtle">
                      Una prueba real en el repositorio OpenCode Cloud: crea una rama
                      opencode/* descartable, prepara un defecto inocuo en archivos de prueba,
                      y pide al agente corregirlo, ejecutar Node y abrir una PR en borrador.
                      Se comprueba mediante herramientas y pruebas independientes.
                      Consume inferencia y puede iniciar el Container; no altera main ni producción.
                    </p>
                    <button type="button"
                      disabled={g9Busy || g9Status!=="not-started" ||
                        !integrations?.githubConfigured}
                      className="rounded border border-kumo-line px-3 py-2 text-sm disabled:opacity-50"
                      onClick={() => void startG9()}>
                      {g9Busy || g9Status==="running" ? "Verificando desarrollo…" :
                        "Probar desarrollo real G9 (una vez)"}
                    </button>
                    {g9Message ? <p role="status" className="text-sm">{g9Message}</p> : null}
                  </div>
                  <div className="mt-2 flex flex-col gap-2 rounded-md border border-kumo-line p-3" aria-label="Aceptación funcional del agente G8">
                    <button type="button"
                      disabled={g8LiveBusy || !integrations?.githubConfigured || g8LiveStatus !== "not-started"}
                      className="rounded border border-kumo-line px-3 py-2 text-sm disabled:opacity-50"
                      onClick={() => void startG8Live()}>
                      {g8LiveBusy || g8LiveStatus === "running" ? "Revisando ambos repositorios…" :
                        "Validar agente real G8 (una vez)"}
                    </button>
                    <p className="text-xs text-kumo-subtle">
                      Dos sesiones aisladas con Workers AI, modo Revisión y solo lectura.
                      Consume una pequeña cantidad de inferencia. Comprueba resultados reales de
                      repo_review, no el texto del modelo. Sin cambios, PR nuevas ni despliegues.
                    </p>
                    {g8LiveMessage ? <p role="status" className="text-sm">{g8LiveMessage}</p> : null}
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    {window.location.hostname === "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" ? <><button type="button" disabled={isolationBusy}
                      className="rounded border border-kumo-line px-3 py-2 text-sm disabled:opacity-50"
                      onClick={() => void verifyContainerIsolation()}>
                      {isolationBusy ? "Probando Containers…" : "Probar aislamiento Linux en staging"}
                    </button>
                    <p className="text-xs text-kumo-subtle">Inicia dos Containers temporales con archivos sintéticos y puede generar consumo de Cloudflare.</p>
                    {isolationResult ? <p role="status" className="text-sm">{isolationResult}</p> : null}</> : null}
                    {window.location.hostname === "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" ? <>
                      <button type="button" disabled={isolatedBackupBusy}
                        className="rounded border border-kumo-line px-3 py-2 text-sm disabled:opacity-50"
                        onClick={() => void verifyIsolatedBackup()}>
                        {isolatedBackupBusy ? "Verificando respaldo…" : "Probar respaldo aislado en staging"}
                      </button>
                      {isolatedBackupResult ? <p role="status" className="text-sm">{isolatedBackupResult}</p> : null}
                    </> : null}
                    {window.location.hostname === "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" && repository ? <>
                      <button type="button" disabled={importProbeBusy}
                        className="rounded border border-kumo-line px-3 py-2 text-sm disabled:opacity-50"
                        onClick={() => void verifyRepositoryImport()}>
                        {importProbeBusy ? "Importando código…" : "Probar importación aislada del repositorio"}
                      </button>
                      {importProbeResult ? <p role="status" className="text-sm">{importProbeResult}</p> : null}
                    </> : null}
                    <button type="button" disabled={g8Busy || !integrations?.githubConfigured}
                      className="rounded border border-kumo-line px-3 py-2 text-sm disabled:opacity-50"
                      onClick={() => void verifyG8()}>
                      {g8Busy ? "Comprobando…" : "Comprobar aislamiento CDF CLOUD y WorkBench"}
                    </button>
                    <p className="text-xs text-kumo-subtle">
                      Comprueba las dos ramas y PR de prueba de G8 mediante lecturas GitHub reales.
                      No crea archivos, no hace merge ni consume tokens de IA.
                    </p>
                    {g8Result ? <p role="status" className="text-sm">{g8Result}</p> : null}
                  </div>
                  {!integrations?.githubConfigured
                    ? <p className="text-xs text-kumo-subtle">Conecta GitHub en Configuración para crear ramas y PR de borrador.</p> : null}
                </div>
                <p className="mt-1 text-xs text-kumo-subtle">Consultar esta lista no enciende el Container. Puedes guardar una copia de proyectos pequeños (máximo 2 MiB comprimidos) en Durable Object, independiente de las instantáneas de 30 días, y descargarla incluso si estas caducan. Los respaldos se guardan manualmente y pueden restaurarse en un proyecto nuevo sin sobrescribir uno existente.</p>
                {projectError ? <p role="alert" className="mt-2 text-sm">{projectError}</p> : null}
                {availableProjects.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {availableProjects.map(row => (
                      <div key={row.name} className="flex flex-wrap items-center gap-2 rounded-md border border-kumo-line px-2 py-2">
                        <button type="button" className="text-xs font-medium underline"
                          onClick={() => chooseProject(row.name)}>
                          {row.name}{project === row.name ? " ✓" : ""}
                        </button>
                        <button type="button" disabled={backupBusy}
                          className="rounded border border-kumo-line px-2 py-1 text-xs disabled:opacity-50"
                          onClick={() => void saveProjectBackup(row.name)}>Guardar respaldo</button>
                        <button type="button" disabled={reviewBusy}
                          className="rounded border border-kumo-line px-2 py-1 text-xs disabled:opacity-50"
                          onClick={() => void reviewChanges(row.name)}>
                          {reviewBusy ? "Consultando…" : "Revisar archivos"}
                        </button>
                        {savedBackups.some(item => item.project === row.name) ? (
                          <a className="text-xs underline" href={"/api/dev/backup/" + encodeURIComponent(row.name)}>
                            Descargar respaldo conservado
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : <p className="mt-2 text-sm text-kumo-subtle">No hay proyectos registrados todavía.</p>}
                {projectReview ? (
                  <div className="mt-4 rounded-lg border border-kumo-line p-3" aria-label="Resumen de archivos del proyecto">
                    <p className="mb-2 text-sm font-semibold">Revisión de {projectReview.project}</p>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{projectReview.output}</pre>
                    <p className="mt-2 text-xs text-kumo-subtle">Salida real de Git o listado del entorno Linux; si no hay Git, no se puede calcular un diff fiable.</p>
                  </div>
                ) : null}
                {savedBackups.length ? (
                  <div className="mt-4 space-y-3 rounded-lg border border-kumo-line p-3" aria-label="Restaurar respaldo">
                    <h3 className="text-sm font-semibold">Recuperar un proyecto</h3>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs">
                        Respaldo guardado
                        <select aria-label="Respaldo de origen"
                          className="min-w-0 rounded border border-kumo-line bg-kumo-base p-2"
                          value={restoreFrom || savedBackups[0]?.project || ""}
                          onChange={(event) => setRestoreFrom(event.target.value)}>
                          {savedBackups.map((item) => (
                            <option key={item.project} value={item.project}>{item.project}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        Nombre del proyecto recuperado
                        <input type="text" autoComplete="off" maxLength={40}
                          className="min-w-0 rounded border border-kumo-line bg-kumo-base p-2"
                          value={restoreTo} placeholder="mi-proyecto-recuperado"
                          onChange={(event) => setRestoreTo(event.target.value)} />
                      </label>
                    </div>
                    <button type="button" disabled={backupBusy || !restoreTo.trim()}
                      className="rounded border border-kumo-line px-3 py-2 text-xs disabled:opacity-50"
                      onClick={() => void restoreProject()}>
                      {backupBusy ? "Procesando…" : "Restaurar sin sobrescribir"}
                    </button>
                    <p className="text-xs text-kumo-subtle">La copia original permanece guardada. El historial de sesión y los archivos de Git no se recrean automáticamente.</p>
                  </div>
                ) : null}
              </section>
            ) : null}
            {settingsOpen ? (
              <SettingsPanel workspace={object} onClose={() => setSettingsOpen(false)}
                onChanged={() => { void refreshIntegrations(); void refreshSpecializations(); }} />
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
                  {project ? (
                    <button className="mt-1 rounded-md border border-kumo-line px-3 py-1.5 text-xs"
                      type="button" disabled={!connected}
                      title="Crea otra sesión de revisión independiente; utiliza tokens de IA"
                      onClick={() => create({ project }).then(next => {
                        localStorage.setItem(PROJECT_PREFIX + next, project);
                        choose(next);
                        setModeForSession(next, "review");
                      }, fail)}>
                      Delegar revisión independiente (consume tokens)
                    </button>
                  ) : null}
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
            <p role="status" className="mb-2 text-xs text-kumo-subtle">
              Los proyectos anteriores se conservan. Para editarlos, restaura una copia con un nombre nuevo.
            </p>
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-kumo-subtle">
              <span>Proyecto: <strong className="text-kumo-default">{project || "Sin seleccionar"}</strong></span>
              <button type="button" className="underline"
                onClick={() => { setProjectsOpen(true); void loadProjects(); }}>Cambiar proyecto</button>
              <span aria-live="polite">{busy ? "Ejecutando" : "Disponible"} · {toolsCompleted} herramientas completadas en esta sesión{toolsFailed ? " · " + toolsFailed + " fallidas" : ""}</span>
              <span title="El cambio de consumo de OpenRouter es de cuenta, no una factura de la tarea">{lastCost}</span>
            </div>
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

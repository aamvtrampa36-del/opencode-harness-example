import { specializationPrompt as specializationPromptText, type Specialization, type WorkflowStage } from "./specializations";
import { classifyAgentFailure, type IncidentObservation } from "./incident-diagnostics";
import { MODEL_PRESETS, isModelSelection, isOpenRouterSelection, resolveModelSelection, type ModelSelectionID } from "./model-presets";
import { assertOpenRouterModelSupportsImageInput, assertOpenRouterModelSupportsTools } from "./openrouter-catalog";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import {
  ROOT_SESSION,
  type OpenCodeEventStream,
  type OpenCodeHarness,
  type OpenCodeSessionEvent,
  type OpenCodeSessionId
} from "agents/harness/opencode";
import type { ClientMessage, ServerMessage, SessionSnapshot, ModelRun } from "./protocol";

const SESSION_TAG_PREFIX = "opencode-session:";
const SESSION_QUERY = "session";
/** A bound on one prompt; this example has no other quotas. */
const MAX_PROMPT_LENGTH = 100_000;
const MAX_INLINE_IMAGE_LENGTH = 2_666_668;
const MAX_INLINE_IMAGES = 2;
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

/**
 * Events after which the transcript has changed in a way the client should
 * see in full: a new input, a finished step or tool, the run starting, a
 * compaction. Deltas are forwarded as they are.
 */
const RESNAPSHOT = new Set<OpenCodeSessionEvent["type"]>([
  "operation_queued",
  "operation_withdrawn",
  "operation_start",
  "run_start",
  "message_end",
  "tool_start",
  "tool_end",
  "compaction_start",
  "transcript_reset"
]);

function sessionTag(session: OpenCodeSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

/** The `?session=` the socket asked for, or undefined if it is malformed. */
function sessionFromRequest(request: Request): OpenCodeSessionId | undefined {
  const session = new URL(request.url).searchParams.get(SESSION_QUERY);
  if (session === null || session === "") return ROOT_SESSION;
  return /^ses[A-Za-z0-9_]{1,64}$/.test(session) ? session : undefined;
}

/** The session a socket follows, or undefined if it asked for a bad one. */
function sessionOf(tags: readonly string[]): OpenCodeSessionId | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(SESSION_TAG_PREFIX)
  );
  return tag?.slice(SESSION_TAG_PREFIX.length);
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the state check and the send.
  }
}

function parse(raw: WebSocketMessage): ClientMessage | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && "type" in value
      ? // SAFETY: the dispatcher checks `type` and rejects unknown commands;
        // each field it reads is checked where it is used.
        (value as ClientMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * App glue: this app's session protocol over the `WebSockets` capability,
 * built only on the harness's public API.
 *
 * Each socket follows one session, picked by `?session=`. On connect it gets
 * a snapshot of the transcript. While a session runs, one watch on
 * `session.events()` fans the session's events out to every socket on it,
 * with a fresh snapshot after each change to the transcript. The watch stops
 * when the session is idle, so the object can hibernate between runs with
 * its sockets still open.
 */
export class OpenCodeSessionSockets {
  readonly #harness: OpenCodeHarness;
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  readonly #openRouterAvailable: () => Promise<boolean>;
  readonly #specialization: (id: string) => Promise<Specialization | undefined>;
  readonly #noteIncident: (event: IncidentObservation) => Promise<void>;
  readonly #bindScope: (sessionID: string, value: unknown) => Promise<void>;
  readonly #inheritScope: (source: string, target: string, project: string) => Promise<void>;
  readonly #setSessionModels: (sessionID: string, options: { decisionModel?: string; imageModel?: string }) => Promise<void>;
  readonly #defaultImageModel: () => Promise<string | undefined>;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  readonly #getSelectedModel: (session: string) => Promise<ModelSelectionID | undefined>;
  readonly #saveSelectedModel: (session: string, model: ModelSelectionID) => Promise<void>;
  readonly #getModelRuns: (session: string) => Promise<ModelRun[]>;
  readonly #appendModelRun: (session: string, run: ModelRun) => Promise<void>;
  /** One event stream per running session, or its opening. */
  readonly #watches = new Map<
    OpenCodeSessionId,
    Promise<OpenCodeEventStream | undefined>
  >();
  /** Sessions with a snapshot being sent, and whether another is due. */
  readonly #snapshots = new Map<OpenCodeSessionId, boolean>();
  readonly #submitLocks = new Map<OpenCodeSessionId, Promise<void>>();
  readonly #cancelledWorkflows = new Set<OpenCodeSessionId>();
  readonly #activeConfigurations = new Map<OpenCodeSessionId, { mode: string; model: string | undefined; specialization: string | undefined; workflow?: boolean; operations: Set<string> }>();

  #workflowStatus(session: OpenCodeSessionId, value: {
    status: "running" | "completed" | "failed" | "cancelled"; stage: number; total: number; name: string; error?: string
  }): void {
    for (const socket of this.#getWebSockets(sessionTag(session))) send(socket, { type: "workflow", ...value });
  }

  async #configureStage(session: OpenCodeSessionId, stage: WorkflowStage, selection: ModelSelectionID): Promise<void> {
    const selected = resolveModelSelection(selection);
    if (selected.providerID === "openrouter") {
      if (!(await this.#openRouterAvailable())) throw new Error("Conecta OpenRouter antes de ejecutar esta etapa.");
      await assertOpenRouterModelSupportsTools(selected.id);
    }
    const handle = this.#harness.session(session);
    await handle.setModel({ providerID: selected.providerID, id: selected.id });
    await handle.setAgent(stage.mode === "plan" ? "plan" : "build");
  }

  async #continueWorkflow(
    session: OpenCodeSessionId,
    configuration: { mode: string; model: string | undefined; specialization: string | undefined; workflow?: boolean; operations: Set<string> },
    profile: Specialization,
    stages: readonly WorkflowStage[],
    selections: readonly ModelSelectionID[],
    firstOperation: string,
    firstText: string
  ): Promise<void> {
    const handle = this.#harness.session(session);
    const marker = "workflow:" + crypto.randomUUID();
    configuration.operations.add(marker);
    try {
      await handle.wait(firstOperation);
      configuration.operations.delete(firstOperation);
      if (this.#cancelledWorkflows.has(session)) {
        this.#workflowStatus(session, { status: "cancelled", stage: 1, total: stages.length, name: stages[0]!.name });
        return;
      }
      for (let index = 1; index < stages.length; index++) {
        const stage = stages[index]!;
        await this.#configureStage(session, stage, selections[index]!);
        if (this.#cancelledWorkflows.has(session)) {
          this.#workflowStatus(session, { status: "cancelled", stage: index, total: stages.length, name: stages[index - 1]!.name });
          return;
        }
        const text = specializationPromptText(profile) +
          `FLUJO ${index + 1}/${stages.length} · ${stage.name}\n` + stage.instructions +
          "\nContinúa usando el contexto y los resultados de las etapas anteriores. " +
          "No repitas acciones ya completadas.\n\nSolicitud original: " + firstText;
        const receipt = await handle.submit(text, { whenBusy: "followUp" });
        configuration.operations.add(receipt.operationId);
        this.#workflowStatus(session, { status: "running", stage: index + 1, total: stages.length, name: stage.name });
        await this.#broadcastSnapshot(session);
        await handle.wait(receipt.operationId);
        configuration.operations.delete(receipt.operationId);
        if (this.#cancelledWorkflows.has(session)) {
          this.#workflowStatus(session, { status: "cancelled", stage: index + 1, total: stages.length, name: stage.name });
          return;
        }
      }
      this.#workflowStatus(session, { status: "completed", stage: stages.length, total: stages.length, name: stages[stages.length - 1]!.name });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 240) : "No se pudo completar el flujo";
      this.#workflowStatus(session, { status: this.#cancelledWorkflows.has(session) ? "cancelled" : "failed",
        stage: 0, total: stages.length, name: profile.name,
        ...(this.#cancelledWorkflows.has(session) ? {} : { error: message }) });
      try { await handle.abort(); } catch { /* Preserve the original failure. */ }
      console.warn("OpenCode workflow failed", message);
    } finally {
      this.#cancelledWorkflows.delete(session);
      for (const operation of [...configuration.operations]) if (operation.startsWith("workflow:")) configuration.operations.delete(operation);
      this.#activeConfigurations.set(session, configuration);
      await this.#settle(session);
    }
  }

  /** Serialize configuration and submit for one session, including concurrent sockets. */
  async #serializeSubmit<T>(session: OpenCodeSessionId, work: () => Promise<T>): Promise<T> {
    const prior = this.#submitLocks.get(session) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#submitLocks.set(session, current);
    await prior;
    try { return await work(); }
    finally {
      release();
      if (this.#submitLocks.get(session) === current) this.#submitLocks.delete(session);
    }
  }

  constructor(
    harness: OpenCodeHarness,
    getWebSockets: (tag?: string) => WebSocket[],
    openRouterAvailable: () => Promise<boolean> = async () => false,
    getSpecialization: (id: string) => Promise<Specialization | undefined> = async () => undefined,
    noteIncident: (event: IncidentObservation) => Promise<void> = async () => undefined,
    bindScope: (sessionID: string, value: unknown) => Promise<void> = async () => undefined,
    inheritScope: (source: string, target: string, project: string) => Promise<void> = async () => undefined,
    setSessionModels: (sessionID: string, options: { decisionModel?: string; imageModel?: string }) => Promise<void> = async () => undefined,
    getDefaultImageModel: () => Promise<string | undefined> = async () => undefined,
    waitUntil: (promise: Promise<unknown>) => void = promise => { void promise; },
    getSelectedModel: (session: string) => Promise<ModelSelectionID | undefined> = async () => undefined,
    saveSelectedModel: (session: string, model: ModelSelectionID) => Promise<void> = async () => undefined,
    getModelRuns: (session: string) => Promise<ModelRun[]> = async () => [],
    appendModelRun: (session: string, run: ModelRun) => Promise<void> = async () => undefined
  ) {
    this.#harness = harness;
    this.#getWebSockets = getWebSockets;
    this.#openRouterAvailable = openRouterAvailable;
    this.#specialization = getSpecialization;
    this.#noteIncident = noteIncident;
    this.#bindScope = bindScope;
    this.#inheritScope = inheritScope;
    this.#setSessionModels = setSessionModels;
    this.#defaultImageModel = getDefaultImageModel;
    this.#waitUntil = waitUntil;
    this.#getSelectedModel = getSelectedModel;
    this.#saveSelectedModel = saveSelectedModel;
    this.#getModelRuns = getModelRuns;
    this.#appendModelRun = appendModelRun;
  }

  async #record(event: IncidentObservation): Promise<void> {
    try { await this.#noteIncident(event); }
    catch { console.warn("Agent incident ledger unavailable"); }
  }

  options(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => {
        const session = sessionFromRequest(ctx.request);
        return session === undefined ? [] : [sessionTag(session)];
      },
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) => this.#onMessage(connection, message)
      }
    };
  }

  /**
   * Watch every running session that has sockets, after the object
   * restarts: watches live in memory, and a crashed run resumes on boot.
   */
  async reattach(): Promise<void> {
    if (this.#getWebSockets().length === 0) return;
    for (const { id, busy } of await this.#harness.sessions.list()) {
      if (this.#getWebSockets(sessionTag(id)).length === 0) continue;
      await this.#broadcastSnapshot(id);
      if (busy) this.#watch(id);
    }
  }

  async #onConnect(connection: Connection, ctx: ConnectionContext) {
    const session = sessionFromRequest(ctx.request);
    const sessions = await this.#harness.sessions.list();
    if (
      session === undefined ||
      !sessions.some((info) => info.id === session)
    ) {
      send(connection, {
        type: "error",
        code: "unknown_session",
        message: `Unknown session ${JSON.stringify(
          new URL(ctx.request.url).searchParams.get(SESSION_QUERY)
        )}`
      });
      // A close sent from onConnect, before the upgrade completes, does not
      // reach the client, so the client closes on this error instead. The
      // socket has no session tag, so it gets no session's events.
      return;
    }
    send(connection, { type: "hello", session, openRouterAvailable: await this.#openRouterAvailable() });
    send(connection, { type: "sessions", sessions });
    const snapshot = await this.#snapshot(session);
    send(connection, { type: "snapshot", ...snapshot });
    const savedModel = await this.#getSelectedModel(session);
    if (savedModel && isModelSelection(savedModel)) {
      send(connection, { type: "model_selection", session, model: savedModel, pending: snapshot.busy });
    }
    if (snapshot.busy) this.#watch(session);
  }

  async #onMessage(connection: Connection, raw: WebSocketMessage) {
    const message = parse(raw);
    if (message === undefined) {
      send(connection, { type: "error", message: "Malformed message" });
      return;
    }
    const session = sessionOf(connection.tags);
    if (session === undefined) {
      send(connection, {
        type: "error",
        code: "unknown_session",
        message: "This socket has no session"
      });
      return;
    }
    try {
      const result = message.type === "submit" || message.type === "select_model"
        ? await this.#serializeSubmit(session, () => this.#dispatch(connection, session, message))
        : await this.#dispatch(connection, session, message);
      if (message.id !== undefined) {
        send(connection, { type: "result", id: message.id, result });
      }
    } catch (error) {
      await this.#record({ source: "agent",
        code: classifyAgentFailure(error instanceof Error ? error.message : "") });
      send(connection, {
        type: "error",
        ...(message.id === undefined ? {} : { id: message.id }),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #dispatch(
    connection: Connection,
    session: OpenCodeSessionId,
    message: ClientMessage
  ): Promise<unknown> {
    const handle = this.#harness.session(session);
    switch (message.type) {
      case "select_model": {
        if (!isModelSelection(message.model)) throw new Error("Modelo no reconocido.");
        const selected = resolveModelSelection(message.model);
        if (selected.providerID === "openrouter") {
          if (!(await this.#openRouterAvailable())) throw new Error("Conecta OpenRouter antes de elegir ese modelo.");
          if (isOpenRouterSelection(message.model)) await assertOpenRouterModelSupportsTools(selected.id);
        }
        const running = (this.#activeConfigurations.get(session)?.operations.size ?? 0) > 0 || await handle.busy();
        // Do not mutate an active inference. Its model stays fixed; selection
        // is persisted for the next turn and confirmed to every open client.
        if (!running) await handle.setModel({ providerID: selected.providerID, id: selected.id });
        await this.#saveSelectedModel(session, message.model);
        for (const socket of this.#getWebSockets(sessionTag(session))) {
          send(socket, { type: "model_selection", session, model: message.model, pending: running });
        }
        return { model: message.model, pending: running };
      }
      case "submit": {
        const files = message.files ?? [];
        if (!Array.isArray(files) || files.length > MAX_INLINE_IMAGES ||
            files.some(file => !file || typeof file.data !== "string" ||
              file.data.length > MAX_INLINE_IMAGE_LENGTH ||
              !/^image\/(png|jpeg|webp)$/.test(file.mime) ||
              typeof file.name !== "string" || file.name.length > 160 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) ||
            files.reduce((total, file) => total + Math.floor(file.data.length * 3 / 4), 0) > 4_000_000) {
          throw new Error("Adjunta hasta dos imágenes PNG, JPEG o WebP de 2 MB cada una.");
        }
        if (typeof message.text !== "string" || (message.text.trim() === "" && files.length === 0)) {
          throw new Error("Nothing to send");
        }
        // The durable server selection is authoritative when the client omits it.
        if (message.text.length > MAX_PROMPT_LENGTH) {
          throw new Error(
            `Prompts are limited to ${MAX_PROMPT_LENGTH.toLocaleString()} characters`
          );
        }
        const mode = message.mode ?? "build";
        if (!["build", "plan", "review", "creative"].includes(mode)) {
          throw new Error("Modo de agente no reconocido");
        }
        const selection = message.model ?? await this.#getSelectedModel(session) ?? "economy";
        if (!isModelSelection(selection)) throw new Error("Unknown model preset");
        // A queued or steering message must never change the permissions or
        // model of a running operation. After a restart an unknown configuration
        // fails closed until that operation completes.
        const active = this.#activeConfigurations.get(session);
        const running = (active?.operations.size ?? 0) > 0 || await handle.busy();
        if (running && active?.workflow) throw new Error("Esta plantilla está ejecutando sus etapas. Puedes continuar en otra conversación y volver al flujo después.");
        if (running && (!active || active.mode !== mode || active.model !== selection ||
            active.specialization !== message.specialization)) {
          throw new Error("Espera a que termine la tarea antes de cambiar el modo, modelo o plantilla.");
        }
        // Scope is fixed before inference; validate it for queued work too.
        if (message.project !== undefined || message.repository !== undefined) {
          await this.#bindScope(session, { project: message.project, repository: message.repository });
        }
        if (!running) {
          {
            const selected = resolveModelSelection(selection);
            if (selected.providerID === "openrouter" && !(await this.#openRouterAvailable())) {
              throw new Error("Conecta OpenRouter desde Configuración antes de seleccionar ese modelo.");
            }
            if (isOpenRouterSelection(selection)) {
              await assertOpenRouterModelSupportsTools(selected.id);
            }
            if (files.length) {
              if (selected.providerID !== "openrouter") {
                throw new Error("Selecciona un modelo OpenRouter compatible con imágenes.");
              }
              await assertOpenRouterModelSupportsImageInput(selected.id);
            }
            await handle.setModel({ providerID: selected.providerID, id: selected.id });
            const stored = await this.#getSelectedModel(session);
            if (stored !== selection) {
              await this.#saveSelectedModel(session, selection);
              for (const socket of this.#getWebSockets(sessionTag(session))) {
                send(socket, { type: "model_selection", session, model: selection, pending: false });
              }
            }
          }
          await handle.setAgent(mode === "build" ? "build" : "plan");
        }
        let specializationPrompt = "";
        let selectedSpecialization: Specialization | undefined;
        if (message.specialization !== undefined) {
          if (typeof message.specialization !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(message.specialization)) {
            throw new Error("Identificador de especialización inválido");
          }
          selectedSpecialization = await this.#specialization(message.specialization);
          if (!selectedSpecialization) throw new Error("La especialización seleccionada ya no existe o está desactivada");
          specializationPrompt = specializationPromptText(selectedSpecialization);
        }
        const stages = selectedSpecialization?.stages?.filter(stage => stage.instructions.trim()) ?? [];
        const selections: ModelSelectionID[] = stages.map(stage => stage.model ?? selectedSpecialization?.model ?? selection);
        if (!running && stages.length) {
          for (const selection of selections) {
            const selected = resolveModelSelection(selection);
            if (selected.providerID === "openrouter") {
              if (!(await this.#openRouterAvailable())) throw new Error("Conecta OpenRouter antes de ejecutar este flujo.");
              await assertOpenRouterModelSupportsTools(selected.id);
            }
          }
          if (files.length) {
            const firstModel = resolveModelSelection(selections[0]!);
            if (firstModel.providerID !== "openrouter") throw new Error("La primera etapa necesita un modelo OpenRouter compatible con imágenes.");
            await assertOpenRouterModelSupportsImageInput(firstModel.id);
          }
        }
        if (!running) {
          const imageModel = selectedSpecialization?.imageModel ?? await this.#defaultImageModel();
          await this.#setSessionModels(session, {
            ...(selectedSpecialization?.decisionModel ? { decisionModel: selectedSpecialization.decisionModel } : {}),
            ...(imageModel ? { imageModel } : {})
          });
        }
        const prefixed =
          mode === "review" ? "Revisa críticamente este trabajo. Identifica problemas con evidencia y no modifiques archivos ni producción.\n\n" :
          mode === "creative" ? "Trabaja como redactor: planifica, escribe o revisa borradores. No alteres fuentes oficiales ni publiques sin autorización.\n\n" :
          "";
        this.#watch(session);
        const text = message.text.trim() || "Analiza la imagen adjunta y responde a partir de su contenido.";
        const workflow = !running && stages.length > 0;
        const stagePrefix = workflow
          ? `FLUJO 1/${stages.length} · ${stages[0]!.name}\n${stages[0]!.instructions}\n\nSolicitud original: `
          : "";
        const input = files.length ? {
          text: specializationPrompt + prefixed + stagePrefix + text,
          files: files.map(file => ({
            uri: `data:${file.mime};base64,${file.data}`, name: file.name
          }))
        } : specializationPrompt + prefixed + stagePrefix + text;
        if (workflow) {
          await this.#configureStage(session, stages[0]!, selections[0]!);
        }
        const receipt = await handle.submit(input, {
          whenBusy: message.whenBusy === "steer" ? "steer" : "followUp"
        });
        if (!running) {
          const actual = resolveModelSelection(workflow ? selections[0]! : selection);
          try {
            await this.#appendModelRun(session, { operationId: receipt.operationId,
              model: workflow ? selections[0]! : selection,
              providerID: actual.providerID, id: actual.id, at: Date.now() });
          } catch { console.warn("Model execution provenance could not be saved"); }
        }
        const configuration = active && running ? active : { mode, model: selection,
          specialization: message.specialization, ...(workflow ? { workflow: true } : {}), operations: new Set<string>() };
        configuration.operations.add(receipt.operationId);
        this.#activeConfigurations.set(session, configuration);
        if (workflow) {
          this.#workflowStatus(session, { status: "running", stage: 1, total: stages.length, name: stages[0]!.name });
        }
        await this.#broadcastSnapshot(session);
        const activeSessions = await this.#harness.sessions.list();
        for (const socket of this.#getWebSockets()) {
          send(socket, {
            type: "sessions",
            sessions: activeSessions.map((info) =>
              info.id === session ? { ...info, busy: true } : info
            )
          });
        }
        // Once the operation settles, send the final transcript and stop
        // watching if nothing else is running. This holds even if the watch
        // attached after the run's last event.
        if (workflow && selectedSpecialization) {
          this.#waitUntil(this.#continueWorkflow(session, configuration, selectedSpecialization, stages,
            selections, receipt.operationId, text));
        } else {
          void handle.wait(receipt.operationId).then(
            () => {
              configuration.operations.delete(receipt.operationId);
              return this.#settle(session);
            },
            async (error: unknown) => {
              // An accepted operation can fail before emitting run_end. Leaving
              // its id in this in-memory set would show "Tarea en curso" forever.
              configuration.operations.delete(receipt.operationId);
              const message = error instanceof Error ? error.message.slice(0, 240) : "Error al ejecutar la tarea";
              await this.#record({ source: "agent", code: classifyAgentFailure(message) });
              for (const socket of this.#getWebSockets(sessionTag(session))) {
                send(socket, { type: "error", message: "La tarea terminó con un error: " + message });
              }
              await this.#settle(session);
            }
          ).catch((error: unknown) => {
            console.warn("OpenCode settlement failed", error);
          });
        }
        return receipt;
      }
      case "abort":
        if (this.#activeConfigurations.get(session)?.workflow) this.#cancelledWorkflows.add(session);
        await handle.abort();
        await this.#settle(session);
        return true;
      case "delegate": {
        if (typeof message.project !== "string" ||
            !/^[a-z][a-z0-9-]{0,39}$/.test(message.project)) {
          throw new Error("Primero selecciona un proyecto válido");
        }
        const fork = await this.#harness.sessions.fork(session);
        await this.#inheritScope(session, fork.id, message.project);
        await fork.setAgent("plan");
        await fork.setModel({ providerID: MODEL_PRESETS.cloudflare.providerID, id: MODEL_PRESETS.cloudflare.id });
        const review = "Eres un agente revisor independiente. Inspecciona el proyecto " +
          message.project + " con inspect_linux para listar carpetas y leer archivos. " +
          "No tienes permiso para ejecutar comandos, instalar dependencias ni escribir archivos. " +
          "Comprueba calidad y riesgos a partir de los archivos reales. NO edites, publiques ni modifiques producción. " +
          "Devuelve hallazgos concretos y especifica qué no se pudo comprobar.";
        await fork.submit(review);
        const all = await this.#harness.sessions.list();
        for (const socket of this.#getWebSockets()) send(socket, { type: "sessions", sessions: all });
        return { session: fork.id };
      }
      case "create": {
        const created = await this.#harness.sessions.create();
        const sessions = await this.#harness.sessions.list();
        for (const socket of this.#getWebSockets()) {
          send(socket, { type: "sessions", sessions });
        }
        return { session: created.id };
      }
      case "resync":
        send(connection, {
          type: "snapshot",
          ...(await this.#snapshot(session))
        });
        return null;
      default:
        throw new Error(
          `Unknown message type ${JSON.stringify((message as { type: unknown }).type)}`
        );
    }
  }

  async #snapshot(session: OpenCodeSessionId): Promise<SessionSnapshot> {
    const handle = this.#harness.session(session);
    const [messages, busy, pending, modelRuns] = await Promise.all([
      handle.history(),
      handle.busy(),
      this.#harness.pending({ session }),
      this.#getModelRuns(session)
    ]);
    // The underlying flag can transiently report idle while an accepted operation
    // is still unsettled. Do not advertise availability in that gap.
    const operationPending = (this.#activeConfigurations.get(session)?.operations.size ?? 0) > 0;
    return { session, messages, busy: busy || operationPending, pending, modelRuns };
  }

  /** Send every socket on the session a snapshot, one at a time. */
  async #broadcastSnapshot(session: OpenCodeSessionId): Promise<void> {
    if (this.#snapshots.has(session)) {
      this.#snapshots.set(session, true);
      return;
    }
    this.#snapshots.set(session, false);
    try {
      do {
        this.#snapshots.set(session, false);
        const snapshot = await this.#snapshot(session);
        for (const socket of this.#getWebSockets(sessionTag(session))) {
          send(socket, { type: "snapshot", ...snapshot });
        }
      } while (this.#snapshots.get(session) === true);
    } finally {
      this.#snapshots.delete(session);
    }
  }

  /** Final snapshot, and stop the watch if the session is idle. */
  async #settle(session: OpenCodeSessionId): Promise<void> {
    await this.#broadcastSnapshot(session);
    // Busy flags, and the title OpenCode generates after the first run.
    const sessions = await this.#harness.sessions.list();
    for (const socket of this.#getWebSockets()) {
      send(socket, { type: "sessions", sessions });
    }
    if (!(await this.#harness.session(session).busy()) &&
        !(this.#activeConfigurations.get(session)?.operations.size)) {
      this.#activeConfigurations.delete(session);
      await this.#unwatch(session);
    }
  }

  /** Watch the session's events until it is idle. Idempotent. */
  #watch(session: OpenCodeSessionId): void {
    if (this.#watches.has(session)) return;
    const opening = this.#harness
      .session(session)
      .events()
      .then((stream) => {
        stream.start((events) => void this.#onEvents(session, events));
        return stream;
      })
      .catch((error: unknown) => {
        console.warn("OpenCode event watch failed to open", error);
        if (this.#watches.get(session) === opening) {
          this.#watches.delete(session);
        }
        return undefined;
      });
    this.#watches.set(session, opening);
  }

  async #unwatch(session: OpenCodeSessionId): Promise<void> {
    const opening = this.#watches.get(session);
    if (opening === undefined) return;
    this.#watches.delete(session);
    await (await opening)?.stop();
  }

  async #onEvents(
    session: OpenCodeSessionId,
    events: readonly OpenCodeSessionEvent[]
  ): Promise<void> {
    for (const event of events) {
      for (const socket of this.#getWebSockets(sessionTag(session))) {
        send(socket, { type: "event", event });
      }
    }
    try {
      // A fault is a machine event, not a model explanation.
      if (events.some(event => event.type === "fault")) {
        await this.#record({ code: "AGENT_FAILURE", source: "session" });
      }
      if (this.#getWebSockets(sessionTag(session)).length === 0) {
        await this.#unwatch(session);
      } else if (events.some((event) => event.type === "run_end")) {
        await this.#settle(session);
      } else if (events.some((event) => RESNAPSHOT.has(event.type))) {
        await this.#broadcastSnapshot(session);
      } else if (events.some((event) => event.type === "fault")) {
        // The stream may have ended: open a new one if the session runs.
        await this.#unwatch(session);
        if (await this.#harness.session(session).busy()) this.#watch(session);
      }
    } catch (error) {
      console.warn("OpenCode event handling failed", error);
    }
  }
}

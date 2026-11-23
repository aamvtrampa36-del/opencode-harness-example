import { DurableObject } from "cloudflare:workers";
import { PersonalSettings } from "./personal-settings";
export { PersonalSettings };
export { OpenCodeSupervisorWorkflow } from "./supervisor-workflow";
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
import { collectSupervisorDirectory, supervisorTaskCount } from "./supervisor-directory";
import { foldSupervisorToolLog, validSupervisorToolCounts, EMPTY_SUPERVISOR_TOOL_COUNTS, type SupervisorToolCounts } from "./supervisor-metrics";
import { projectSupervisorProgress } from "./supervisor-progress";
import {
  reserveSupervisorAdmission, supervisorBeginExternalEffect,
  supervisorConfirmExternalEffect, supervisorAdmissionSlot,
  hasSupervisorAdmissionSlot, reconcileSupervisorSubmittedEffect, type StartGrant
} from "./supervisor-admission";
import { workspacePlugin } from "./workspace";
import { createDynamicMcpModule } from "./dynamic-mcp";
import { createDynamicMcpHost } from "./dynamic-mcp-bridge";
import { tokenEconomizerAdapter } from "./token-economizer-adapter";
import type { ConnectorEvent, ConnectorOutput } from "./connector-adapter";
import { openRouterCredentialPlugin } from "./openrouter";
import { isModelSelection, MODEL_PRESETS, NATIVE_WORKERS_AI_MODELS, resolveModelSelection,
  type ModelSelectionID } from "./model-presets";
import { getOpenRouterCatalogue } from "./openrouter-catalog";
import { assertOpenRouterImageModel, generateOpenRouterImage, getOpenRouterImageModels } from "./openrouter-images";
import { assertOpenRouterModelSupportsTools } from "./openrouter-catalog";
import { GitHubBridge, type GitHubAction } from "./github";
import { DurableGitHubPublicationGate, assertSupervisedPublicationScope } from "./github-publication-durable";
import { verifyG8Proofs, G8_PROOFS } from "./g8-smoke";
import { assessG8LiveHistory, g8LivePrompt, G8_LIVE_CHECK_VERSION, type G8LiveCheck } from "./g8-live-agent";
import { G9_PROOF_VERSION, G9_REPO, G9_BRANCH, G9_PROJECT, G9_SOURCE, G9_TEST_PATH, G9_BROKEN, G9_FIXED, G9_TEST_SOURCE, assessG9History, g9AgentPrompt, assertG9BoundGitHubOperation, type G9ProofState } from "./g9-selfdev";
import { assertScopedTool, requireSameScope, scopeStorageKey, validateProjectScope, type ProjectScope, type ScopedToolAction } from "./project-scope";
import { remoteMcpPlugin } from "./mcp-plugin";
import { assessAgentToolEvidence, hasUnfinishedAgentCheck, isUnlimitedDevAgentCheck, isAgentCheckModel, explainAgentCheckFailure, isAgentCheckKind, repairSeedCommand, repairIsVerified, REPAIR_SOURCE_BROKEN, REPAIR_TEST, agentCheckStorageKeys, DEFAULT_AGENT_CHECK_STORAGE_KEYS, OPENROUTER_BUN_CHECK_STORAGE_KEYS, type AgentCheckStorageKeys } from "./agent-check";
import { inlinePreviewAssets } from "./preview-inline";
import { BUN_RUNTIME_VERSION } from "./dev-runtime";
import { classifyAgentFailure, observeLinux, type IncidentObservation } from "./incident-diagnostics";
import { renderConversationMarkdown, validateExportIdentity, sessionExportResponse } from "./session-export";
import { archiveDownloadResponse, archiveError } from "./download-response";
import { githubRepositoryDownload } from "./github-download";
import { checkIsolation } from "./isolation-check";
import { projectContainerName, repositoryProjectSlug } from "./project-container";
import { checkIsolatedBackup } from "./isolated-backup-check";
import { repositoryImportScope } from "./repository-import-scope";
import {
  SUPERVISOR_WORKSPACE, SUPERVISOR_API_PREFIX,
  assertSupervisorBoundGitHubOperation, supervisorBearerAllowed,
  supervisorBaseCommit, supervisorBranch, supervisorFingerprint, supervisorProject,
  supervisorPrompt, supervisorResponse, supervisorTaskKey, supervisorStartOperationId,
  supervisorTurnOperationId, classifySupervisorOperation, isUntrackedLegacySupervisorOperation,
  supervisorSessionCreationDisposition, canConfirmSupervisorPreSessionCancellation,
  validateSupervisorStart, type SupervisorTask
} from "./supervisor-control";

import {
  validateCaptureRequest, captureInspectedArtifact, artifactKey, artifactIndexKey,
  artifactView, artifactIsOwnedBy, verifiedArtifactDownload, artifactErrorResponse,
  assertArtifactId, TASK_ARTIFACT_MAX_PER_TASK, TASK_ARTIFACT_SCHEMA,
  type StoredTaskArtifact
} from "./task-output-artifacts";

import { r2SessionId, r2TurnJournalKey, r2TurnAdmission,
  r2CancelledByReceipt, r2StatusWriteAllowed, r2TerminalNativeReceipt,
  r2PendingTurnReconcileAllowed, type R2TurnJournal } from "./supervisor-r2";

export const MODEL_ID = MODEL_PRESETS.cloudflare.id;

const SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED = "SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED";

/** A playable OpenCode instance backed by one Durable Object. */
export class OpenCodeAgent extends DurableObject<Env> {
  // Credentials are resolved server-side. All browsers share one owner config.
  private readonly personalConfig = this.env.SETTINGS.getByName("personal");
  private readonly providerConnection: {
    connect?: (key: string) => Promise<void>;
  } = {};
  private readonly mcpLifecycle: { reload?: () => Promise<void> } = {};
  /** Remote supervisor tasks use a single dedicated DO, never arbitrary user workspaces. */
  async startSupervisedTask(raw: unknown): Promise<unknown> {
    this.assertStagingRemote();
    const start = validateSupervisorStart(raw, await this.personalConfig.getAllowedRepositories());
    const key = supervisorTaskKey(start.requestId);
    const fingerprint = await supervisorFingerprint(start);
    let old = await this.ctx.storage.get<SupervisorTask>(key);
    let reused = Boolean(old);
    if (old && old.fingerprint !== fingerprint) throw new Error("requestId usado con otra tarea");
    if (old && isUntrackedLegacySupervisorOperation(old)) {
      let busy: boolean | undefined;
      try { busy = await this.harness.session(old.session!).busy(); }
      catch { busy = undefined; }
      const legacy = { ...old,
        status: busy ? "running" as const : "unknown" as const,
        error: busy === undefined ? "LEGACY_BUSY_STATE_UNVERIFIED" : "LEGACY_OPERATION_ID_MISSING",
        updatedAt: Date.now()
      };
      await this.ctx.storage.put(key, legacy);
      return this.supervisorTaskReceipt(legacy, true);
    }
    if (old && ["finished", "failed", "cancel_requested", "cancelled", "unanswered"].includes(old.status)) {
      return this.supervisorTaskReceipt(old, true);
    }
    if (!old && start.sourceSession) {
      // Pinned Harness create({id}) is idempotent; fork(from) has no caller ID.
      // Reject unsupported new forks before durable reservation or any external effect.
      throw new Error("SUPERVISOR_FORK_IDEMPOTENCY_UNSUPPORTED");
    }
    if (!old) {
      const selection = start.model ?? "economy";
      const model = resolveModelSelection(selection);
      if (model.providerID === "openrouter") {
        if (!await this.isOpenRouterConfigured()) throw new Error("Conecta OpenRouter antes de usar este modelo; no se inició la tarea");
        await assertOpenRouterModelSupportsTools(model.id);
      }
    }
    const job: SupervisorTask = {
      id: start.requestId, repository: start.repository,
      project: supervisorProject(start.requestId), branch: supervisorBranch(start.requestId, start.repository),
      fingerprint, createdAt: old?.createdAt ?? Date.now(), status: "preparing",
      sessionCreationAttempted: false, sessionIdPolicy: "deterministic-v1", revision: 0,
      model: start.model ?? "economy", ...(start.sourceSession ? { forkedFrom: start.sourceSession } : {})
    };
    const admission = await reserveSupervisorAdmission(this.ctx.storage, job);
    if (admission.kind === "capacity") {
      return { id: start.requestId, accepted: false, status: "capacity_rejected",
        reason: admission.reason, retryAfterMs: admission.retryAfterMs, capacity: 10 };
    }
    if (admission.kind === "reused") {
      return { ...this.supervisorTaskReceipt(admission.task, true), admitted: true,
        admissionState: admission.slot?.phase ?? "legacy_reconcile_required",
        admissionReason: admission.reason };
    }
    old = admission.task;
    reused = admission.reused;
    return this.withSupervisorStartLock(start.requestId, async () => {
      const saved = await this.ctx.storage.get<SupervisorTask>(key);
      if (!saved) throw new Error("La reserva de la tarea desapareció");
      if (["finished", "failed", "cancel_requested", "cancelled", "unanswered"].includes(saved.status) ||
          saved.pendingTurn || (saved.operationId &&
          saved.operationId !== supervisorStartOperationId(saved.id))) {
        // Replaying requestId may never resubmit the initial prompt after a turn.
        return this.supervisorTaskReceipt(saved, true);
      }
      return this.advanceSupervisedTask(saved, start, reused, admission.grant);
    }, old);
  }

  private supervisorTaskReceipt(task: SupervisorTask, reused: boolean): Record<string, unknown> {
    return { id: task.id, repository: task.repository, branch: task.branch, project: task.project,
      baseCommit: task.baseCommit, session: task.session, status: task.status, error: task.error,
      operationId: task.operationId, model: task.model, ...(task.forkedFrom ? { forkedFrom: task.forkedFrom } : {}),
      reused };
  }

  private async withSupervisorStartLock<T>(
    id: string, run: () => Promise<T>, current: SupervisorTask
  ): Promise<T | Record<string, unknown>> {
    const key = "supervisor:lock:" + id;
    const token = crypto.randomUUID();
    const acquired = await this.ctx.storage.transaction(async tx => {
      const existing = await tx.get<{ token: string; expiresAt: number }>(key);
      if (existing && existing.expiresAt > Date.now()) return false;
      await tx.put(key, { token, expiresAt: Date.now() + 60_000 });
      return true;
    });
    if (!acquired) return { ...this.supervisorTaskReceipt(current, true), retryAfterMs: 1_000 };
    try { return await run(); }
    finally {
      await this.ctx.storage.transaction(async tx => {
        const existing = await tx.get<{ token: string }>(key);
        if (existing?.token === token) await tx.delete(key);
      });
    }
  }

  private async advanceSupervisedTask(
    job: SupervisorTask, start: ReturnType<typeof validateSupervisorStart>, reused: boolean,
    grant: StartGrant
  ) {
    const key = supervisorTaskKey(job.id);
    try {
      if (!job.baseCommit) {
        // The deterministic branch reservation safely recovers after a lost GitHub response.
        await supervisorBeginExternalEffect(this.ctx.storage, grant, "github_branch");
        const branchResult = await this.githubRunner.ensureSupervisorBranch(job.repository, job.branch);
        const sha = supervisorBaseCommit(branchResult, job.repository);
        await supervisorConfirmExternalEffect(this.ctx.storage, grant, "github_branch", { confirmed: true });
        job.baseCommit = sha;
        job.updatedAt = Date.now();
        await this.ctx.storage.put(key, job);
      }
      if (!job.session) {
        if (job.sessionIdPolicy !== "deterministic-v1" || start.sourceSession ||
            supervisorSessionCreationDisposition(job) !== "create") {
          // Legacy random-id and interrupted fork effects are never replayed.
          job.status = "unknown";
          job.error = "SUPERVISOR_LEGACY_OR_SESSION_CREATION_UNCONFIRMED";
          job.updatedAt = Date.now();
          await this.ctx.storage.put(key, job);
          return this.supervisorTaskReceipt(job, reused);
        }
        // T03 writes a fenced intent before the external effect. The ID is
        // derived solely from the immutable task ID; a lost SDK reply cannot
        // generate another random session. Never release an ambiguous lease.
        const sessionId = r2SessionId(job.id);
        await supervisorBeginExternalEffect(this.ctx.storage, grant, "session_create");
        job.sessionCreationAttempted = true;
        job.updatedAt = Date.now();
        await this.ctx.storage.put(key, job);
        const createdId = await this.harness.create({ id: sessionId });
        if (createdId !== sessionId) throw new Error("SUPERVISOR_SESSION_ID_MISMATCH");
        job.session = sessionId;
        job.updatedAt = Date.now();
        await this.ctx.storage.put(key, job);
        await supervisorConfirmExternalEffect(this.ctx.storage, grant, "session_create", { confirmed: true });
        await this.bindSessionScope(sessionId, { project: job.project, repository: job.repository });
        await this.ctx.storage.put("supervisor:session:" + sessionId, job.id);
      }
      // A lost reply may interrupt a prior bind. Rechecking the same-scope
      // mapping is safe; it must never widen a session's project permissions.
      if (job.sessionIdPolicy === "deterministic-v1") {
        await this.bindSessionScope(job.session!, {
          project: job.project, repository: job.repository
        });
      }
      await this.ctx.storage.put("supervisor:session:" + job.session, job.id);
      const handle = this.harness.session(job.session!);
      if (!job.operationId) {
        await supervisorBeginExternalEffect(this.ctx.storage, grant, "configure");
        await handle.setAgent("build");
        const model = resolveModelSelection(job.model ?? "economy");
        await handle.setModel(model);
        await supervisorConfirmExternalEffect(this.ctx.storage, grant, "configure", { confirmed: true });
        // Atomically retain any concurrent cancellation or turn cursor.
        const prepared = await this.ctx.storage.transaction(async tx => {
          const fresh = await tx.get<SupervisorTask>(key);
          if (!fresh || fresh.session !== job.session || fresh.status !== "preparing" ||
              fresh.operationId || fresh.pendingTurn || fresh.cancelAmbiguous) return fresh;
          const updated: SupervisorTask = { ...fresh,
            operationId: supervisorStartOperationId(job.id), status: "running",
            revision: (fresh.revision ?? 0) + 1, updatedAt: Date.now() };
          await tx.put(key, updated);
          return updated;
        });
        if (!prepared || prepared.operationId !== supervisorStartOperationId(job.id))
          return this.supervisorTaskReceipt(await this.supervisedRecord(job.id), true);
        job = prepared;
      }
    } catch (error) {
      if (error instanceof Error && error.message === "ADMISSION_FENCE_REJECTED") {
        // A fenced-out stale starter cannot overwrite the new owner's record.
        return this.supervisorTaskReceipt(await this.supervisedRecord(job.id), true);
      }
      const slot = await supervisorAdmissionSlot(this.ctx.storage, job.id);
      const uncertainEffect = slot?.phase === "effect_unknown";
      const uncertainCreate = job.sessionCreationAttempted === true && !job.session;
      const detail = error instanceof Error ? error.message.slice(0, 180) : "No se pudo iniciar la tarea";
      job = await this.ctx.storage.transaction(async tx => {
        const fresh = await tx.get<SupervisorTask>(key);
        if (!fresh) throw new Error("SUPERVISOR_TASK_MISSING_AFTER_FAILURE");
        if (fresh.status === "cancel_requested" || fresh.status === "cancelled" ||
            fresh.pendingTurn || (fresh.operationId && fresh.operationId !== job.operationId))
          return fresh;
        const updated: SupervisorTask = { ...fresh,
          status: uncertainEffect || uncertainCreate ? "unknown" : "failed",
          error: uncertainCreate ? "SUPERVISOR_SESSION_CREATION_UNCONFIRMED: " + detail :
            uncertainEffect ? "ADMISSION_EXTERNAL_EFFECT_UNCONFIRMED: " + detail : detail,
          revision: (fresh.revision ?? 0) + 1, updatedAt: Date.now() };
        await tx.put(key, updated);
        return updated;
      });
    }
    if (job.status === "failed" || !job.session || !job.operationId || !job.baseCommit) {
      return this.supervisorTaskReceipt(job, reused);
    }
    try {
      await supervisorBeginExternalEffect(this.ctx.storage, grant, "submit");
      const receipt = await this.harness.session(job.session).submit(
        supervisorPrompt(start, job.branch, job.project, job.baseCommit),
        { operationId: job.operationId, whenBusy: "followUp" }
      );
      await supervisorConfirmExternalEffect(this.ctx.storage, grant, "submit",
        { confirmed: typeof receipt.accepted === "boolean" });
      job.status = "running";
      job.error = undefined;
      job.updatedAt = Date.now();
      await this.ctx.storage.put(key, job);
      return { ...this.supervisorTaskReceipt(job, reused), accepted: receipt.accepted };
    } catch (error) {
      // The durable operation may have been accepted before the RPC failed.
      // Keep the same operationId so a retry can retrieve the original receipt.
      job.status = "unknown";
      job.error = error instanceof Error ? error.message.slice(0, 230) : "No se pudo confirmar el envío";
      job.updatedAt = Date.now();
      await this.ctx.storage.put(key, job);
      return this.supervisorTaskReceipt(job, reused);
    }
  }

  /** This guard is enforced at the DO boundary, not only by the MCP client. */
  private assertStagingRemote(): void {
    if ((this.env as Env & { OPENCODE_SUPERVISOR_ENABLED?: string }).OPENCODE_SUPERVISOR_ENABLED !== "true") {
      throw new Error("REMOTE_STAGING_ONLY");
    }
  }

  /** Cross-Worker RPC: only the Staging namespace can call these methods. */
  /** Remote status must never enumerate all SDK session objects in the shared DO. */
  async remoteSupervisorStatus(): Promise<unknown> {
    this.assertStagingRemote();
    const index = await this.ctx.storage.list<SupervisorTask>({
      prefix: "supervisor:task:", limit: 101
    });
    const count = supervisorTaskCount(index, 100);
    return {
      environment: "staging", worker: "opencode-g1-staging", ready: true,
      schema: "opencode.staging-control.v2",
      supervisedSessions: count.supervisedSessions,
      supervisedCountComplete: count.countComplete,
      ...(count.limited ? { supervisedCountAtLeast: count.supervisedSessions } : {}),
      defaultModel: "economy",
      capabilities: ["status", "models", "repositories", "sessions", "start", "inspect", "continue",
        "select_model", "progress", "cancel", "review", "mcp_discovery", "mcp_call", "incidents", "agent_check"]
    };
  }

  async remoteSupervisorModels(): Promise<unknown> {
    this.assertStagingRemote();
    const openRouterConfigured = await this.isOpenRouterConfigured();
    const models: Array<Record<string, unknown>> = Object.entries(MODEL_PRESETS)
      .filter(([, model]) => model.providerID === "cloudflare" || openRouterConfigured)
      .map(([selection, model]) => ({ selection, ...model }));
    let catalogueAvailable = true;
    let catalogueTruncated = false;
    if (openRouterConfigured) {
      try {
        const catalogue = await getOpenRouterCatalogue();
        const dynamic = catalogue
          .filter(model => !Object.values(MODEL_PRESETS).some(preset =>
            preset.providerID === "openrouter" && preset.id === model.id))
          .sort((a, b) => {
            const aPrice = (a.promptPerMillion ?? Number.MAX_SAFE_INTEGER) +
              (a.completionPerMillion ?? Number.MAX_SAFE_INTEGER);
            const bPrice = (b.promptPerMillion ?? Number.MAX_SAFE_INTEGER) +
              (b.completionPerMillion ?? Number.MAX_SAFE_INTEGER);
            return aPrice - bPrice || a.name.localeCompare(b.name);
          });
        catalogueTruncated = dynamic.length > 30;
        for (const model of dynamic.slice(0, 30)) models.push({
          selection: "openrouter:" + model.id, providerID: "openrouter", id: model.id,
          name: model.name, contextLength: model.contextLength, tools: model.tools,
          imageInput: model.imageInput,
          pricingPerMillion: { prompt: model.promptPerMillion, completion: model.completionPerMillion }
        });
      } catch {
        catalogueAvailable = false;
      }
    }
    return { targetWorker: "opencode-g1-staging", defaultSelection: "economy",
      openRouterConfigured, catalogueAvailable, catalogueTruncated, models };
  }

  async remoteSupervisorRepositories(): Promise<unknown> {
    this.assertStagingRemote();
    return { targetWorker: "opencode-g1-staging", repositories: await this.personalConfig.getAllowedRepositories() };
  }

  /**
   * Consult only indexed supervised tasks, never OpenCodeHarness.sessions.list().
   * Retains a bounded 100-session response, probes actual busy state in batches
   * of four, and fails conservatively if any busy probe is inconclusive.
   * Non-supervised conversations remain reachable through their own interface.
   */
  async remoteSupervisorSessions(): Promise<unknown> {
    this.assertStagingRemote();
    const index = await this.ctx.storage.list<SupervisorTask>({
      prefix: "supervisor:task:", limit: 101
    });
    const result = await collectSupervisorDirectory(index,
      session => this.harness.session(session).busy(), 100, 4);
    return { environment: "staging", ...result };
  }

  async remoteSupervisorInspectSession(id: string): Promise<unknown> {
    this.assertStagingRemote();
    if (!/^ses[A-Za-z0-9_]{1,64}$/.test(id)) throw new Error("Identificador de sesión inválido");
    // No byte-bounded transcript API is available in agents@0.33.0.
    // Refuse this read before materializing any session history.
    throw new Error(SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED);
  }

  private async supervisorModel(model: unknown): Promise<{ providerID: string; id: string; selection: ModelSelectionID }> {
    if (!isModelSelection(model)) throw new Error("Selecciona un modelo del catálogo OpenCode");
    const resolved = resolveModelSelection(model);
    if (resolved.providerID === "openrouter") {
      if (!await this.isOpenRouterConfigured()) throw new Error("OpenRouter no está configurado en Staging");
      await assertOpenRouterModelSupportsTools(resolved.id);
    }
    return { ...resolved, selection: model };
  }

  async remoteSupervisorSelectModel(id: string, model: string): Promise<unknown> {
    this.assertStagingRemote();
    const selected = await this.supervisorModel(model);
    const task = await this.supervisedRecord(id);
    if (!task.session || ["cancelled", "cancel_requested", "failed"].includes(task.status)) {
      throw new Error("Sesión no disponible");
    }
    const handle = this.harness.session(task.session);
    if (await handle.busy()) throw new Error("La operación activa debe concluir antes del cambio");
    await handle.setModel({ providerID: selected.providerID, id: selected.id });
    task.model = selected.selection;
    task.updatedAt = Date.now();
    await this.ctx.storage.put(supervisorTaskKey(id), task);
    return { environment: "staging", taskId: id, session: task.session,
      selection: selected.selection, providerID: selected.providerID, id: selected.id };
  }

  async remoteSupervisorContinue(raw: unknown): Promise<unknown> {
    this.assertStagingRemote();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Comando inválido");
    const v = raw as Record<string, unknown>;
    if (Object.keys(v).some(k => !["id", "turnId", "prompt"].includes(k))) throw new Error("Parámetros desconocidos");
    const id = String(v.id ?? "");
    supervisorTaskKey(id);
    if (typeof v.turnId !== "string" || !/^[a-f0-9]{16}$/.test(v.turnId)) throw new Error("turnId inválido");
    if (typeof v.prompt !== "string" || v.prompt.trim().length < 12 || v.prompt.length > 5000)
      throw new Error("Instrucción inválida");
    const admission = await supervisorAdmissionSlot(this.ctx.storage, id);
    if (admission?.phase === "effect_unknown" || admission?.phase === "reserved")
      throw new Error("SUPERVISOR_INITIAL_EFFECT_NOT_SETTLED");
    const key = r2TurnJournalKey(id, v.turnId);
    const taskKey = supervisorTaskKey(id);
    const data = new TextEncoder().encode(v.prompt.trim());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
      b => b.toString(16).padStart(2, "0")).join("");
    const operationId = supervisorTurnOperationId(id, v.turnId);

    // Atomically journal intent, operation ID, and the newest task cursor
    // BEFORE making an SDK call. This is per-task arbitration, not T03's scheduler.
    const reservation = await this.ctx.storage.transaction(async tx => {
      const task = await tx.get<SupervisorTask>(taskKey);
      if (!task?.session) throw new Error("Tarea no disponible");
      const previous = await tx.get<R2TurnJournal>(key);
      if (previous && (previous.hash !== hash || previous.session !== task.session ||
          previous.operationId !== operationId)) throw new Error("turnId reutilizado con otra instrucción");
      if (previous && !task.pendingTurn) {
        // One native operationId already exists or the task has moved on.
        // Do not submit a second time from a stale HTTP retry.
        return { kind: "existing" as const, task, previous };
      }
      const decision = r2TurnAdmission(task, operationId);
      if (decision === "denied") throw new Error("SUPERVISOR_TURN_DENIED_TERMINAL_OR_CANCEL");
      if (decision === "busy") throw new Error("SUPERVISOR_TURN_IN_FLIGHT");
      if (!previous) {
        const journal: R2TurnJournal = { hash, operationId, session: task.session,
          phase: "intent", revision: (task.revision ?? 0) + 1 };
        await tx.put(key, journal);
        const updated: SupervisorTask = { ...task,
          pendingTurn: { turnId: v.turnId as string, operationId },
          operationId, status: "running", revision: journal.revision, updatedAt: Date.now() };
        await tx.put(taskKey, updated);
        return { kind: "submit" as const, task: updated, journal };
      }
      return { kind: "submit" as const, task, journal: previous };
    });
    if (reservation.kind === "existing") {
      return { taskId: id, operationId, session: reservation.task.session,
        status: reservation.task.status, reused: true, confirmed: false,
        journalPhase: reservation.previous.phase };
    }
    // Cancellation may win just after the transaction; never deliberately
    // send a queued steer after observing the cancellation intent.
    const current = await this.supervisedRecord(id);
    if (current.status === "cancel_requested" || current.status === "cancelled" ||
        current.pendingTurn?.operationId !== operationId) {
      return { taskId: id, operationId, status: "unknown", confirmed: false,
        reason: "SUPERVISOR_TURN_FENCED_BEFORE_SUBMIT" };
    }
    let accepted: boolean | undefined;
    let sendError: string | undefined;
    try {
      const receipt = await this.harness.session(reservation.task.session!).submit(
        v.prompt.trim(), { operationId, whenBusy: "steer" });
      accepted = receipt.accepted;
    } catch (error) {
      sendError = error instanceof Error ? error.message.slice(0, 240) : "No confirmado";
    }
    const persisted = await this.ctx.storage.transaction(async tx => {
      const journal = await tx.get<R2TurnJournal>(key);
      const fresh = await tx.get<SupervisorTask>(taskKey);
      if (!journal || !fresh || journal.operationId !== operationId)
        throw new Error("SUPERVISOR_TURN_JOURNAL_MISSING");
      await tx.put(key, { ...journal, phase: sendError ? "unknown" as const : "accepted" as const });
      if (fresh.pendingTurn?.operationId !== operationId) return fresh;
      // Never overwrite cancellation or erase its ambiguous concurrent steer.
      if (fresh.status === "cancel_requested" || fresh.cancelAmbiguous) return fresh;
      const updated: SupervisorTask = { ...fresh,
        ...(sendError ? { status: "unknown" as const, error: sendError } :
          { status: "running" as const, error: undefined }),
        pendingTurn: undefined, revision: (fresh.revision ?? 0) + 1, updatedAt: Date.now() };
      await tx.put(taskKey, updated);
      return updated;
    });
    if (persisted.status === "cancel_requested" || persisted.cancelAmbiguous) {
      return { taskId: id, session: persisted.session, operationId,
        status: "cancel_requested", confirmed: false, accepted,
        reason: "CONCURRENT_CANCEL_RECONCILIATION_REQUIRED" };
    }
    return { taskId: id, session: persisted.session, operationId,
      status: sendError ? "unknown" : "submitted", accepted, reused: accepted === false,
      confirmed: false, ...(sendError ? { error: sendError } : {}) };
  }

  async remoteSupervisorInspect(id: string): Promise<unknown> {
    this.assertStagingRemote();
    // Durable supervisor ledger snapshot only: not a live OpenCode operation result.
    const task = await this.supervisedRecord(id);
    return {
      status: {
        id: task.id, repository: task.repository, project: task.project,
        branch: task.branch, baseCommit: task.baseCommit, session: task.session,
        operationId: task.operationId, model: task.model,
        startedAt: task.createdAt, updatedAt: task.updatedAt,
        status: task.status, error: task.error,
        snapshot: true, source: "supervisor-task-ledger",
        reviewRequired: true, passed: false, verified: false
      },
      snapshot: true, transcriptAvailable: false,
      transcriptError: SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED,
      progressAvailableViaCursor: true, reviewRequired: true
    };
  }

  async remoteSupervisorMcpServers(): Promise<unknown> {
    this.assertStagingRemote();
    const host = createDynamicMcpHost(() => this.personalConfig.getRemoteMcps());
    return { targetWorker: "opencode-g1-staging", servers: await host.listServers() };
  }

  async remoteSupervisorMcpTools(server: string): Promise<unknown> {
    this.assertStagingRemote();
    const host = createDynamicMcpHost(() => this.personalConfig.getRemoteMcps());
    return { targetWorker: "opencode-g1-staging", server, tools: await host.listTools(server) };
  }

  async remoteSupervisorMcpCall(input: { server: string; name: string; arguments?: Record<string, unknown> }): Promise<unknown> {
    this.assertStagingRemote();
    const host = createDynamicMcpHost(() => this.personalConfig.getRemoteMcps());
    return { targetWorker: "opencode-g1-staging", server: input.server, tool: input.name,
      result: await host.callTool(input) };
  }

  async remoteSupervisorDiagnostics(): Promise<unknown> {
    this.assertStagingRemote();
    return { targetWorker: "opencode-g1-staging", status: await this.remoteSupervisorStatus(),
      incidents: await this.personalConfig.listIncidents() };
  }

  async remoteSupervisorAgentCheck(model: "cloudflare" | "economy" | "review", kind: "linux" | "repair" | "bun"): Promise<unknown> {
    this.assertStagingRemote();
    return this.startAgentCheck(model, kind);
  }

  async remoteSupervisorAgentCheckStatus(scope?: "openrouter"): Promise<unknown> {
    this.assertStagingRemote();
    return scope === "openrouter" ? this.openRouterAgentCheckStatus() : this.agentCheckStatus();
  }

  private async supervisedRecord(id: string): Promise<SupervisorTask> {
    const job = await this.ctx.storage.get<SupervisorTask>(supervisorTaskKey(id));
    if (!job) throw new Error("Tarea del supervisor inexistente");
    return job;
  }

  /** Server-derived binding: never trust a model-provided project/session. */
  private async scopedArtifactTask(id: string): Promise<{
    id: string; project: string; session: string; repository: string
  }> {
    this.assertStagingRemote();
    const job = await this.supervisedRecord(id);
    const session = job.session;
    if (!session || job.project !== supervisorProject(id)) throw new Error("ARTIFACT_SCOPE_UNAVAILABLE");
    const [scope, reverse] = await Promise.all([
      this.ctx.storage.get<ProjectScope>(scopeStorageKey(session)),
      this.ctx.storage.get<string>("supervisor:session:" + session)
    ]);
    if (reverse !== id || scope?.project !== job.project ||
        scope.repository?.toLowerCase() !== job.repository.toLowerCase()) {
      throw new Error("ARTIFACT_SCOPE_UNAVAILABLE");
    }
    return { id, project: job.project, session, repository: job.repository };
  }

  /** Capture only hash-verified bytes from an isolated project's binary reader.
   * Hard bound: 32 KiB UTF-8, 8 immutable files per task, expires after 12 h.
   * This never accepts data/file/https URLs, binary blobs, or arbitrary /bundle.
   */
  async supervisedArtifactCapture(id: string, raw: unknown): Promise<unknown> {
    const task = await this.scopedArtifactTask(id);
    const request = validateCaptureRequest(raw);
    const state = await this.supervisedTaskStatus(id) as { status?: string };
    if (state.status !== "finished") throw new Error("ARTIFACT_TASK_NOT_FINISHED");
    const dev = this.env.DEV.getByName(projectContainerName(task.project));
    const inspected = await dev.readTaskArtifact(task.project, request.path);
    const prepared = await captureInspectedArtifact({
      requestId: task.id, ownerProject: task.project, ownerSession: task.session,
      repository: task.repository, request, inspected
    });
    const idKey = artifactKey(id, prepared.artifactId);
    const indexKey = artifactIndexKey(id);
    const saved = await this.ctx.storage.transaction(async tx => {
      const existing = await tx.get<StoredTaskArtifact>(idKey);
      if (existing && existing.expiresAt > Date.now()) {
        if (existing.sha256 !== prepared.sha256 ||
            !artifactIsOwnedBy(existing, task)) throw new Error("ARTIFACT_CONFLICT");
        return existing;
      }
      if (existing) await tx.delete(idKey);
      const index = (await tx.get<string[]>(indexKey)) ?? [];
      if (!Array.isArray(index) || index.length > TASK_ARTIFACT_MAX_PER_TASK)
        throw new Error("ARTIFACT_INDEX_INVALID");
      const live: string[] = [];
      const now = Date.now();
      for (const priorId of index) {
        const key = artifactKey(id, priorId);
        const value = await tx.get<StoredTaskArtifact>(key);
        if (value && artifactIsOwnedBy(value, task, now)) live.push(priorId);
        else await tx.delete(key); // Opportunistic retention cleanup.
      }
      if (live.length >= TASK_ARTIFACT_MAX_PER_TASK) throw new Error("ARTIFACT_TASK_LIMIT");
      await tx.put(idKey, prepared);
      await tx.put(indexKey, [...live, prepared.artifactId]);
      return prepared;
    });
    return artifactView(saved);
  }

  /** A bounded manifest: no transcript, raw paths, stored bytes or credentials. */
  async supervisedTaskArtifacts(id: string): Promise<unknown> {
    const task = await this.scopedArtifactTask(id);
    const status = await this.supervisedTaskStatus(id) as { status?: string; operationId?: string };
    const index = (await this.ctx.storage.get<string[]>(artifactIndexKey(id))) ?? [];
    if (!Array.isArray(index) || index.length > TASK_ARTIFACT_MAX_PER_TASK) {
      throw new Error("ARTIFACT_INDEX_INVALID");
    }
    const records = await Promise.all(index.map(key =>
      this.ctx.storage.get<StoredTaskArtifact>(artifactKey(id, key))));
    const now = Date.now();
    return {
      schema: TASK_ARTIFACT_SCHEMA, requestId: id, status: status.status ?? "unknown",
      artifacts: records.filter(x => artifactIsOwnedBy(x, task, now)).map(x => artifactView(x!)),
      summary: { text: "", available: false, truncated: false },
      errors: [],
      evidence: { sessionId: task.session, operationId: status.operationId ?? null,
        projectId: task.project, byteReadback: "captured", collectorVerification: "pending" },
      passed: false, verified: false, reviewRequired: true
    };
  }

  /** Bytes survive a DO restart (SQLite storage), but expired records fail closed. */
  async supervisedTaskArtifactDownload(id: string, artifactId: string): Promise<Response> {
    const task = await this.scopedArtifactTask(id);
    assertArtifactId(artifactId);
    const record = await this.ctx.storage.get<StoredTaskArtifact>(artifactKey(id, artifactId));
    if (!record) return artifactErrorResponse("ARTIFACT_NOT_FOUND", 404);
    if (Date.now() >= record.expiresAt) {
      await this.ctx.storage.delete(artifactKey(id, artifactId));
      return artifactErrorResponse("ARTIFACT_EXPIRED", 410);
    }
    if (record.artifactId !== artifactId || record.requestId !== id ||
        !artifactIsOwnedBy(record, task)) return artifactErrorResponse("ARTIFACT_NOT_FOUND", 404);
    return await verifiedArtifactDownload(record);
  }

  async supervisedTaskStatus(id: string): Promise<unknown> {
    this.assertStagingRemote();
    const job = await this.supervisedRecord(id);
    const admission = await supervisorAdmissionSlot(this.ctx.storage, id);
    const base = { id: job.id, repository: job.repository, project: job.project,
      admissionState: admission?.phase ?? "legacy_or_released",
      ...(admission?.effect ? { admissionEffect: admission.effect } : {}),
      branch: job.branch, baseCommit: job.baseCommit, session: job.session, startedAt: job.createdAt,
      updatedAt: job.updatedAt, operationId: job.operationId, model: job.model, error: job.error,
      ...(job.forkedFrom ? { forkedFrom: job.forkedFrom } : {}) };
    if (!job.session) {
      const uncertain = job.sessionCreationAttempted === true;
      return { ...base, status: uncertain ? "unknown" : job.status,
        error: uncertain ? (job.error ?? "SUPERVISOR_SESSION_CREATION_UNCONFIRMED") : job.error,
        reviewRequired: true, passed: false, verified: false };
    }
    // A stored "failed" with a native operationId can still have a later
    // completion receipt: reconcile instead of hiding it as terminal.
    if (["cancelled", "failed", "preparing"].includes(job.status) && !job.operationId)
      return { ...base, status: job.status, reviewRequired: true, passed: false, verified: false };
    const handle = this.harness.session(job.session);
    const waitController = new AbortController();
    const waitTimer = setTimeout(() => waitController.abort(), 120);
    let operation: Awaited<ReturnType<typeof handle.wait>> | undefined;
    let waitError: string | undefined;
    try {
      if (job.operationId) operation = await handle.wait(job.operationId, waitController.signal);
    } catch (error) {
      if (!waitController.signal.aborted) waitError = error instanceof Error ? error.message.slice(0, 200) : "No se pudo esperar la operación";
    } finally {
      clearTimeout(waitTimer);
    }
    if (job.operationId && operation &&
        (operation.status === "done" ||
          operation.status === "unanswered" && operation.reason !== "not_found")) {
      await reconcileSupervisorSubmittedEffect(this.ctx.storage, id, job.operationId, operation);
    }
    // Never materialize a complete tool transcript in the supervisor's
    // memory-constrained Durable Object on every status poll. The durable
    // OpenCode event log is incremental and its cursor survives DO restarts.
    const busy = await handle.busy();
    let toolCounts: SupervisorToolCounts | undefined;
    let toolCountsComplete = false;
    let toolCountsError: string | undefined;
    try {
      const metricsKey = "supervisor:tool-counts-v1:" + id;
      const saved = await this.ctx.storage.get<SupervisorToolCounts>(metricsKey);
      if (saved && !validSupervisorToolCounts(saved)) throw new Error("SUPERVISOR_METRICS_INVALID");
      const prior = saved ?? EMPTY_SUPERVISOR_TOOL_COUNTS;
      const scan = await foldSupervisorToolLog(handle.log({after: prior.cursor, follow: false}), prior, 256);
      const committed = await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<SupervisorToolCounts>(metricsKey);
        if (current && !validSupervisorToolCounts(current)) throw new Error("SUPERVISOR_METRICS_INVALID");
        // Parallel readers must never double count the same durable events.
        if (current && current.cursor > prior.cursor) return current;
        if (current && current.cursor < prior.cursor) throw new Error("SUPERVISOR_METRICS_CURSOR_REGRESSION");
        if (scan.metrics.cursor > prior.cursor) await tx.put(metricsKey, scan.metrics);
        return scan.metrics;
      });
      toolCounts = committed;
      toolCountsComplete = scan.complete && committed.cursor === scan.metrics.cursor;
    } catch (error) {
      // A status check must remain useful even if an incremental metrics read
      // fails. Unknown counts are not zeros and must not yield a false PASS.
      toolCountsError = error instanceof Error ? error.message.slice(0, 200) : "SUPERVISOR_METRICS_UNAVAILABLE";
    }
    // The read may have started before a continue/cancel committed. Avoid a
    // stale status write reverting the latest operation cursor or cancel intent.
    const reconciled = await this.ctx.storage.transaction(async tx => {
      const fresh = await tx.get<SupervisorTask>(supervisorTaskKey(id));
      if (!fresh) throw new Error("Tarea del supervisor inexistente");
      if (!job.operationId || fresh.operationId !== job.operationId ||
          fresh.status === "cancelled") return fresh;
      // Persist an authentic SDK terminal receipt with the turn journal.
      // not_found and timeouts are explicitly NOT settled outcomes.
      const turnPrefix = "rc-turn-" + id + "-";
      if (fresh.operationId?.startsWith(turnPrefix) && r2TerminalNativeReceipt(operation)) {
        const turnId = fresh.operationId.slice(turnPrefix.length);
        if (/^[a-f0-9]{16}$/.test(turnId)) {
          const turnKey = r2TurnJournalKey(id, turnId);
          const journal = await tx.get<R2TurnJournal>(turnKey);
          if (journal?.operationId === fresh.operationId && journal.phase !== "settled") {
            await tx.put(turnKey, { ...journal, phase: "settled" as const,
              receiptStatus: operation!.status, receiptReason: operation!.reason?.slice(0, 120),
              settledAt: Date.now() });
          }
        }
      }
      const settlePending = r2PendingTurnReconcileAllowed(fresh, job.operationId, operation);
      if (fresh.pendingTurn && !settlePending) return fresh;
      if (!settlePending && !r2StatusWriteAllowed(fresh, job.operationId)) return fresh;
      const state = settlePending ? { ...fresh, pendingTurn: undefined } : fresh;
      let status = classifySupervisorOperation(state, busy, operation);
      if (status === "cancelled" &&
          (!r2CancelledByReceipt(state, job.operationId, operation) || state.cancelAmbiguous)) {
        status = "unknown"; // no false terminal for an ambiguous concurrent steer
      }
      if (state.cancelAmbiguous && status === "finished") status = "unknown";
      const nextError = operation?.status === "unanswered"
        ? operation.reason?.slice(0, 240)
        : operation?.status === "done" ? undefined : state.error;
      if (!settlePending && status === state.status && nextError === state.error) return fresh;
      const next: SupervisorTask = { ...state, status, error: nextError,
        revision: (fresh.revision ?? 0) + 1, updatedAt: Date.now() };
      await tx.put(supervisorTaskKey(id), next);
      return next;
    });
    return { ...base, operationId: reconciled.operationId, updatedAt: reconciled.updatedAt,
      status: reconciled.status, error: reconciled.error,
      toolCalls: toolCounts?.toolCalls ?? null,
      completedTools: toolCounts?.completedTools ?? null,
      failedTools: toolCounts?.failedTools ?? null,
      toolCountsComplete, toolCountsError, reviewRequired: true,
      operationReason: reconciled.operationId === job.operationId ? operation?.reason : undefined,
      operationAnswerAvailable: reconciled.operationId === job.operationId && Boolean(operation?.text),
      waitError: reconciled.operationId === job.operationId ? waitError : "STALE_OPERATION_CURSOR",
      passed: false, verified: false };
  }

  async remoteSupervisorProgress(id: string, after = 0): Promise<unknown> {
    this.assertStagingRemote();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Cursor de eventos inválido");
    const task = await this.supervisedRecord(id);
    if (!task.session) return { taskId: id, events: [], nextAfter: after,
      status: task.status, truncated: false, gapDetected: false, scanned: 0 };
    // Reads at most 128 raw records; filtered reasoning records also advance
    // the durable cursor. No history() call or post-hoc transcript slicing.
    const page = await projectSupervisorProgress(
      this.harness.session(task.session).log({ after, follow: false }), after);
    return { taskId: id, session: task.session, status: task.status, ...page };
  }

  async cancelSupervisedTask(id: string): Promise<unknown> {
    this.assertStagingRemote();
    let job = await this.supervisedRecord(id);
    if (["cancelled", "failed", "finished", "unanswered"].includes(job.status))
      return { id, status: job.status };
    if (!job.session) {
      // Serialize the no-session decision with the durable start lease and
      // task record. A missing session ID alone proves nothing after a reset.
      const outcome = await this.ctx.storage.transaction(async tx => {
        const key = supervisorTaskKey(id);
        const fresh = await tx.get<SupervisorTask>(key);
        if (!fresh) throw new Error("Tarea del supervisor inexistente");
        const lock = await tx.get<{ token: string }>("supervisor:lock:" + id);
        const admissionActive = await hasSupervisorAdmissionSlot(tx, id);
        if (fresh.session) return { kind: "bound" as const, task: fresh };
        if (!canConfirmSupervisorPreSessionCancellation(fresh, Boolean(lock) || admissionActive)) {
          return { kind: "uncertain" as const, task: fresh };
        }
        if (["cancelled", "failed", "finished", "unanswered"].includes(fresh.status)) {
          return { kind: "terminal" as const, task: fresh };
        }
        const stopped = { ...fresh, status: "cancelled" as const, updatedAt: Date.now() };
        await tx.put(key, stopped);
        return { kind: "confirmed" as const, task: stopped };
      });
      if (outcome.kind === "confirmed") {
        return { id, status: "cancelled", confirmed: true, reason: "start not entered; no session creation attempted" };
      }
      if (outcome.kind === "uncertain") {
        return { id, status: "unknown", confirmed: false,
          recordedStatus: outcome.task.status, reason: "SUPERVISOR_SESSION_START_UNCONFIRMED" };
      }
      job = outcome.task;
      if (outcome.kind === "terminal") return { id, status: job.status };
    }
    // Cancellation intent and turn-journal read share one task transaction.
    // A simultaneous steer is therefore visible as an unresolved effect.
    const intent = await this.ctx.storage.transaction(async tx => {
      const fresh = await tx.get<SupervisorTask>(supervisorTaskKey(id));
      if (!fresh) throw new Error("Tarea del supervisor inexistente");
      if (["cancelled", "failed", "finished", "unanswered"].includes(fresh.status))
        return { kind: "terminal" as const, task: fresh };
      if (!fresh.session || !fresh.operationId) {
        const uncertain: SupervisorTask = { ...fresh, status: "unknown",
          error: "OpenCode operation id missing",
          revision: (fresh.revision ?? 0) + 1, updatedAt: Date.now() };
        await tx.put(supervisorTaskKey(id), uncertain);
        return { kind: "uncertain" as const, task: uncertain };
      }
      if (fresh.status === "cancel_requested")
        return { kind: "existing" as const, task: fresh };
      const next: SupervisorTask = { ...fresh, status: "cancel_requested",
        cancelAmbiguous: Boolean(fresh.cancelAmbiguous || fresh.pendingTurn),
        revision: (fresh.revision ?? 0) + 1, updatedAt: Date.now() };
      await tx.put(supervisorTaskKey(id), next);
      return { kind: "abort" as const, task: next };
    });
    if (intent.kind === "terminal") return { id, status: intent.task.status };
    if (intent.kind === "uncertain") return { id, status: "unknown",
      confirmed: false, reason: intent.task.error };
    if (intent.kind === "existing") return { id, status: "cancel_requested",
      confirmed: false, reason: "ABORT_RECEIPT_RECONCILIATION_PENDING" };
    let abortAccepted = false;
    let abortError: string | undefined;
    try {
      abortAccepted = await this.harness.session(intent.task.session!).abort(intent.task.operationId!);
    } catch (error) {
      abortError = error instanceof Error ? error.message.slice(0, 200) : "Abort failed";
    }
    const current = await this.supervisedTaskStatus(id) as {
      status?: string; operationReason?: string;
    };
    // An abort RPC boolean is never a terminal cancellation receipt.
    return { id, status: current.status ?? "cancel_requested",
      confirmed: current.status === "cancelled" && !intent.task.cancelAmbiguous,
      abortAccepted, abortError, operationReason: current.operationReason };
  }

  async supervisedTaskTranscript(id: string): Promise<string> {
    this.assertStagingRemote();
    const job = await this.supervisedRecord(id);
    if (!job.session) throw new Error("La tarea todavía no tiene sesión");
    // Clipping a full history afterward does not bound memory usage.
    throw new Error(SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED);
  }

  async supervisedTaskReview(id: string): Promise<unknown> {
    this.assertStagingRemote();
    const job = await this.supervisedRecord(id);
    const result = await this.githubRunner.execute({
      action: "review", repo: job.repository, branch: job.branch
    });
    return { id, repository: job.repository, branch: job.branch, review: result,
      reviewRequired: true, approved: false };
  }

  async refreshMcps(): Promise<{ refreshed: boolean }> {
    if (!this.mcpLifecycle.reload) return { refreshed: false };
    await this.mcpLifecycle.reload();
    return { refreshed: true };
  }

  async installTokenEconomizer(): Promise<{ installed: true; commit: string }> {
    return this.env.DEV.getByName("connector-host-v1").installTokenEconomizer();
  }

  private async runConnector(connectorID: string, event: ConnectorEvent): Promise<ConnectorOutput> {
    if (connectorID !== "token-economizer") throw new Error("Conector no admitido.");
    if (!(await this.personalConfig.connectorSettings()).tokenEconomizerEnabled) return {};
    try {
      const project = event.project || "global";
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(project)) throw new Error("Proyecto del conector inválido.");
      const transcriptPath = event.name === "Stop" || event.name === "SessionEnd"
        ? "/workspace/projects/opencode-connectors/state/opencode-sessions/" + event.sessionID + ".json"
        : undefined;
      const payload = {
        session_id: event.sessionID,
        cwd: "/workspace/projects/opencode-connectors/workspaces/" + project,
        hook_event_name: event.name,
        ...(event.promptID ? { prompt_id: event.promptID } : {}),
        ...(event.prompt ? { prompt: event.prompt } : {}),
        ...(event.toolName ? { tool_name: event.toolName } : {}),
        ...(event.toolUseID ? { tool_use_id: event.toolUseID } : {}),
        ...(event.toolInput ? { tool_input: event.toolInput } : {}),
        ...(event.toolResponse ? { tool_response: event.toolResponse } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(transcriptPath ? { transcript_path: transcriptPath, stop_hook_active: false } : {}),
        ...(event.name === "SessionStart" ? { source: "startup" } : {})
      };
      const output = await this.env.DEV.getByName("connector-host-v1").runTokenEconomizerHook(project, {
        payload, ...(event.transcript && transcriptPath ? { transcript: event.transcript } : {})
      });
      const normalized: ConnectorOutput = {};
      if (output && typeof output === "object" && !Array.isArray(output)) {
        const record = output as Record<string, unknown>;
        const hookOutput = record.hookSpecificOutput && typeof record.hookSpecificOutput === "object"
          ? record.hookSpecificOutput as Record<string, unknown> : {};
        const context = hookOutput.additionalContext ?? record.additionalContext ?? record.additional_context;
        if (typeof context === "string") normalized.additionalContext = context;
        if (typeof record.systemMessage === "string") normalized.systemMessage = record.systemMessage;
      }
      await this.personalConfig.recordTokenEconomizerHook(
        event.name, true, normalized.additionalContext?.length ?? 0
      ).catch(() => undefined);
      return normalized;
    } catch (error) {
      await this.personalConfig.recordTokenEconomizerHook(event.name, false).catch(() => undefined);
      throw error;
    }
  }
  /** Legacy full export has no SDK byte-bounded paging primitive.
   * Reject before sessions.list(), history(), or JSON.stringify().
   * Persisted sessions remain intact; a future indexed export needs its own gate.
   */
  async exportSessionData(sessionID: string): Promise<string> {
    if (!/^ses[A-Za-z0-9_]{1,64}$/.test(sessionID))
      throw new Error("SESSION_EXPORT_ID_INVALID");
    throw new Error("SESSION_EXPORT_PAGINATION_UNAVAILABLE_LEGACY");
  }

  private sessionModelsKey(sessionID: string): string {
    return "session-model-roles-v1:" + sessionID;
  }

  async setSessionModels(sessionID: string, options: { decisionModel?: unknown; imageModel?: unknown }): Promise<void> {
    const roles: { decisionModel?: string; imageModel?: string } = {};
    if (options.decisionModel !== undefined) {
      if (!isModelSelection(options.decisionModel)) throw new Error("Modelo de decisión inválido");
      roles.decisionModel = options.decisionModel;
    }
    if (options.imageModel !== undefined) {
      if (typeof options.imageModel !== "string" || options.imageModel.length > 160 ||
          !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:+-]*$/i.test(options.imageModel)) {
        throw new Error("Modelo de imagen inválido");
      }
      roles.imageModel = options.imageModel;
    }
    await this.ctx.storage.put(this.sessionModelsKey(sessionID), roles);
  }

  async sessionImageModel(sessionID: string): Promise<string | undefined> {
    return (await this.ctx.storage.get<{ imageModel?: string }>(this.sessionModelsKey(sessionID)))?.imageModel;
  }

  private async generateSessionImage(sessionID: string, prompt: string) {
    const [model, key] = await Promise.all([
      this.sessionImageModel(sessionID),
      Promise.resolve((this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY)
        .then(value => value || this.personalConfig.getOpenRouterKey())
    ]);
    if (!model) throw new Error("Selecciona un modelo de imagen en la plantilla activa.");
    if (!key) throw new Error("Conecta OpenRouter antes de generar imágenes.");
    return generateOpenRouterImage({ apiKey: key, model, prompt });
  }

  private async startSubagent(parentSession: string, task: string, kind: "analysis" | "decision"): Promise<{ session: string }> {
    const sessions = await this.harness.sessions.list();
    const parent = sessions.find(item => item.id === parentSession);
    if (!parent) throw new Error("La conversación principal ya no existe.");
    if (parent.parent) throw new Error("Los subagentes no pueden crear otros subagentes.");
    const children = sessions.filter(item => item.parent === parentSession);
    const activeChildren = children.filter(item => item.busy);
    if (activeChildren.length >= 3) throw new Error("Ya hay tres subagentes trabajando en esta conversación.");
    if (children.length >= 8) throw new Error("Esta conversación ya alcanzó ocho subagentes. Inicia otra conversación para continuar.");
    const child = await this.harness.sessions.fork(parentSession);
    const project = await this.sessionProject(parentSession);
    if (project) await this.inheritSessionScope(parentSession, child.id, project);
    else {
      const scope = await this.ctx.storage.get<ProjectScope>(scopeStorageKey(parentSession));
      if (scope) await this.bindSessionScope(child.id, scope);
    }
    await child.setAgent("plan");
    const priorHistory = await child.history();
    const priorMessage = priorHistory.at(-1)?.id;
    const decisionModel = kind === "decision"
      ? (await this.ctx.storage.get<{ decisionModel?: string }>(this.sessionModelsKey(parentSession)))?.decisionModel
      : undefined;
    if (decisionModel) {
      if (!isModelSelection(decisionModel)) throw new Error("El modelo de decisión guardado no es válido.");
      const selected = resolveModelSelection(decisionModel);
      if (selected.providerID === "openrouter") {
        if (!await this.isOpenRouterConfigured()) throw new Error("Conecta OpenRouter para usar el modelo de decisión configurado.");
        if (decisionModel.startsWith("openrouter:")) await assertOpenRouterModelSupportsTools(selected.id);
      }
      await child.setModel(selected);
    }
    const brief = `Subagente de ${kind === "decision" ? "decisión" : "análisis"} de solo lectura. Resuelve esta tarea acotada: ` + task +
      "\nNo edites archivos, escribas en GitHub, ejecutes comandos, despliegues ni cambies datos. " +
      "Usa solo las herramientas visibles en esta sesión y devuelve hallazgos concretos, fuentes consultadas y límites.";
    await child.submit(brief);
    await this.ctx.storage.put("subagent-parent-v1:" + child.id, {
      parent: parentSession, afterID: priorMessage
    });
    return { session: child.id };
  }

  private async subagentResult(parentSession: string, childSession: string): Promise<{ status: "running" | "finished"; text: string }> {
    const sessions = await this.harness.sessions.list();
    if (!sessions.some(item => item.id === parentSession)) throw new Error("La conversación principal no existe.");
    const child = sessions.find(item => item.id === childSession);
    if (!child || child.parent !== parentSession) throw new Error("El subagente no pertenece a esta conversación.");
    const record = await this.ctx.storage.get<{ parent: string; afterID?: string }>("subagent-parent-v1:" + childSession);
    if (record?.parent !== parentSession) throw new Error("No se encontró el registro de este subagente.");
    const history = await this.harness.session(childSession).history();
    const start = record.afterID ? history.findIndex(message => message.id === record.afterID) + 1 : 0;
    const text = history.slice(Math.max(start, 0)).flatMap(message => message.type === "assistant"
      ? message.content.filter(part => part.type === "text").map(part => part.text)
      : []).join("\n\n").slice(-8_000);
    return { status: child.busy ? "running" as const : "finished" as const, text };
  }

  /** This selection is fixed per OpenCode conversation, not an LLM instruction. */
  async bindSessionScope(sessionID: string, input: unknown): Promise<void> {
    const next = validateProjectScope(input, await this.personalConfig.getAllowedRepositories());
    const key = scopeStorageKey(sessionID);
    await this.ctx.storage.transaction(async tx => {
      const old = await tx.get<ProjectScope>(key);
      const current = requireSameScope(old, next);
      if (!old) await tx.put(key, current);
    });
  }

  async inheritSessionScope(source: string, target: string, project: string): Promise<void> {
    const old = await this.ctx.storage.get<ProjectScope>(scopeStorageKey(source));
    if (old) {
      if (old.project !== project) throw new Error("La sesión delegada no puede cambiar de proyecto");
      await this.bindSessionScope(target, old);
    } else {
      await this.bindSessionScope(target, { project });
    }
  }

  async enforceSessionScope(sessionID: string, action: ScopedToolAction): Promise<void> {
    const scope = await this.ctx.storage.get<ProjectScope>(scopeStorageKey(sessionID));
    assertScopedTool(scope, action);
    if(action.kind === "github"){
      const supervisedId = await this.ctx.storage.get<string>("supervisor:session:" + sessionID);
      if (supervisedId) {
        const task = await this.ctx.storage.get<SupervisorTask>(supervisorTaskKey(supervisedId));
        if (!task || task.session !== sessionID || task.status === "cancelled" || task.status === "failed")
          throw new Error("Supervisor: sesión no autorizada");
        assertSupervisorBoundGitHubOperation(action.operation, action.branch, task.branch);
      }
      // Retain the branch guard for both legacy and new isolated G9 sessions.
      for (const key of ["g9-selfdev-v1", "g9-native-e2e-v2"]) {
        const g9 = await this.ctx.storage.get<G9ProofState>(key);
        if (g9?.session === sessionID) assertG9BoundGitHubOperation(action.operation, action.branch);
      }
    }
  }

  /** Trusted lookup for read-only GitHub tools. No LLM-provided repository. */
  /** Source of truth for Linux tool project IDs; the model cannot change it. */
  async sessionProject(sessionID: string): Promise<string> {
    const scope = await this.ctx.storage.get<ProjectScope>(scopeStorageKey(sessionID));
    return scope?.project ?? "";
  }

  async sessionRepository(sessionID: string): Promise<string> {
    const scope = await this.ctx.storage.get<ProjectScope>(scopeStorageKey(sessionID));
    if (!scope?.repository) {
      throw new Error("Esta sesión no tiene repositorio GitHub asignado. Selecciona uno desde Proyectos en una conversación nueva.");
    }
    return scope.repository;
  }

  /**
   * One owner-triggered two-repository acceptance test. Both use the ACTUAL
   * OpenCode Harness/model/plugin, read-only plan agent and two isolated
   * Durable Object sessions; never accept an LLM's textual success claim.
   * Repeated clicks reuse the saved attempt rather than spending more tokens.
   */
  async startG8LiveReview(): Promise<{ status: string; message?: string }> {
    const existing = await this.ctx.storage.get<G8LiveCheck>("g8-live-agent-v1");
    if (existing?.version === G8_LIVE_CHECK_VERSION) {
      return { status: "existing", message: "La prueba G8 ya fue iniciada. Consulta su resultado." };
    }
    const allowed = await this.personalConfig.getAllowedRepositories();
    if (!G8_PROOFS.every(p => allowed.some(name => name.toLowerCase() === p.repo.toLowerCase()))) {
      return { status: "rejected", message: "Autoriza ambos repositorios CDF CLOUD y WorkBench en Configuración." };
    }
    const githubKey = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN
      || await this.personalConfig.getGitHubKey();
    if (!githubKey) return { status: "rejected", message: "Conecta GitHub desde Configuración." };
    const state: G8LiveCheck = {
      version: G8_LIVE_CHECK_VERSION, status: "starting", startedAt: Date.now(), tasks: []
    };
    await this.ctx.storage.put("g8-live-agent-v1", state);
    try {
      for (const proof of G8_PROOFS) {
        const created = await this.harness.sessions.create();
        await this.bindSessionScope(created.id, { project: proof.project, repository: proof.repo });
        const task = {
          repo: proof.repo, project: proof.project, branch: proof.branch,
          session: created.id, startedAt: Date.now()
        };
        state.tasks.push(task);
        await this.ctx.storage.put("g8-live-agent-v1", state);
        const handle = this.harness.session(created.id);
        await handle.setAgent("plan");
        await handle.setModel(this.ai(MODEL_ID));
        await handle.submit(g8LivePrompt(proof), { whenBusy: "followUp" });
      }
      state.status = "running";
      await this.ctx.storage.put("g8-live-agent-v1", state);
      return { status: "started" };
    } catch (error) {
      state.status = "failed";
      state.reason = error instanceof Error ? error.message.slice(0, 180) : "No se pudo iniciar la prueba";
      await this.ctx.storage.put("g8-live-agent-v1", state);
      return { status: "failed", message: state.reason };
    }
  }

  async getG8LiveReview(): Promise<unknown> {
    const state = await this.ctx.storage.get<G8LiveCheck>("g8-live-agent-v1");
    if (!state || state.version !== G8_LIVE_CHECK_VERSION) return { status: "not-started" };
    if (state.status === "failed" || state.status === "passed") {
      return { status: state.status, reason: state.reason, results: state.results ?? [] };
    }
    const results = [];
    let waiting = state.status === "starting" || state.tasks.length !== G8_PROOFS.length;
    for (const task of state.tasks) {
      const proof = G8_PROOFS.find(p => p.repo === task.repo && p.branch === task.branch);
      if (!proof) return { status: "failed", reason: "Ámbito de la prueba inválido", results: [] };
      try {
        const handle = this.harness.session(task.session);
        const [running, history] = await Promise.all([handle.busy(), handle.history()]);
        const evidence = assessG8LiveHistory(history, proof);
        const noAnswerYet = !history.some(message => message.type === "assistant");
        const pending = running || (noAnswerYet && Date.now() - task.startedAt < 90_000);
        if (pending && Date.now() - task.startedAt > 6 * 60_000) {
          try { await handle.abort(); } catch { /* read-only check cannot run indefinitely */ }
          results.push({ repo: proof.repo, status: "failed", reason: "El modelo superó seis minutos",
            toolCalls: evidence.matchedTools });
          continue;
        }
        if (pending) waiting = true;
        results.push({
          repo: proof.repo, branch: proof.branch, status: pending ? "running" :
            evidence.passed ? "passed" : "failed",
          reason: pending ? "Ejecutando revisión de solo lectura" : evidence.reason,
          toolCalls: evidence.matchedTools,
          completedTools: evidence.completedTools,
          failedTools: evidence.failedTools
        });
      } catch {
        results.push({ repo: proof.repo, status: "failed",
          reason: "No se pudo recuperar el historial del agente; consulta los registros.",
          toolCalls: 0 });
      }
    }
    if (waiting) return { status: "running", results };
    const passed = results.length === G8_PROOFS.length && results.every(result => result.status === "passed");
    state.status = passed ? "passed" : "failed";
    state.results = results;
    state.reason = passed ? undefined : "Alguna sesión no completó repo_review correctamente";
    await this.ctx.storage.put("g8-live-agent-v1", state);
    return { status: state.status, results, ...(passed ? {} : { reason: state.reason }) };
  }

  /** One owner-authorized live G9 code repair, fully isolated in a draft branch.
   * Fixture and initial failure are seeded server-side; only the agent gets
   * credit for a subsequent GitHub source edit and draft PR.
   */
  async startG9SelfDev(): Promise<{status:string;reason?:string;session?:string}> {
    const allowed = await this.personalConfig.getAllowedRepositories();
    if (!allowed.some(name => name.toLowerCase() === G9_REPO.toLowerCase())) {
      return {status:"rejected",reason:"Autoriza el repositorio OpenCode Cloud en Configuración de GitHub."};
    }
    const token = (this.env as Env & {GITHUB_TOKEN?: string}).GITHUB_TOKEN
      || await this.personalConfig.getGitHubKey();
    if (!token) return {status:"rejected",reason:"Conecta GitHub dentro de OpenCode Cloud."};
    let already: G9ProofState | undefined;
    await this.ctx.storage.transaction(async tx => {
      already = await tx.get<G9ProofState>("g9-native-e2e-v2");
      if(!already) {
        await tx.put("g9-native-e2e-v2", {
          version:G9_PROOF_VERSION,status:"starting",startedAt:Date.now()
        } satisfies G9ProofState);
      }
    });
    if(already) return {status:"existing",session:already.session,
      reason:"La prueba G9 ya se inició. Consulta su estado; no se ejecutará otra inferencia."};
    const state: G9ProofState = {
      version:G9_PROOF_VERSION,status:"starting",startedAt:Date.now(),seedCommits:[]
    };
    try {
      await this.githubRunner.execute({action:"branch",repo:G9_REPO,branch:G9_BRANCH});
      const seedCode = await this.githubRunner.execute({
        action:"write",repo:G9_REPO,branch:G9_BRANCH,path:G9_SOURCE,
        content:G9_BROKEN,message:"test(g9): seed deliberately failing isolated source"
      }) as {commitSha?:string};
      const seedTest = await this.githubRunner.execute({
        action:"write",repo:G9_REPO,branch:G9_BRANCH,path:G9_TEST_PATH,
        content:G9_TEST_SOURCE,message:"test(g9): seed immutable Node regression"
      }) as {commitSha?:string};
      state.seedCommits=[seedCode.commitSha??"",seedTest.commitSha??""];
      const seedScript="const fs=require('node:fs');"+
        "fs.writeFileSync('add.mjs',"+JSON.stringify(G9_BROKEN)+");"+
        "fs.writeFileSync('add.test.mjs',"+JSON.stringify(G9_TEST_SOURCE)+");";
      // Bind the authorized repository BEFORE the first Linux command. Its
      // source archive must be prepared while the isolated project is fresh;
      // otherwise prepareRepository refuses to import after a seeded write.
      const created=await this.harness.sessions.create();
      await this.bindSessionScope(created.id,{project:G9_PROJECT,repository:G9_REPO});
      state.session=created.id;
      await this.ctx.storage.put("g9-native-e2e-v2",state);
      const seed=await this.linuxRunner.run(G9_PROJECT,
        "node -e "+JSON.stringify(seedScript)+" && node --test --test-reporter=tap add.test.mjs", created.id);
      if(seed.exitCode!==1 || !seed.stdout.includes("not ok")) {
        throw new Error("El fixture inicial no falló como se esperaba; no se inicia inferencia.");
      }
      const handle=this.harness.session(created.id);
      await handle.setAgent("build");
      // The G9 acceptance is explicitly for native Cloudflare DeepSeek.
      // Never route through OpenRouter or silently downgrade to another model.
      await handle.setModel({providerID:"cloudflare",id:MODEL_PRESETS.economy.id});
      await handle.submit(g9AgentPrompt(),{whenBusy:"followUp"});
      state.status="running";
      await this.ctx.storage.put("g9-native-e2e-v2",state);
      return {status:"started",session:created.id};
    }catch(error){
      state.status="failed";
      state.reason=error instanceof Error ? error.message.slice(0,240) : "No se pudo iniciar G9";
      await this.ctx.storage.put("g9-native-e2e-v2",state);
      return {status:"failed",reason:state.reason,session:state.session};
    }
  }

  async getG9SelfDev(): Promise<unknown> {
    const state=await this.ctx.storage.get<G9ProofState>("g9-native-e2e-v2");
    if(!state || state.version!==G9_PROOF_VERSION)return {status:"not-started"};
    // Recover a false-negative caused by the previous TAP-only parser. Re-read
    // the ACTUAL persisted tool transcript; no model retry or synthetic PASS.
    // Independent GitHub + Node verification below remains mandatory.
    if(state.status === "failed" && state.session &&
       state.reason?.startsWith("El agente no completó la secuencia roja")) {
      try {
        const handle=this.harness.session(state.session);
        const [running,history]=await Promise.all([handle.busy(),handle.history()]);
        const evidence=assessG9History(history);
        if(!running && evidence.passed){
          state.status="running";
          state.reason=undefined;
          state.result=evidence;
          await this.ctx.storage.put("g9-native-e2e-v2",state);
        }
      }catch(error){
        console.warn("G9 revalidation unavailable",error);
      }
    }
    if(state.status==="failed" || state.status==="passed") return {
      status:state.status,reason:state.reason,result:state.result,session:state.session,
      branch:G9_BRANCH
    };
    if(!state.session || state.status==="verifying")
      return {status:"running",stage:state.status,branch:G9_BRANCH};
    try{
      const handle=this.harness.session(state.session);
      const [busy,history]=await Promise.all([handle.busy(),handle.history()]);
      const evidence=assessG9History(history);
      if(busy && Date.now()-state.startedAt < 8*60_000)
        return {status:"running",stage:"agent",session:state.session,
          toolCalls:evidence.toolCalls,branch:G9_BRANCH};
      if(busy){
        try{await handle.abort()}catch { /* ensure no unbounded background cost */ }
        throw new Error("La sesión superó el límite de seguridad de ejecución.");
      }
      state.result=evidence;
      if(!evidence.passed) throw new Error(
        "El agente no completó la secuencia roja → escritura GitHub → verde → diff → PR borrador. "+
        "Herramientas observadas: "+evidence.toolCalls+"; fallidas: "+evidence.failedTools);
      state.status="verifying";
      await this.ctx.storage.put("g9-native-e2e-v2",state);
      const [source,original,comparison]=await Promise.all([
        this.githubRunner.execute({action:"read",repo:G9_REPO,ref:G9_BRANCH,path:G9_SOURCE}),
        this.githubRunner.execute({action:"read",repo:G9_REPO,ref:G9_BRANCH,path:G9_TEST_PATH}),
        this.githubRunner.execute({action:"review",repo:G9_REPO,branch:G9_BRANCH})
      ]) as [
        {content?:string},{content?:string},
        {repo?:string;branch?:string;base?:string;truncated?:boolean;files?:{path:string}[]}
      ];
      if(typeof source.content!=="string" || source.content.trim()!==G9_FIXED.trim() || original.content!==G9_TEST_SOURCE ||
         comparison.repo?.toLowerCase()!==G9_REPO.toLowerCase() ||
         comparison.branch!==G9_BRANCH || comparison.base!=="main" ||
         comparison.truncated ||
         comparison.files?.length!==2 ||
         ![G9_SOURCE,G9_TEST_PATH].every(path=>comparison.files!.some(file=>file.path===path))){
        throw new Error("La revisión independiente no coincide con el arreglo exacto y el test original.");
      }
      const script="const fs=require('node:fs');"+
        "fs.writeFileSync('add.mjs',"+JSON.stringify(source.content)+");"+
        "fs.writeFileSync('add.test.mjs',"+JSON.stringify(original.content)+");";
      const check=await this.linuxRunner.run(G9_PROJECT,
        "node -e "+JSON.stringify(script)+" && node --test --test-reporter=tap add.test.mjs");
      if(check.exitCode!==0 || !check.stdout.includes("ok 1 - G9: add(2,3) is five")){
        throw new Error("La prueba Node independiente no aprobó el código de GitHub.");
      }
      state.status="passed";
      state.reason=undefined;
      await this.ctx.storage.put("g9-native-e2e-v2",state);
      return {status:"passed",result:state.result,session:state.session,
        branch:G9_BRANCH,independentLinuxExitCode:check.exitCode};
    }catch(error){
      state.status="failed";
      state.reason=error instanceof Error ? error.message.slice(0,350):"No se pudo verificar G9";
      await this.ctx.storage.put("g9-native-e2e-v2",state);
      return {status:"failed",reason:state.reason,result:state.result,
        session:state.session,branch:G9_BRANCH};
    }
  }

  /** One authoritative PR publisher: all Staging supervisor tasks use THIS
   * named DO, regardless of which OpenCodeAgent instance owns the caller.
   * Never expose this method as an unauthenticated HTTP endpoint.
   */
  async publishSupervisedGithubDraft(
    input: Extract<GitHubAction, { action: "pr" }>, sessionID: string
  ): Promise<unknown> {
    this.assertStagingRemote();
    if (this.ctx.id.name !== SUPERVISOR_WORKSPACE)
      throw Error("PR_PUBLICATION_WRONG_AUTHORITY");
    const match = /^opencode\/staging-([a-f0-9]{16})$/.exec(input.branch);
    const task = match
      ? await this.ctx.storage.get<SupervisorTask>(supervisorTaskKey(match[1])) : undefined;
    assertSupervisedPublicationScope(input, sessionID, task);
    const key = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN
      || await this.personalConfig.getGitHubKey();
    if (!key) throw Error("Conecta GitHub desde Configuración para trabajar con repositorios privados.");
    return new GitHubBridge(key, (url, init) => globalThis.fetch(url, init),
      await this.personalConfig.getAllowedRepositories(),
      new DurableGitHubPublicationGate(this.ctx.storage, Date.now, async (tx, scope) => {
        const match = /^opencode\/staging-([a-f0-9]{16})$/.exec(scope.branch);
        const current = match
          ? await tx.get<SupervisorTask>(supervisorTaskKey(match[1])) : undefined;
        assertSupervisedPublicationScope(input, sessionID, current);
      })).execute(input);
  }

  private readonly githubRunner = {
    execute: async (input: Parameters<GitHubBridge["execute"]>[0], sessionID?: string) => {
      // The shared supervisor DO is the only allowed publisher of its Staging
      // branches. A project DO cannot create an independent storage lock.
      if (input.action === "pr" &&
          input.repo.toLowerCase() === "aamvtrampa36-del/opencode-harness-example" &&
          /^opencode\/staging-[a-f0-9]{16}$/.test(input.branch)) {
        if (!sessionID) throw Error("PR_PUBLICATION_SESSION_REQUIRED");
        if (this.ctx.id.name === SUPERVISOR_WORKSPACE)
          return this.publishSupervisedGithubDraft(input, sessionID);
        return this.env.OpenCodeAgent.getByName(SUPERVISOR_WORKSPACE)
          .publishSupervisedGithubDraft(input, sessionID);
      }
      const key = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN
        || await this.personalConfig.getGitHubKey();
      if (!key) throw new Error("Conecta GitHub desde Configuración para trabajar con repositorios privados.");
      // Wrap the global fetch so it is called with the correct receiver in Workers.
      return new GitHubBridge(key, (url, init) => globalThis.fetch(url, init),
        await this.personalConfig.getAllowedRepositories()).execute(input);
    },
    ensureSupervisorBranch: async (repo: string, branch: string) => {
      const key = (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN
        || await this.personalConfig.getGitHubKey();
      if (!key) throw new Error("Conecta GitHub desde Configuración para trabajar con repositorios privados.");
      return new GitHubBridge(key, (url, init) => globalThis.fetch(url, init),
        await this.personalConfig.getAllowedRepositories()).ensureSupervisorBranch(repo, branch);
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
  async startAgentCheck(model: unknown = "cloudflare", kind: unknown = "repair", scope?: "openrouter"): Promise<{ status: string; session?: string; project?: string; model?: string; kind?: string; providerID?: string; providerModel?: string; message?: string }> {
    if (!isAgentCheckModel(model)) {
      return { status: "rejected", message: "Solo se permiten modelos económicos en la autoprueba." };
    }
    if (!isAgentCheckKind(kind)) {
      return { status: "rejected", message: "Tipo de autoprueba desconocido." };
    }
    if (scope === "openrouter" && (model !== "review" || kind !== "bun")) {
      return { status: "rejected", message: "El chequeo OpenRouter requiere el preset review y la prueba Bun." };
    }
    const preset = MODEL_PRESETS[model];
    if (preset.providerID === "openrouter" && !(await this.isOpenRouterConfigured())) {
      return { status: "rejected", message: "Conecta OpenRouter antes de probar este modelo. No se consumió la cuota." };
    }
    const storageKeys = agentCheckStorageKeys(scope);
    const identity = { model, kind, providerID: preset.providerID, providerModel: preset.id };
    const previous = await this.ctx.storage.get<{
      session: string; project: string; token: string; startedAt: number; model?: string; kind?: string;
      providerID?: string; providerModel?: string; error?: string
    }>(storageKeys.state);
    const outcome = await this.ctx.storage.get(storageKeys.result);
    if (hasUnfinishedAgentCheck(previous, outcome)) {
      return { status: "existing", session: previous!.session, project: previous!.project,
        model: previous!.model ?? "cloudflare", kind: previous!.kind ?? "linux",
        providerID: previous!.providerID ?? preset.providerID,
        providerModel: previous!.providerModel ?? preset.id };
    }
    // Staging-only development switch: retries are allowed without a daily counter.
    // Production keeps the existing quota unless its own environment opts in.
    const unrestrictedDev = isUnlimitedDevAgentCheck((this.env as Env & { G1_DEV_UNLIMITED_CHECKS?: string }).G1_DEV_UNLIMITED_CHECKS);
    if (!unrestrictedDev && !(await this.personalConfig.reserveAgentCheck())) {
      return { status: "daily-limit", message: "Límite de dos verificaciones diarias para evitar gastos de IA" };
    }
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const project = "agent-check-" + token;
    const created = await this.harness.sessions.create();
    const state = { session: created.id, project, token, ...identity, startedAt: Date.now() };
    await this.bindSessionScope(created.id, { project });
    // Atomically replace the previous terminal proof only after creating a new session.
    // This keeps completed checks retryable without exposing stale pass results.
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put(storageKeys.state, state);
      await tx.delete(storageKeys.result);
    });
    try {
      if (kind === "repair") {
        const seed = await this.linuxRunner.run(project, repairSeedCommand());
        if (seed.exitCode !== 1 || !seed.stdout.includes("not ok")) {
          throw new Error("Prueba inicial no verificable: exitCode=" + seed.exitCode + "; salida TAP=" + seed.stdout.includes("not ok") + "; stderr presente=" + Boolean(seed.stderr));
        }
      }
      const handle = this.harness.session(created.id);
      await handle.setAgent("build");
      await handle.setModel(model === "cloudflare" ? this.ai(MODEL_ID) : {
        providerID: preset.providerID, id: preset.id
      });
      const command = (kind === "bun" ? "bun --version && " : "") +
        "printf '" + token + "' > proof.txt && node -e " +
        JSON.stringify("const fs=require('node:fs');if(fs.readFileSync('proof.txt','utf8')!==" +
          JSON.stringify(token) + ")process.exit(2);console.log('AGENT_PROOF_OK:" + token + "')");
      const prompt = "Esta es una autoprueba REAL de herramientas, no una tarea de conversación. " +
        "Usa la herramienta linux SOLO con command=" +
        JSON.stringify(command) + ". Debes CREAR el archivo proof.txt en el Container y VERIFICARLO con Node. " +
        "No generes código solamente en tu respuesta. Espera el resultado real de linux " +
        "y describe su exitCode. No alteres ningún otro proyecto.";
      const repairPrompt = "Prueba REAL de reparación autónoma de código. Proyecto Linux aislado: " +
        project + ". Emplea ÚNICAMENTE la herramienta cuyo nombre exacto es linux " +
        "(con el parámetro command; el proyecto se determina automáticamente por la sesión, NO envíes project). NO uses inspect_linux, exec, herramientas de archivos ni otros nombres. " +
        "Ya existen calc.mjs con un defecto y calc.test.mjs con el test original. " +
        "Paso 1: llama a linux para ejecutar node --test --test-reporter=tap calc.test.mjs; observa el fallo. " +
        "Paso 2: llama a linux con cat calc.mjs && cat calc.test.mjs para inspeccionar ambos archivos. " +
        "Paso 3: decide la reparación y escribe SOLO calc.mjs mediante otro comando linux que construyas tú; " +
        "no modifiques calc.test.mjs ni ningún otro proyecto. " +
        "Paso 4: vuelve a llamar a linux para ejecutar node --test --test-reporter=tap calc.test.mjs " +
        "y, únicamente cuando el test pase, imprime AGENT_PROOF_OK:" + token +
        " en la salida de esa misma llamada Linux. Espera los exitCode reales. " +
        "No basta con describir la reparación; todas las acciones deben realizarse mediante linux.";
      const bunPrompt = "Autoprueba REAL de OpenRouter, Bun y la herramienta Linux. " +
        "Usa la herramienta linux SOLO con command=" + JSON.stringify(command) +
        ". Debes ejecutar Bun " + BUN_RUNTIME_VERSION + ", crear proof.txt en el Container y verificarlo con Node. " +
        "Espera el exitCode real de la herramienta y describe la versión de Bun que imprimió. " +
        "No alteres ningún otro proyecto ni uses otras herramientas.";
      await handle.submit(kind === "repair" ? repairPrompt : kind === "bun" ? bunPrompt : prompt, { whenBusy: "followUp" });
      return { status: "started", session: created.id, project, ...identity };
    } catch (error) {
      const failed = {
        ...state, error: error instanceof Error ? error.message.slice(0, 250) : "No se pudo iniciar"
      };
      await this.ctx.storage.put(storageKeys.state, failed);
      return { status: "failed", message: failed.error, ...identity };
    }
  }





  async agentCheckStatus(): Promise<unknown> {
    return this.agentCheckStatusFor(DEFAULT_AGENT_CHECK_STORAGE_KEYS);
  }

  async openRouterAgentCheckStatus(): Promise<unknown> {
    return this.agentCheckStatusFor(OPENROUTER_BUN_CHECK_STORAGE_KEYS);
  }

  private async agentCheckStatusFor(storageKeys: AgentCheckStorageKeys): Promise<unknown> {
    const saved = await this.ctx.storage.get<{
      status: string; toolCalls: number; fileVerified: boolean; project: string; model?: string; kind?: string;
      providerID?: string; providerModel?: string; reason?: string
    }>(storageKeys.result);
    if (saved) return saved;
    const state = await this.ctx.storage.get<{
      session: string; project: string; token: string; startedAt: number; model?: string; kind?: string;
      providerID?: string; providerModel?: string; error?: string
    }>(storageKeys.state);
    if (!state) return { status: "not-started" };
    if (state.error) return { status: "failed", reason: state.error, project: state.project,
      model: state.model, kind: state.kind, providerID: state.providerID, providerModel: state.providerModel };
    const handle = this.harness.session(state.session);
    let running: boolean;
    let history: Awaited<ReturnType<typeof handle.history>>;
    try {
      [running, history] = await Promise.all([handle.busy(), handle.history()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /ModelUnavailableError|Model unavailable/i.test(message)
        ? "El modelo elegido no está disponible en el registro activo de OpenCode. Prueba otro modelo."
        : "No se pudo recuperar la ejecución del agente; consulta los registros del servicio.";
      const failed = { status: "failed", reason, toolCalls: 0, fileVerified: false,
        project: state.project, model: state.model, kind: state.kind,
        providerID: state.providerID, providerModel: state.providerModel };
      await this.ctx.storage.put(storageKeys.result, failed);
      return failed;
    }
    const evidence = assessAgentToolEvidence(history, state.project, state.token);
    const runtimeVerified = state.kind !== "bun" || evidence.bunVersion === BUN_RUNTIME_VERSION;
    if (running) {
      if (Date.now() - state.startedAt < 6 * 60_000) {
        return { status: "running", toolCalls: evidence.requestedTools, project: state.project, model: state.model, kind: state.kind,
          providerID: state.providerID, providerModel: state.providerModel,
          ...(state.kind === "bun" ? { bunVersion: evidence.bunVersion, runtimeVerified } : {}) };
      }
      try { await handle.abort(); } catch { /* Preserve timeout as a failure. */ }
      const timeout = { status: "failed", reason: "La autoprueba superó seis minutos y se detuvo para evitar consumo indefinido.",
        toolCalls: evidence.requestedTools, fileVerified: false, project: state.project, model: state.model, kind: state.kind,
        providerID: state.providerID, providerModel: state.providerModel };
      await this.ctx.storage.put(storageKeys.result, timeout);
      return timeout;
    }
    if (!history.some(message => message.type === "assistant") &&
        Date.now() - state.startedAt < 5 * 60_000) {
      return { status: "queued", toolCalls: 0, project: state.project, model: state.model, kind: state.kind,
        providerID: state.providerID, providerModel: state.providerModel };
    }
    const toolSequenceVerified = state.kind === "repair"
      ? evidence.verifiedRepairSequence : evidence.correctLinuxResult;
    let fileVerified = false;
    if (toolSequenceVerified) {
      try {
        const dev = await this.isolatedProject(state.project);
        if (state.kind === "repair") {
          const [source, test] = await Promise.all([
            dev.inspect(state.project, "read", "calc.mjs") as Promise<{ contents?: string }>,
            dev.inspect(state.project, "read", "calc.test.mjs") as Promise<{ contents?: string }>
          ]);
          if (source.contents && test.contents === REPAIR_TEST && source.contents !== REPAIR_SOURCE_BROKEN) {
            const run = await dev.run(state.project, "node --test --test-reporter=tap calc.test.mjs");
            fileVerified = repairIsVerified(source.contents, test.contents, run.exitCode);
          }
        } else {
          const actual = await dev.inspect(state.project, "read", "proof.txt") as { contents?: string };
          fileVerified = actual.contents === state.token;
        }
      } catch { /* Failed inspection or test cannot count as a verified repair. */ }
    }
    const outcome = {
      status: toolSequenceVerified && fileVerified && runtimeVerified ? "passed" : "failed",
      toolCalls: evidence.requestedTools,
      observedFailingTest: state.kind === "repair" ? evidence.observedFailingTest : undefined,
      fileVerified, project: state.project, model: state.model, kind: state.kind,
      providerID: state.providerID, providerModel: state.providerModel,
      ...(state.kind === "bun" ? { bunVersion: evidence.bunVersion, runtimeVerified } : {}),
      ...(toolSequenceVerified && fileVerified && runtimeVerified ? {} : {
        reason: !runtimeVerified
          ? `Linux informó Bun ${evidence.bunVersion ?? "sin versión verificable"}; se requiere ${BUN_RUNTIME_VERSION}.`
          : explainAgentCheckFailure(evidence, state.kind === "repair" ? "repair" : "linux")
      })
    };
    await this.ctx.storage.put(storageKeys.result, outcome);
    if (outcome.status === "failed") {
      const code = evidence.requestedTools === 0 ? "MODEL_UNAVAILABLE"
        : evidence.finishedLinuxTools === 0 ? "TOOL_MISSING"
          : state.kind === "repair" ? "TEST_FAILED" : "AGENT_FAILURE";
      await this.noteIncident({ source: "agent-check", code, project: state.project });
    }
    return outcome;
  }

  // Workers AI over the AI binding, as an OpenCode provider plugin.
  readonly ai = createAI({ binding: this.env.AI });
  // Register every native preset BEFORE the harness initializes. A plain
  // {providerID, id} selector does not add a model to OpenCode's provider.
  private readonly registeredWorkersModels = NATIVE_WORKERS_AI_MODELS.map(id => this.ai(id));
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
      }),
      new CodemodeBackend({
        id: "dynamic-mcp",
        loader: this.env.LOADER,
        root: "/dynamic",
        access: "read",
        defaultTimeoutMs: 45_000,
        maxTimeoutMs: 45_000,
        maxCpuMs: 30_000,
        maxSourceBytes: 128_000,
        maxInputBytes: 256_000,
        maxResultBytes: 1_000_000,
        maxCapabilityCalls: 48,
        maxConcurrentCapabilityCalls: 4,
        maxHostCallMs: 35_000,
        egress: { mode: "none" },
        modules: {
          "codemode:mcp": createDynamicMcpModule(() => this.personalConfig.getRemoteMcps())
        }
      })
    ]
  });
  private async noteIncident(event: IncidentObservation): Promise<void> {
    try {
      await this.personalConfig.recordIncident(event);
    } catch {
      // Diagnostics must not turn an otherwise valid tool result into an error.
      console.warn("Incident ledger write unavailable");
    }
  }

  /** Route each project to its own Container, never the shared legacy VM. */
  private async isolatedProject(project: string, sessionID?: string) {
    const scope = sessionID ? await this.ctx.storage.get<ProjectScope>(scopeStorageKey(sessionID)) : undefined;
    if (sessionID) assertScopedTool(scope, { kind: "linux", project });
    const registry = this.env.DEV.getByName("personal");
    await registry.reserveIsolatedProject(project, scope?.repository);
    const dev = this.env.DEV.getByName(projectContainerName(project));
    let sourceCommit: string | undefined;
    if (sessionID) {
      const taskId = await this.ctx.storage.get<string>("supervisor:session:" + sessionID);
      if (taskId) {
        const task = await this.ctx.storage.get<SupervisorTask>(supervisorTaskKey(taskId));
        if (!task || task.project !== project ||
            task.repository.toLowerCase() !== scope?.repository?.toLowerCase() ||
            !task.baseCommit || !/^[a-f0-9]{40}$/.test(task.baseCommit)) {
          throw new Error("La fuente de la tarea supervisada no está fijada a su SHA base");
        }
        sourceCommit = task.baseCommit;
      }
    }
    if (scope?.repository) await dev.prepareRepository(project, scope.repository, sourceCommit);
    return dev;
  }

  readonly linuxRunner = {
    run: async (project: string, command: string, sessionID?: string) => {
      try {
        const result = await (await this.isolatedProject(project, sessionID)).run(project, command);
        const incident = observeLinux(result);
        if (incident) await this.noteIncident(incident);
        return result;
      } catch (error) {
        await this.noteIncident({ source: "linux", project, tool: "linux",
          code: classifyAgentFailure(error instanceof Error ? error.message : "") });
        throw error;
      }
    },
    inspect: async (project: string, action: "list" | "read", path: string, sessionID?: string) => {
      try {
        return await (await this.isolatedProject(project, sessionID)).inspect(project, action, path);
      } catch (error) {
        await this.noteIncident({ source: "linux", project, tool: "inspect_linux",
          code: classifyAgentFailure(error instanceof Error ? error.message : "") });
        throw error;
      }
    }
  };

  readonly harness: OpenCodeHarness = new OpenCodeHarness({
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
          tokenEconomizerAdapter(
            async () => (await this.personalConfig.connectorSettings()).tokenEconomizerEnabled,
            (connectorID, event) => this.runConnector(connectorID, event),
            sessionID => this.sessionProject(sessionID)
          ),
          openRouterCredentialPlugin(
            async () => (this.env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY
              || await this.personalConfig.getOpenRouterKey(),
            (connect) => { this.providerConnection.connect = connect; }
          ),
          remoteMcpPlugin(
            () => this.personalConfig.getRemoteMcps(),
            (reload) => { this.mcpLifecycle.reload = reload; }
          ),
          workspacePlugin(this.workspace, {}, this.linuxRunner, this.githubRunner,
            (sessionID, action) => this.enforceSessionScope(sessionID, action),
            (sessionID) => this.sessionRepository(sessionID),
            (sessionID) => this.sessionProject(sessionID),
            { getModel: sessionID => this.sessionImageModel(sessionID),
              generate: (sessionID, prompt) => this.generateSessionImage(sessionID, prompt) },
            { isChild: async sessionID => (await this.harness.sessions.list())
                .some(item => item.id === sessionID && Boolean(item.parent)),
              start: (sessionID, task, kind) => this.startSubagent(sessionID, task, kind),
              result: (parentSession, childSession) => this.subagentResult(parentSession, childSession) },
            { propose: value => this.personalConfig.proposeSpecialization(value) })
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
    (id: string) => this.personalConfig.getSpecialization(id),
    (incident: IncidentObservation) => this.noteIncident(incident),
    (sessionID: string, input: unknown) => this.bindSessionScope(sessionID, input),
    (source: string, target: string, project: string) => this.inheritSessionScope(source, target, project),
    (sessionID: string, options: { decisionModel?: string; imageModel?: string }) => this.setSessionModels(sessionID, options),
    () => this.personalConfig.defaultImageModel(),
    promise => this.ctx.waitUntil(promise),
    async sessionID => this.ctx.storage.get<import("./model-presets").ModelSelectionID>("session-model-v1:" + sessionID),
    async (sessionID, selection) => { await this.ctx.storage.put("session-model-v1:" + sessionID, selection); },
    async sessionID => (await this.ctx.storage.get<import("./protocol").ModelRun[]>("session-model-runs-v1:" + sessionID)) ?? [],
    async (sessionID, run) => {
      const key = "session-model-runs-v1:" + sessionID;
      const previous = (await this.ctx.storage.get<import("./protocol").ModelRun[]>(key)) ?? [];
      await this.ctx.storage.put(key, [...previous, run].slice(-50));
    }
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
      const projectRegistry = env.DEV.getByName("personal");
      const readableProject = async (name: string) => {
        const record = await projectRegistry.isolatedProject(name);
        if (!record) return projectRegistry;
        const dev = env.DEV.getByName(projectContainerName(name));
        if (record.repository) await dev.prepareRepository(name, record.repository);
        return dev;
      };
      const settingsOriginAllowed =
        request.headers.get("Origin") === url.origin &&
        request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json");
      // Cloudflare Access is the first gate. This second, secret-backed gate
      // is required for programmatic clients and never accepts browser cookies alone.
      if (url.pathname.startsWith(SUPERVISOR_API_PREFIX + "/")) {
        const enabled = (env as Env & { OPENCODE_SUPERVISOR_ENABLED?: string })
          .OPENCODE_SUPERVISOR_ENABLED === "true";
        if (!enabled) return new Response("Not found", { status: 404 });
        const secret = (env as Env & { OPENCODE_SUPERVISOR_TOKEN?: string })
          .OPENCODE_SUPERVISOR_TOKEN ?? "";
        if (secret.length < 32) return supervisorResponse({ error: "Supervisor no configurado" }, 503);
        if (!await supervisorBearerAllowed(request.headers.get("Authorization"), secret)) {
          return supervisorResponse({ error: "No autorizado" }, 401);
        }
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return supervisorResponse({ error: "Origen no permitido" }, 403);
        const host = env.OpenCodeAgent.getByName(SUPERVISOR_WORKSPACE);
        if (url.pathname === SUPERVISOR_API_PREFIX + "/status" && request.method === "GET") {
          return supervisorResponse({ status: "ready", environment: "staging", worker: "opencode-g1-staging",
            schema: "opencode.staging-control.v2", defaultModel: "economy",
            capabilities: ["start", "status", "continue", "progress", "cancel", "review", "transcript",
              "models", "repositories", "sessions", "inspect", "select_model", "mcp_discovery", "mcp_call",
              "incidents", "agent_check"],
            promotion: "external-only", access: "Cloudflare Access + bearer" });
        }
        if (url.pathname === SUPERVISOR_API_PREFIX + "/tasks" && request.method === "POST") {
          if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
            return supervisorResponse({ error: "JSON obligatorio" }, 415);
          const raw = await request.text();
          if (raw.length > 6_000) return supervisorResponse({ error: "Solicitud demasiado grande" }, 413);
          try {
            return supervisorResponse(await host.startSupervisedTask(JSON.parse(raw)));
          } catch (error) {
            return supervisorResponse({ error: error instanceof Error ? error.message : "Tarea inválida" }, 422);
          }
        }
        // Authorization above is mandatory for *every* task artifact route.
        // Clients must send the bearer in a header, never in the URL.
        const artifact = url.pathname.match(/^\/api\/supervisor\/v1\/tasks\/([a-f0-9]{16})\/artifacts(?:\/([a-f0-9]{32}))?$/);
        if (artifact) {
          if (url.search) return supervisorResponse({ error: "ARTIFACT_QUERY_NOT_ALLOWED" }, 400);
          try {
            if (!artifact[2] && request.method === "GET")
              return supervisorResponse(await host.supervisedTaskArtifacts(artifact[1]));
            if (!artifact[2] && request.method === "POST") {
              if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
                return supervisorResponse({ error: "JSON obligatorio" }, 415);
              const input = await request.text();
              if (input.length > 1_000) return supervisorResponse({ error: "Solicitud demasiado grande" }, 413);
              return supervisorResponse(await host.supervisedArtifactCapture(artifact[1], JSON.parse(input)));
            }
            if (artifact[2] && request.method === "GET")
              return await host.supervisedTaskArtifactDownload(artifact[1], artifact[2]);
            return supervisorResponse({ error: "Método no permitido" }, 405);
          } catch (error) {
            const reason = error instanceof Error ? error.message : "ARTIFACT_UNAVAILABLE";
            const status = /TASK_NOT_FINISHED|TASK_LIMIT|CONFLICT/.test(reason) ? 409
              : /UNSAFE|INVALID|MISMATCH|UNVERIFIED|UNKNOWN/.test(reason) ? 422 : 404;
            return supervisorResponse({ error: status === 404 ? "ARTIFACT_UNAVAILABLE" : reason.slice(0, 80) }, status);
          }
        }
        const task = url.pathname.match(/^\/api\/supervisor\/v1\/tasks\/([a-f0-9]{16})(?:\/(cancel|review|transcript))?$/);
        if (!task) return supervisorResponse({ error: "Ruta no encontrada" }, 404);
        try {
          if (!task[2] && request.method === "GET")
            return supervisorResponse(await host.supervisedTaskStatus(task[1]));
          if (task[2] === "cancel" && request.method === "POST")
            return supervisorResponse(await host.cancelSupervisedTask(task[1]));
          if (task[2] === "review" && request.method === "GET")
            return supervisorResponse(await host.supervisedTaskReview(task[1]));
          if (task[2] === "transcript" && request.method === "GET") {
            const transcript = JSON.parse(await host.supervisedTaskTranscript(task[1])) as {
              messages: unknown; project?: unknown; repository?: unknown
            };
            const record = await host.supervisedTaskStatus(task[1]) as { session?: string };
            return sessionExportResponse(record.session!, transcript);
          }
          return supervisorResponse({ error: "Método no permitido" }, 405);
        } catch (error) {
          return supervisorResponse({ error: error instanceof Error ? error.message : "Tarea no disponible" }, 422);
        }
      }
      if (url.pathname === "/api/session/export") {
        if (request.method !== "GET") return new Response("GET only", { status: 405 });
        const object = url.searchParams.get("object");
        const session = url.searchParams.get("session");
        try {
          validateExportIdentity(object, session);
          const historyJson = await env.OpenCodeAgent.getByName(object!).exportSessionData(session!);
          return sessionExportResponse(session!, JSON.parse(historyJson) as { messages: unknown; project?: unknown; repository?: unknown });
        } catch (error) {
          const message = error instanceof Error ? error.message : "No se pudo exportar la sesión";
          return Response.json({ error: message }, { status: 422,
            headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
        }
      }
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
      if (url.pathname === "/api/settings/connectors" && request.method === "GET") {
        const [settings, tokenEconomizerLastHook, tokenEconomizerLastContext] = await Promise.all([
          personal.connectorSettings(), personal.tokenEconomizerLastHook(), personal.tokenEconomizerLastContext()
        ]);
        return Response.json({ ...settings, tokenEconomizerLastHook, tokenEconomizerLastContext },
          { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/settings/connectors/token-economizer" && request.method === "POST") {
        if (!settingsOriginAllowed) return Response.json({ error: "Se requiere una solicitud del mismo origen." }, { status: 403 });
        const raw = await request.text();
        if (raw.length > 500) return Response.json({ error: "Solicitud demasiado grande." }, { status: 413 });
        try {
          const body = JSON.parse(raw) as { action?: string; workspace?: string };
          if (body.action === "disable") {
            await personal.setTokenEconomizerEnabled(false);
            return Response.json({ tokenEconomizerEnabled: false });
          }
          if (body.action !== "install") return Response.json({ error: "Acción no reconocida." }, { status: 400 });
          validateExportIdentity(body.workspace, "ses_root");
          const installed = await env.OpenCodeAgent.getByName(body.workspace!).installTokenEconomizer();
          await personal.setTokenEconomizerEnabled(true);
          return Response.json({ ...installed, tokenEconomizerEnabled: true }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "No se pudo instalar TokenEconomizer." },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/settings/openrouter/models" && request.method === "GET") {
        const active = (await personal.status()).openRouterConfigured ||
          Boolean((env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY);
        if (!active) return Response.json({ error: "Conecta OpenRouter para seleccionar modelos." },
          { status: 409, headers: { "Cache-Control": "no-store" } });
        try {
          return Response.json({ models: await getOpenRouterCatalogue() },
            { headers: { "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Catálogo no disponible." },
            { status: 503, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/settings/openrouter/image-models" && request.method === "GET") {
        const key = (env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY
          || await personal.getOpenRouterKey();
        if (!key) return Response.json({ error: "Conecta OpenRouter para seleccionar modelos de imagen." },
          { status: 409, headers: { "Cache-Control": "no-store" } });
        try {
          return Response.json({ models: await getOpenRouterImageModels(key) },
            { headers: { "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Catálogo no disponible." },
            { status: 503, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/settings/image-model") {
        if (request.method === "GET") {
          return Response.json({ imageModel: await personal.defaultImageModel() },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST") {
          if (!settingsOriginAllowed) return Response.json({ error: "Solicitud de origen no permitido." }, { status: 403 });
          const raw = await request.text();
          if (raw.length > 500) return Response.json({ error: "Solicitud demasiado grande." }, { status: 413 });
          try {
            const body = JSON.parse(raw) as { imageModel?: unknown };
            const key = (env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY
              || await personal.getOpenRouterKey();
            if (!key) return Response.json({ error: "Conecta OpenRouter para guardar un modelo de imagen." }, { status: 409 });
            if (typeof body.imageModel !== "string") throw new Error("Selecciona un modelo de imagen.");
            await assertOpenRouterImageModel(body.imageModel, key);
            await personal.setDefaultImageModel(body.imageModel);
            return Response.json({ imageModel: body.imageModel }, { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "No se pudo guardar el modelo." },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        if (request.method === "DELETE") {
          if (!settingsOriginAllowed) return Response.json({ error: "Solicitud de origen no permitido." }, { status: 403 });
          await personal.setDefaultImageModel(undefined);
          return Response.json({ imageModel: null }, { headers: { "Cache-Control": "no-store" } });
        }
        return new Response("Method not allowed", { status: 405 });
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
      if (url.pathname === "/api/settings/mcp/oauth/start" && request.method === "POST") {
        if (!settingsOriginAllowed) return Response.json({ error: "Origin and JSON required" }, { status: 403 });
        const raw = await request.text();
        if (raw.length > 1_000) return Response.json({ error: "Request too large" }, { status: 413 });
        try {
          const body = JSON.parse(raw) as { id?: string; scope?: string; workspace?: string };
          const result = await personal.startRemoteMcpOAuth({
            id: body.id ?? "", scope: body.scope, workspace: body.workspace,
            callbackUrl: new URL("/api/settings/mcp/oauth/callback", url.origin).toString()
          });
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "OAuth could not start" },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/settings/mcp/oauth/callback" && request.method === "GET") {
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const issuer = url.searchParams.get("iss") ?? undefined;
        try {
          const result = await personal.completeRemoteMcpOAuth(state, code, issuer);
          if (result.workspace) {
            try { await env.OpenCodeAgent.getByName(result.workspace).refreshMcps(); }
            catch { /* The saved token is applied when this workspace reconnects. */ }
          }
          return Response.redirect(new URL("/?mcp=connected", url.origin), 303);
        } catch {
          // Do not echo attacker-controlled OAuth callback errors or codes.
          return new Response("MCP authorization did not complete. Return to OpenCode and try Connect again.",
            { status: 400, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
        }
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
          if (raw.length > 20_000) return Response.json({ error: "Request too large" }, { status: 413 });
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
      if (url.pathname === "/api/settings/template-proposals") {
        if (request.method === "GET") {
          return Response.json({ proposals: await personal.listTemplateProposals() },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST") {
          if (!settingsOriginAllowed) return Response.json({ error: "Origin and JSON required" }, { status: 403 });
          const raw = await request.text();
          if (raw.length > 300) return Response.json({ error: "Request too large" }, { status: 413 });
          try {
            const body = JSON.parse(raw) as { action?: string; id?: string };
            if (body.action === "approve") {
              const template = await personal.approveTemplateProposal(body.id ?? "");
              return Response.json({ template }, { headers: { "Cache-Control": "no-store" } });
            }
            if (body.action === "reject") {
              await personal.rejectTemplateProposal(body.id ?? "");
              return Response.json({ removed: true }, { headers: { "Cache-Control": "no-store" } });
            }
            throw new Error("Unknown template suggestion action");
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Invalid template suggestion" },
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
      if (url.pathname === "/api/dev/g9-selfdev") {
        // This diagnostic initiates real development work and is strictly
        // staging-only, under the existing Cloudflare Access boundary.
        if(url.hostname!=="opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev"){
          return new Response("Not found",{status:404});
        }
        const object=url.searchParams.get("object");
        try{
          validateExportIdentity(object,"ses_root");
          const host=env.OpenCodeAgent.getByName(object!);
          if(request.method==="GET") return Response.json(await host.getG9SelfDev(),
            {headers:{"Cache-Control":"no-store"}});
          if(request.method!=="POST")return new Response("Method not allowed",{status:405});
          if(!settingsOriginAllowed)return Response.json({error:"Se requiere petición JSON autenticada del mismo origen."},{status:403});
          return Response.json(await host.startG9SelfDev(),
            {headers:{"Cache-Control":"no-store"}});
        }catch(error){
          return Response.json({error:error instanceof Error?error.message:"Error verificando G9"},
            {status:422,headers:{"Cache-Control":"no-store"}});
        }
      }
      if (url.pathname === "/api/dev/g8-agent-check") {
        const object = url.searchParams.get("object");
        try {
          validateExportIdentity(object, "ses_root");
          const host = env.OpenCodeAgent.getByName(object!);
          if (request.method === "GET") {
            return Response.json(await host.getG8LiveReview(), { headers: { "Cache-Control": "no-store" } });
          }
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          if (!settingsOriginAllowed) {
            return Response.json({ error: "Origin y JSON obligatorios" }, { status: 403 });
          }
          // A single explicit owner tap authorizes exactly two read-only real
          // model tasks. No user-provided repo, branch, prompt or model.
          return Response.json(await host.startG8LiveReview(), { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Error de prueba G8" },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/isolated-backup-probe" && request.method === "POST") {
        if (url.hostname !== "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" || !settingsOriginAllowed) {
          return Response.json({ error: "Solo disponible en staging con el mismo origen." }, { status: 403 });
        }
        try {
          const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          const result = await checkIsolatedBackup(name => env.DEV.getByName(name), nonce);
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Falló la prueba." },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/repository-import-probe" && request.method === "POST") {
        if (url.hostname !== "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" || !settingsOriginAllowed) {
          return Response.json({ error: "Solo disponible en staging con el mismo origen." }, { status: 403 });
        }
        try {
          const raw = await request.text();
          if (raw.length > 300) throw Error("Solicitud demasiado grande");
          const input = JSON.parse(raw) as { object?: string; session?: string; repository?: string };
          validateExportIdentity(input.object, input.session);
          const host = env.OpenCodeAgent.getByName(input.object!);
          // The repository selector creates the session before its first chat
          // message. Bind the explicit, authorized selection before probing.
          await host.bindSessionScope(input.session!,
            repositoryImportScope(input.repository, await personal.getAllowedRepositories()));
          const repo = await host.sessionRepository(input.session!);
          const project = "repocheck-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          const dev = env.DEV.getByName(projectContainerName(project));
          const receipt = await dev.prepareRepository(project, repo);
          const listing = await dev.inspect(project, "list", "");
          return Response.json({ receipt, listing }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Falló la importación." },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/isolation-probe" && request.method === "POST") {
        if (url.hostname !== "opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev" || !settingsOriginAllowed) {
          return Response.json({ error: "Solo disponible en staging con el mismo origen." }, { status: 403 });
        }
        try {
          const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          const result = await checkIsolation(name => env.DEV.getByName(name), nonce);
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Falló la prueba." },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/g8-verify" && request.method === "POST") {
        if (!settingsOriginAllowed) {
          return Response.json({ error: "Se requiere una solicitud autenticada del mismo origen." }, { status: 403 });
        }
        const key = (env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN || await personal.getGitHubKey();
        if (!key) {
          return Response.json({ error: "Primero conecta GitHub en Configuración de OpenCode Cloud." }, { status: 422 });
        }
        try {
          const bridge = new GitHubBridge(key, (input, init) => globalThis.fetch(input, init),
            await personal.getAllowedRepositories());
          const outcome = await verifyG8Proofs(action => bridge.execute(action),
            await personal.getAllowedRepositories());
          return Response.json(outcome, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "G8 verification failed" },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/incidents" && request.method === "GET") {
        return Response.json({ incidents: await personal.listIncidents() },
          { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      }
      if (url.pathname === "/api/dev/agent-check") {
        const body = request.method === "POST" && request.headers.get("Origin") === url.origin &&
          request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")
          ? (await request.json()) as { workspace?: string; model?: string; kind?: string }
          : null;
        const workspace = request.method === "GET" ? url.searchParams.get("workspace") : body?.workspace;
        if (!workspace || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(workspace)) {
          return Response.json({ error: "Se requiere un espacio autenticado válido" }, { status: 403 });
        }
        const host = env.OpenCodeAgent.getByName(workspace);
        if (request.method === "GET") {
          return Response.json(await host.agentCheckStatus(), { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST") {
          return Response.json(await host.startAgentCheck(body?.model, body?.kind), { headers: { "Cache-Control": "no-store" } });
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/api/dev/backups" && request.method === "GET") {
        const isolated = await projectRegistry.listIsolatedProjects();
        const others = await Promise.all(isolated.map(p =>
          env.DEV.getByName(projectContainerName(p.project)).listBackups()));
        return Response.json({ backups: [...await projectRegistry.listBackups(), ...others.flat()] },
          { headers: { "Cache-Control": "no-store" } });
      }
      const durableBackup = url.pathname.match(/^\/api\/dev\/backup\/([a-z][a-z0-9-]{0,39})$/);
      if (durableBackup) {
        const project = durableBackup[1];
        const dev = await readableProject(project);
        if (request.method === "GET") return await dev.downloadSavedBackup(project);
        if (request.method === "POST") {
          if (request.headers.get("Origin") !== url.origin ||
              !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
            return Response.json({ error: "Origen no permitido" }, { status: 403 });
          }
          try {
            const raw = await request.text();
            if (raw.length > 300) return Response.json({ error: "Request too large" }, { status: 413 });
            const args = raw ? JSON.parse(raw) as { sessionRef?: string } : {};
            return Response.json({ backup: await dev.saveBackup(project, args.sessionRef) },
              { headers: { "Cache-Control": "no-store" } });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : "Backup failed" },
              { status: 422, headers: { "Cache-Control": "no-store" } });
          }
        }
        return new Response("Method not allowed", { status: 405 });
      }
      const restoreMatch = url.pathname.match(/^\/api\/dev\/restore\/([a-z][a-z0-9-]{0,39})$/);
      if (restoreMatch) {
        if (request.method !== "POST") return new Response("POST only", { status: 405 });
        if (request.headers.get("Origin") !== url.origin ||
            !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
          return Response.json({ error: "Same-origin JSON required" }, { status: 403 });
        }
        try {
          const raw = await request.text();
          if (raw.length > 300) return Response.json({ error: "Request too large" }, { status: 413 });
          const input = JSON.parse(raw) as { target?: string };
          const source = restoreMatch[1], target = input.target ?? "";
          const sourceDev = await readableProject(source);
          const metadata = (await sourceDev.listBackups()).find(item => item.project === source);
          if (!metadata) throw Error("No hay respaldo guardado");
          const archive = await sourceDev.downloadSavedBackup(source);
          if (!archive.ok) throw Error("No se pudo leer el respaldo");
          const bytes = new Uint8Array(await archive.arrayBuffer());
          await projectRegistry.reserveIsolatedProject(target);
          const targetDev = env.DEV.getByName(projectContainerName(target));
          const restored = await targetDev.restoreExternalBackup(source, target, bytes, metadata.sha256);
          const restoration = { ...restored,
            ...(metadata.sessionRef ? {sessionRef: metadata.sessionRef} : {}),
            ...(metadata.gitBranch ? {gitBranch: metadata.gitBranch} : {}),
            ...(metadata.gitHead ? {gitHead: metadata.gitHead} : {}) };
          return Response.json({ restoration }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Restore failed" },
            { status: 422, headers: { "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/api/dev/projects" && request.method === "GET") {
        const isolated = await projectRegistry.listIsolatedProjects();
        const projects = await Promise.all(isolated.map(p =>
          env.DEV.getByName(projectContainerName(p.project)).listProjects()));
        return Response.json({
          projects: [...await projectRegistry.listProjects(), ...projects.flat()]
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
        const source = url.searchParams.get("source");
        if (source && source !== "github") return archiveError(400, "Fuente de descarga no reconocida.");
        if (source === "github") {
          const object = url.searchParams.get("object");
          const session = url.searchParams.get("session");
          try {
            validateExportIdentity(object, session);
            // Retrieve the remote repository from immutable, server-stored
            // session scope. Never trust the URL or an LLM for repo identity.
            const selected = await env.OpenCodeAgent.getByName(object!).sessionRepository(session!);
            const normalizedProject = selected.split("/")[1].toLowerCase()
              .replace(/[^a-z0-9-]+/g, "-").replace(/-+$/, "").slice(0, 40);
            if (normalizedProject !== project && repositoryProjectSlug(selected) !== project) {
              return archiveError(403, "El repositorio de esta sesión no coincide con el proyecto solicitado.");
            }
            const token = (env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN || await personal.getGitHubKey();
            return githubRepositoryDownload(selected, token || "",
              await personal.getAllowedRepositories());
          } catch (error) {
            return archiveError(422, error instanceof Error ? error.message : "No se pudo identificar el repositorio seleccionado.");
          }
        }
        try {
          const file = await (await readableProject(project)).download(project);
          return await archiveDownloadResponse(project, file, "tar.gz");
        } catch {
          return archiveError(502, "No se pudo preparar el archivo del Container. Revisa que existan archivos locales o descarga desde el repositorio GitHub seleccionado.");
        }
      }
      const verifyMatch = url.pathname.match(/^\/api\/dev\/verify\/([a-z][a-z0-9-]{0,39})$/);
      if (verifyMatch) {
        // This endpoint writes and corrupts ONLY a newly created scratch
        // fixture, but it is not a safe/read-only GET operation.
        if (request.method !== "POST") return new Response("POST only", { status: 405 });
        if (request.headers.get("Origin") !== url.origin ||
            !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
          return Response.json({ error: "Same-origin JSON request required" }, { status: 403 });
        }
        try {
          // Respect the same isolated per-project Container selection as Linux tools.
          const result = await (await readableProject(verifyMatch[1])).verifyRestore(verifyMatch[1]);
          return Response.json(result, {
            status: result.ok && result.exitCode === 0 ? 200 : 422,
            headers: { "Cache-Control": "no-store" }
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Verify failed" },
            { status: 500, headers: { "Cache-Control": "no-store" } }
          );
        }
      }
      const previewMatch = url.pathname.match(/^\/api\/dev\/preview\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/);
      if (previewMatch) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("GET only", { status: 405 });
        }
        const project = previewMatch[1];
        const path = previewMatch[2] || "index.html";
        const dev = await readableProject(project);
        const result = await dev.preview(project, path);
        const headers = new Headers(result.headers);
        let responseBody: BodyInit | null = request.method === "HEAD" ? null : result.body;
        if (request.method === "GET" && result.ok &&
            headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
          // In CSP sandbox, a generated page has an opaque origin. With
          // Cloudflare Access its own CSS/JS subrequests may lose cookies.
          // Embed only small assets from this project's dist/ on the server,
          // retaining the opaque-origin sandbox and denying source-tree reads.
          const html = await result.text();
          responseBody = await inlinePreviewAssets(html, path, (assetPath) =>
            dev.preview(project, assetPath));
          headers.delete("Content-Length");
        }
        // A generated application must not inherit the authenticated
        // OpenCode origin or invoke /api/dev/run from its own scripts.
        // CSP sandbox applies even when a preview URL is opened directly.
        headers.set("Content-Security-Policy",
          "sandbox allow-scripts; default-src https: data: blob:; script-src https: 'unsafe-inline' blob: data:; style-src https: 'unsafe-inline'; connect-src https:; img-src https: data: blob:; font-src https: data:; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("Cache-Control", "no-store");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(responseBody, {
          status: result.status,
          headers
        });
      }
      if (url.pathname === "/api/dev/review" && request.method === "POST") {
        if (!settingsOriginAllowed) return Response.json({ error: "Origen no permitido" }, { status: 403 });
        const body = await request.text();
        if (body.length > 300) return Response.json({ error: "Solicitud demasiado grande" }, { status: 413 });
        const { project } = JSON.parse(body) as { project: string };
        if (!await projectRegistry.isolatedProject(project)) {
          const listing = await projectRegistry.inspect(project, "list", "") as {
            entries: { name: string; type: string }[]
          };
          return Response.json({ project, exitCode: 0, stderr: "", truncated: false,
            stdout: "Proyecto anterior: listado de solo lectura; no es un diff Git.\\n" +
              listing.entries.map(item => item.name + (item.type === "directory" ? "/" : "")).join("\\n") },
            { headers: { "Cache-Control": "no-store" } });
        }
        const command = "if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then " +
          "printf 'ARCHIVOS MODIFICADOS\\n'; git status --short --untracked-files=normal; " +
          "printf '\\nRESUMEN DE DIFERENCIAS\\n'; git diff --stat; " +
          "printf '\\nÚLTIMO COMMIT\\n'; git log -1 --format='%h %s'; " +
          "else printf 'Sin repositorio Git: listado actual de archivos (no es un diff).\\n'; " +
          "find . -maxdepth 2 -type f -not -path './node_modules/*' | sort | head -80; fi";
        return Response.json(await (await readableProject(project)).run(project, command),
          { headers: { "Cache-Control": "no-store" } });
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
        try {
          if (!await projectRegistry.isolatedProject(project)) await projectRegistry.reserveIsolatedProject(project);
          const result = await (await readableProject(project)).run(project, command);
          const incident = observeLinux(result);
          if (incident) {
            try { await personal.recordIncident(incident); }
            catch { console.warn("Incident ledger write unavailable"); }
          }
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          try {
            await personal.recordIncident({ source: "linux", project, tool: "linux",
              code: classifyAgentFailure(error instanceof Error ? error.message : "") });
          } catch { console.warn("Incident ledger write unavailable"); }
          throw error;
        }
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

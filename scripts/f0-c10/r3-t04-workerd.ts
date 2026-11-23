/**
 * F0-C10/R3-T04: LOCAL, DISPOSABLE workerd/SQLite only.
 * Never import in production src/entrypoint.ts; never deploy this config.
 * No model calls, no Linux, no GitHub, no external tools or credentials.
 */
import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { OpenCodeHarness } from "agents/harness/opencode";
import { Lifecycle } from "agents/lifecycle";
import { r2SessionId } from "../../src/supervisor-r2";
import { scopeStorageKey } from "../../src/project-scope";
import { supervisorTaskKey, type SupervisorTask } from "../../src/supervisor-control";
import {
  reserveSupervisorAdmission, supervisorBeginExternalEffect,
  supervisorAdmissionSlot, supervisorCommitCreatedSession,
  supervisorGrantStillOwned, reconcileSupervisorCreatedSession,
  reserveSupervisorContinuation, reconcileSupervisorTurnEffect,
  type StartGrant
} from "../../src/supervisor-admission";

type LocalEnv = { R3_LAB: DurableObjectNamespace<R3RecoveryLab> };
const REPO = "aamvtrampa36-del/opencode-harness-example";
const send = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const errorString = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 200) :
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag) : String(error).slice(0, 200);

export class R3RecoveryLab extends DurableObject<LocalEnv> {
  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) => OpenCodeWorkerd.create({
      storage, config: { default_agent: "build" },
      log: { level: "warn", emit: () => undefined }
    })
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);
  // Local fixture only: deliberately keep an original request in flight
  // AFTER the native SDK has persisted its session, BEFORE supervisor commit.
  private releaseCreator?: () => void;

  private async nativeGet(sessionID: string):
    Promise<{ found: boolean; id?: string; errorTag?: string }> {
    try {
      // This invokes the real pinned SDK. harness.sessions.get(id) would
      // ONLY create a handle and is not an existence/read test.
      const row = await this.harness.use(opencode =>
        opencode.sessions.get({ sessionID }));
      return { found: row?.id === sessionID, id: row?.id };
    } catch (error) {
      return { found: false, errorTag:
        error && typeof error === "object" && "_tag" in error
          ? String(error._tag) : "UNTAGGED:" + errorString(error) };
    }
  }

  private async state(id: string) {
    const sid = r2SessionId(id);
    const [task, slot, owner] = await Promise.all([
      this.ctx.storage.get<SupervisorTask>(supervisorTaskKey(id)),
      supervisorAdmissionSlot(this.ctx.storage, id),
      this.ctx.storage.get<string>("supervisor:session:" + sid)
    ]);
    return { task, slot, owner };
  }

  private nativeRows(sessionID: string) {
    // Real DO/SQLite, bounded schema introspection without exposing content.
    const sql = this.ctx.storage.sql;
    const tables = [...sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'opencode_%' ORDER BY name")].map(r => r.name);
    const matches = tables.filter(name => /^opencode_[a-z0-9_]*session[a-z0-9_]*$/i.test(name));
    return { tables: tables.length, sessionTables: matches,
      matchingRows: matches.map(name => {
        try {
          const rows = [...sql.exec<{ n: number }>(
            'SELECT COUNT(*) AS n FROM "' + name + '" WHERE id = ?', sessionID)];
          return { table: name, count: Number(rows[0]?.n ?? 0) };
        } catch { return { table: name, count: -1 }; }
      })
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const input = request.method === "POST" ?
      await request.json().catch(() => ({})) as Record<string, unknown> : {};
    const id = String(input.id ?? url.searchParams.get("id") ?? "0000000000000001");
    const sid = r2SessionId(id);
    try {
      switch (url.pathname) {
        case "/get": return send({ ...await this.nativeGet(sid), native: this.nativeRows(sid) });
        case "/state": return send(await this.state(id));
        case "/prepare": {
          const candidate: SupervisorTask = {
            id, repository: REPO, project: "supervised-" + id,
            branch: "opencode/staging-" + id, fingerprint: "a".repeat(64),
            createdAt: Date.now(), status: "preparing", revision: 0,
            sessionCreationAttempted: false, sessionIdPolicy: "deterministic-v1"
          };
          const reservation = await reserveSupervisorAdmission(this.ctx.storage, candidate);
          if (reservation.kind !== "granted") return send({ kind: reservation.kind });
          if (input.intent === true) {
            await supervisorBeginExternalEffect(this.ctx.storage, reservation.grant, "session_create");
            if (input.marker !== false) {
              const task = await this.ctx.storage.get<SupervisorTask>(supervisorTaskKey(id));
              await this.ctx.storage.put(supervisorTaskKey(id), {
                ...task!, sessionCreationAttempted: true
              });
            }
          }
          return send({ kind: "granted", grant: reservation.grant });
        }
        case "/create": {
          const before = this.nativeRows(sid);
          const nativeId = await this.harness.create({ id: sid });
          const after = this.nativeRows(sid);
          if (input.lost === true) return send({
            simulatedLostReply: true, committed: false, before, after
          }, 503);
          return send({ nativeId, before, after });
        }
        case "/held": return send({ held: Boolean(this.releaseCreator) });
        case "/release-held": {
          const release = this.releaseCreator;
          if (!release) return send({ error: "NO_CREATOR_HELD" }, 409);
          this.releaseCreator = undefined;
          release();
          return send({ released: true });
        }
        case "/create-held": {
          const grant = input.grant as StartGrant;
          const nativeId = await this.harness.create({ id: sid });
          if (nativeId !== sid) throw Error("SDK_SESSION_ID_MISMATCH");
          await new Promise<void>(resolve => { this.releaseCreator = resolve; });
          // Original request is now DELIBERATELY LATE. Optionally inject an
          // SDK-ish failure not labeled ADMISSION_FENCE_REJECTED to validate
          // the production catch's transactional token+generation guard.
          try {
            if (input.injectError === true) throw Error("SDK_ERROR_AFTER_SESSION_ROW_PERSISTED");
            await supervisorCommitCreatedSession(this.ctx.storage, grant, sid);
            return send({ kind: "committed", state: await this.state(id) });
          } catch (error) {
            const verdict = await this.ctx.storage.transaction(async tx => {
              const task = await tx.get<SupervisorTask>(supervisorTaskKey(id));
              if (!task) throw Error("TASK_MISSING");
              if (!await supervisorGrantStillOwned(tx, grant)) return "fenced";
              await tx.put(supervisorTaskKey(id), { ...task, status: "failed" as const });
              return "WRITTEN_BY_OLD_CREATOR";
            });
            return send({ kind: verdict, error: errorString(error),
              state: await this.state(id) });
          }
        }
        case "/reconcile": {
          const native = await this.nativeGet(sid);
          if (!native.found) return send({ kind: "effect_unknown", native });
          const expected = await supervisorAdmissionSlot(this.ctx.storage, id);
          if (!expected) return send({ kind: "effect_unknown", native });
          const outcome = await reconcileSupervisorCreatedSession(
            this.ctx.storage, id, sid, expected);
          return send({ kind: outcome.kind, native, state: await this.state(id),
            ...(outcome.kind === "recovered" ?
              { grant: outcome.grant } : { reason: outcome.reason }) });
        }
        case "/commit": {
          const grant = input.grant as StartGrant;
          const task = await supervisorCommitCreatedSession(this.ctx.storage, grant, sid);
          return send({ kind: "committed", session: task.session, state: await this.state(id) });
        }
        case "/late-effect": {
          const grant = input.grant as StartGrant;
          await supervisorBeginExternalEffect(this.ctx.storage, grant, "configure");
          return send({ kind: "UNEXPECTED_NATIVE_EFFECT_ALLOWED" });
        }
        case "/late-error": {
          const grant = input.grant as StartGrant;
          const outcome = await this.ctx.storage.transaction(async tx => {
            const task = await tx.get<SupervisorTask>(supervisorTaskKey(id));
            if (!task) throw Error("TASK_MISSING");
            // Same actual production function now invoked in server.ts catch.
            if (!await supervisorGrantStillOwned(tx, grant))
              return { kind: "fenced", status: task.status };
            await tx.put(supervisorTaskKey(id), { ...task, status: "failed" as const });
            return { kind: "written", status: "failed" };
          });
          return send({ ...outcome, state: await this.state(id) });
        }
        case "/foreign-scope": {
          await this.ctx.storage.put(scopeStorageKey(sid), {
            project: "supervised-ffffffffffffffff", repository: REPO
          });
          return send({ kind: "foreign-scope-installed" });
        }
        case "/foreign-owner": {
          await this.ctx.storage.put("supervisor:session:" + sid, "ffffffffffffffff");
          return send({ kind: "foreign-owner-installed" });
        }
        case "/finish": {
          const grant = input.grant as StartGrant;
          await supervisorBeginExternalEffect(this.ctx.storage, grant, "submit");
          // Simulated native terminal receipt: does NOT call model or SDK submit.
          const { supervisorConfirmExternalEffect } =
            await import("../../src/supervisor-admission");
          await supervisorConfirmExternalEffect(this.ctx.storage, grant,
            "submit", { confirmed: true });
          await this.ctx.storage.transaction(async tx => {
            const task = await tx.get<SupervisorTask>(supervisorTaskKey(id));
            await tx.put(supervisorTaskKey(id), { ...task!, session: sid,
              status: "finished", operationId: "rc-start-" + id });
          });
          return send({ kind: "finished-synthetic-receipt", state: await this.state(id) });
        }
        case "/readmit": {
          const turn = String(input.turn ?? "1111111111111111");
          const op = "rc-turn-" + id + "-" + turn;
          const result = await reserveSupervisorContinuation(
            this.ctx.storage, id, turn, "b".repeat(64), op);
          return send({ kind: result.kind, state: await this.state(id) });
        }
        case "/turn-receipt": {
          const turn = String(input.turn ?? "1111111111111111");
          const op = "rc-turn-" + id + "-" + turn;
          const status = input.status === "done" ? "done" : "unanswered";
          const reason = String(input.reason ?? "not_found");
          // Real T03 ledger and SQLite transaction; receipt itself is a
          // SYNTHETIC test value, not an OpenCode model/tool invocation.
          const accepted = await this.ctx.storage.transaction(tx =>
            reconcileSupervisorTurnEffect(tx, id, op, { status, reason }));
          return send({ accepted, state: await this.state(id) });
        }
        default: return send({ error: "UNKNOWN_LOCAL_TEST_ACTION" }, 404);
      }
    } catch (error) {
      return send({ error: errorString(error), state: await this.state(id) }, 409);
    }
  }
}

export default {
  async fetch(request: Request, env: LocalEnv): Promise<Response> {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") ?? "fixture-0";
    if (!/^fixture-[0-9a-z-]{1,40}$/.test(scope))
      return send({error:"INVALID_DISPOSABLE_SCOPE"},422);
    const stub = env.R3_LAB.get(env.R3_LAB.idFromName(scope));
    return stub.fetch(request);
  }
} satisfies ExportedHandler<LocalEnv>;

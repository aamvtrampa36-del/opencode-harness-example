/**
 * B2 — Disposable Durable Object for the OpenCode session SQL backup drill.
 *
 * This class exists ONLY so the Staging supervisor Workflow can create fresh,
 * isolated OpenCode hosts and copy their harness SQL. It is intentionally a
 * SEPARATE class and namespace from OpenCodeAgent:
 *
 *   - A drill object's storage hosts its OWN OpenCode schema (the harness
 *     opens OpenCode over `ctx.storage` with the tables under `opencode_`,
 *     exactly like the main agent). No drill object ever shares storage with
 *     a real user workspace: user workspaces are UUID names in the
 *     OpenCodeAgent namespace, while drill objects live in the dedicated
 *     SESSION_BK namespace under "opencode-sqlbak-*" names.
 *   - The harness here is MINIMAL on purpose: only the Workers AI plugin and
 *     the default Workers AI model, so a fixture turn works without GitHub,
 *     MCP, OpenRouter or workspace tooling. The drill object therefore has no
 *     path to user repositories, settings or tools.
 *   - Every public method re-checks OPENCODE_SUPERVISOR_ENABLED (fail-closed)
 *     and is invoked only by the `session_backup_drill` Workflow action.
 *   - `deleteAll()` (atomic on SQLite-backed storage) wipes a restore object
 *     before its harness opens, so the restored SQL state is the only state
 *     the object ever holds, and drains it again at cleanup.
 *
 * All heavy lifting lives in ./session-sql-backup, which is covered by unit
 * tests without the Worker runtime.
 */

import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { OpenCodeHarness } from "agents/harness/opencode";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/opencode";
import {
  drillCleanupStorage, drillCreateFixture, drillExportSnapshot, drillRestoreCommit,
  drillRestorePrepare, drillRestoreVerify, drillRestoreWipe,
  type DrillStorage, type SessionHarnessLike, type SqlLike
} from "./session-sql-backup";

/** Same default Workers AI model the main agent uses; no secret involved. */
const DRILL_MODEL_ID = "@cf/openai/gpt-oss-20b";

export class SessionBackupDrillAgent extends DurableObject<Env> {
  readonly ai = createAI({ binding: this.env.AI });

  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) =>
      OpenCodeWorkerd.create({
        // The drill object's own storage, with OpenCode's tables under `opencode_`.
        storage,
        config: { default_agent: "build" },
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
        plugins: [this.ai.plugin]
      }),
    defaults: { model: this.ai(DRILL_MODEL_ID), agent: "build" }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  private drillSql(): SqlLike {
    return this.ctx.storage.sql as unknown as SqlLike;
  }

  private drillStorage(): DrillStorage {
    return this.ctx.storage as unknown as DrillStorage;
  }

  private drillHarness(): SessionHarnessLike {
    return this.harness as unknown as SessionHarnessLike;
  }

  /** Creates disposable fixture sessions via the normal harness APIs. */
  async sessionBackupDrillCreate(input: unknown): Promise<unknown> {
    return drillCreateFixture(this.env, this.drillHarness(), input);
  }

  /** Snapshots every `opencode_` table plus the normal-read fingerprints. */
  async sessionBackupDrillExport(input: unknown): Promise<unknown> {
    return drillExportSnapshot(this.env, this.drillHarness(), this.drillSql(), input);
  }

  /** Atomic wipe (`deleteAll`) of this disposable restore object. */
  async sessionBackupDrillRestoreWipe(): Promise<unknown> {
    return drillRestoreWipe(this.env, this.drillStorage());
  }

  /** Opens OpenCode after the wipe and captures the target schema. */
  async sessionBackupDrillRestorePrepare(): Promise<unknown> {
    return drillRestorePrepare(this.env, this.drillHarness(), this.drillSql());
  }

  /** Applies the snapshot inside ONE storage.transaction (all-or-nothing). */
  async sessionBackupDrillRestoreCommit(input: unknown): Promise<unknown> {
    return drillRestoreCommit(this.env, this.drillSql(), this.drillStorage(), input);
  }

  /** Post-commit digests + normal read path equality against the manifest. */
  async sessionBackupDrillRestoreVerify(input: unknown): Promise<unknown> {
    return drillRestoreVerify(this.env, this.drillHarness(), this.drillSql(), input);
  }

  /** Drains this disposable object after the drill (`deleteAll`). */
  async sessionBackupDrillCleanup(): Promise<unknown> {
    return drillCleanupStorage(this.env, this.drillStorage());
  }
}

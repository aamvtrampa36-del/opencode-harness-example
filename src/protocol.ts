export type AgentMode = "build" | "plan" | "review" | "creative";
import type { ModelSelectionID } from "./model-presets";
import type {
  OpenCodeMessage,
  OpenCodePendingOperation,
  OpenCodeSessionEvent,
  OpenCodeSessionId,
  OpenCodeSessionInfo,
  OpenCodeWhenBusy
} from "agents/harness/opencode";

/**
 * This app's WebSocket protocol, served by `sockets.ts`. The harness knows
 * nothing about it: it is one way to put a session's transcript, its live
 * events and `session.submit()` on a socket.
 */

/** Client → server. Commands with an `id` get a `result` or `error` back. */
export type ClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly text: string;
      readonly whenBusy?: OpenCodeWhenBusy;
      readonly model?: ModelSelectionID;
      readonly mode?: AgentMode;
      readonly specialization?: string;
      readonly project?: string;
      readonly repository?: string;
      readonly files?: readonly { readonly data: string; readonly mime: string; readonly name: string }[];
    }
  | { readonly type: "select_model"; readonly id?: string; readonly model: ModelSelectionID }
  | { readonly type: "abort"; readonly id?: string }
  | { readonly type: "create"; readonly id?: string }
  | { readonly type: "delegate"; readonly id?: string; readonly project: string }
  | { readonly type: "resync"; readonly id?: string };

/** Backend-confirmed model set when an actual operation was submitted. */
export type ModelRun = {
  readonly operationId: string;
  readonly model: ModelSelectionID;
  readonly providerID: "cloudflare" | "openrouter";
  readonly id: string;
  readonly at: number;
};

/** One session's state: what a client renders. */
export type SessionSnapshot = {
  readonly session: OpenCodeSessionId;
  /** The whole transcript, compacted messages included. */
  readonly messages: readonly OpenCodeMessage[];
  readonly busy: boolean;
  readonly pending: readonly OpenCodePendingOperation[];
  readonly modelRuns: readonly ModelRun[];
};

/** Server → client. */
export type ServerMessage =
  | { readonly type: "hello"; readonly session: OpenCodeSessionId; readonly openRouterAvailable: boolean }
  /** Server-authoritative selection for this session, persisted in the existing DO. */
  | { readonly type: "model_selection"; readonly session: OpenCodeSessionId; readonly model: ModelSelectionID; readonly pending: boolean }
  | {
      readonly type: "sessions";
      readonly sessions: readonly OpenCodeSessionInfo[];
    }
  /** Replaces the client's state for the session. */
  | ({ readonly type: "snapshot" } & SessionSnapshot)
  /** The session's events from `session.events()`, live deltas included. */
  | { readonly type: "event"; readonly event: OpenCodeSessionEvent }
  | { readonly type: "workflow"; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly stage: number; readonly total: number; readonly name: string; readonly error?: string }
  | { readonly type: "result"; readonly id: string; readonly result: unknown }
  | {
      readonly type: "error";
      readonly id?: string;
      readonly message: string;
      /** Set when the socket's session does not exist; the socket closes. */
      readonly code?: "unknown_session";
    };

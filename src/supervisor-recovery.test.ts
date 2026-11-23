import { describe, expect, test } from "bun:test";
import {
  canConfirmSupervisorPreSessionCancellation,
  classifySupervisorOperation,
  supervisorSessionCreationDisposition,
  supervisorStartOperationId,
  supervisorTurnOperationId
} from "./supervisor-control";

describe("F0-C10/T04 interrupted supervisor recovery (synthetic fixtures)", () => {
  const id = "a642be2611220007";

  test("write-ahead create marker blocks duplicate session after lost create reply", () => {
    const job: { sessionCreationAttempted: boolean; session?: string } =
      { sessionCreationAttempted: false };
    let creates = 0;
    const attempt = () => {
      const action = supervisorSessionCreationDisposition(job);
      if (action !== "create") return action;
      job.sessionCreationAttempted = true; // durable marker before external RPC
      creates++;
      throw Error("response lost after create/fork side effect");
    };
    expect(() => attempt()).toThrow("response lost");
    expect(attempt()).toBe("reconcile");
    expect(creates).toBe(1);
    expect(canConfirmSupervisorPreSessionCancellation(job, false)).toBe(false);
  });

  test("legacy records without a marker fail closed rather than replaying create", () => {
    expect(supervisorSessionCreationDisposition({})).toBe("reconcile");
    expect(canConfirmSupervisorPreSessionCancellation({}, false)).toBe(false);
    expect(supervisorSessionCreationDisposition({ session: "ses_test" })).toBe("bound");
  });

  test("cancellation before session creation requires both a persisted safe marker and no start lock", () => {
    const reserved = { sessionCreationAttempted: false };
    expect(canConfirmSupervisorPreSessionCancellation(reserved, false)).toBe(true);
    expect(canConfirmSupervisorPreSessionCancellation(reserved, true)).toBe(false);
    expect(canConfirmSupervisorPreSessionCancellation({
      sessionCreationAttempted: true
    }, false)).toBe(false);
    expect(canConfirmSupervisorPreSessionCancellation({
      session: "ses_test", sessionCreationAttempted: true
    }, false)).toBe(false);
  });

  test("lost response after submit keeps a stable native operation key", () => {
    const first = supervisorStartOperationId(id);
    expect(first).toBe("rc-start-" + id);
    expect(supervisorStartOperationId(id)).toBe(first);
    const turn = supervisorTurnOperationId(id, "0000000000000001");
    expect(turn).toBe("rc-turn-" + id + "-0000000000000001");
    expect(supervisorTurnOperationId(id, "0000000000000001")).toBe(turn);
    expect(turn).not.toBe(first);
  });

  test("native completion reconciles an erroneously cached failed status", () => {
    const stored = { status: "failed" as const, operationId: supervisorStartOperationId(id) };
    expect(classifySupervisorOperation(stored, false, { status: "done" })).toBe("finished");
    expect(classifySupervisorOperation(stored, false, {
      status: "unanswered", reason: "failed"
    })).toBe("failed");
  });

  test("not_found and lost wait receipt do not produce fictitious completion", () => {
    const stored = { status: "running" as const, operationId: supervisorStartOperationId(id) };
    expect(classifySupervisorOperation(stored, false, {
      status: "unanswered", reason: "not_found"
    })).toBe("unknown");
    expect(classifySupervisorOperation(stored, false)).toBe("unknown");
    expect(classifySupervisorOperation(stored, true)).toBe("running");
  });

  test("cancellation is confirmed only by interrupted native receipt", () => {
    const job = { status: "cancel_requested" as const, operationId: supervisorStartOperationId(id) };
    expect(classifySupervisorOperation(job, false, {
      status: "unanswered", reason: "interrupted"
    })).toBe("cancelled");
    expect(classifySupervisorOperation(job, false, {
      status: "unanswered", reason: "not_found"
    })).toBe("unknown");
    expect(classifySupervisorOperation(job, true)).toBe("cancel_requested");
  });
});

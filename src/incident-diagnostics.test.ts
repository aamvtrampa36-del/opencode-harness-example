import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  aggregateIncident, buildIncidentDiagnostics, cleanObservation, classifyAgentFailure,
  correlateTaskId, DIAGNOSTICS_DEFAULT_LIMIT, DIAGNOSTICS_ORDER, observeLinux, retryDecision,
  taskIdFromProject, type IncidentRecord
} from "./incident-diagnostics";

describe("G7 passive incident registry", () => {
  test("records a real failing Node command without relying on any model description", () => {
    const proof = spawnSync(process.execPath, ["-e", "process.exit(19)"], { encoding: "utf8" });
    expect(proof.status).toBe(19);
    const event = observeLinux({ project: "g7-failure", exitCode: proof.status, stdout: proof.stdout, stderr: proof.stderr });
    expect(event?.code).toBe("SHELL_FAILED");
    let incidents = aggregateIncident([], event, new Date("2026-11-10T12:00:00Z"));
    expect(incidents[0]).toMatchObject({
      code: "SHELL_FAILED", source: "linux", exitCode: 19, count: 1, automaticRetryAllowed: false
    });
    // A repeated real failure counts as the SAME incident, not another patch candidate.
    incidents = aggregateIncident(incidents, event, new Date("2026-11-10T12:01:00Z"));
    incidents = aggregateIncident(incidents, event, new Date("2026-11-10T12:02:00Z"));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({count:3,status:"blocked",automaticRetryAllowed:false});
    expect(incidents[0].firstAt).toBe("2026-11-10T12:00:00.000Z");
    expect(incidents[0].lastAt).toBe("2026-11-10T12:02:00.000Z");
  });
  test("classifies independent test failure, timeout and success", () => {
    expect(observeLinux({project:"g7-test",exitCode:1,stdout:"not ok 1 - actual test"}))
      .toMatchObject({code:"TEST_FAILED",exitCode:1});
    expect(observeLinux({project:"g7-test",exitCode:124})).toMatchObject({code:"LATENCY_TIMEOUT"});
    expect(observeLinux({project:"g7-test",exitCode:0,stdout:"not ok from an old log"})).toBeNull();
    expect(retryDecision("TEST_FAILED",1)).toBe(false);
    expect(retryDecision("LATENCY_TIMEOUT",1)).toBe(true);
    expect(retryDecision("LATENCY_TIMEOUT",2)).toBe(true);
    expect(retryDecision("LATENCY_TIMEOUT",3)).toBe(false);
  });
  test("known failures classified without writing raw error text", () => {
    expect(classifyAgentFailure("Provider unavailable (429)")).toBe("MODEL_UNAVAILABLE");
    expect(classifyAgentFailure("unknown tool inspect_linx")).toBe("TOOL_MISSING");
    expect(classifyAgentFailure("Snapshot cannot be restored")).toBe("PERSISTENCE_FAILED");
    expect(classifyAgentFailure("deadline exceeded timeout")).toBe("LATENCY_TIMEOUT");
    expect(classifyAgentFailure("stuck session")).toBe("SESSION_STALLED");
    expect(classifyAgentFailure("unrecognized failure")).toBe("AGENT_FAILURE");
  });
  test("discards untrusted payloads, stdout, prompts, commands and credentials", () => {
    const raw = {
      code: "TEST_FAILED", source: "linux", project: "g7-test", tool:"linux", exitCode:1,
      prompt:"private chat", stdout:"API_KEY=secret", stderr:"do not store",
      command:"rm -rf /", credentials:"secret", httpStatus:500
    };
    const result = aggregateIncident([],raw)[0];
    const persisted = JSON.stringify(result);
    for(const forbidden of ["private chat","API_KEY","do not store","rm -rf","secret"]) {
      expect(persisted).not.toContain(forbidden);
    }
    expect(result.httpStatus).toBe(500);
    expect(cleanObservation({...raw, project:"../../private", exitCode:-1})).not.toHaveProperty("project");
    expect(() => cleanObservation({...raw, code:"USER_PROVIDED_SECRET"})).toThrow();
  });
  test("same project with distinct exit codes produces distinct incident fingerprints", () => {
    let incidents = aggregateIncident([], { code:"SHELL_FAILED", source:"linux", project:"g7-test", tool:"linux", exitCode:1 });
    incidents = aggregateIncident(incidents, { code:"SHELL_FAILED", source:"linux", project:"g7-test", tool:"linux", exitCode:2 });
    expect(incidents).toHaveLength(2);
    expect(incidents.every(item => item.count === 1)).toBe(true);
  });
  test("correlates incidents to the supervisor task id without merging distinct tasks", () => {
    const taskA = "a1234567890bcdef";
    const taskB = "b1234567890bcdef";
    let incidents = aggregateIncident([], { code:"SHELL_FAILED", source:"linux", project:"g7-test", tool:"linux", exitCode:1, taskId:taskA });
    expect(incidents[0].taskId).toBe(taskA);
    incidents = aggregateIncident(incidents, { code:"SHELL_FAILED", source:"linux", project:"g7-test", tool:"linux", exitCode:1, taskId:taskA });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].count).toBe(2);
    incidents = aggregateIncident(incidents, { code:"SHELL_FAILED", source:"linux", project:"g7-test", tool:"linux", exitCode:1, taskId:taskB });
    expect(incidents).toHaveLength(2);
    expect(new Set(incidents.map(item => item.taskId))).toEqual(new Set([taskA, taskB]));
    expect(cleanObservation({ code:"SHELL_FAILED", source:"linux", taskId:"not-a-task" })).not.toHaveProperty("taskId");
    expect(cleanObservation({ code:"SHELL_FAILED", source:"linux", taskId:"A1234567890BCDEF" })).not.toHaveProperty("taskId");
    const correlated = buildIncidentDiagnostics(incidents);
    expect(correlated.incidents.every(item => typeof item.taskId === "string")).toBe(true);
    expect(correlated.summary.taskCorrelated).toBe(2);
    expect(correlated.summary.uncorrelated).toBe(0);
    const uncorrelated = buildIncidentDiagnostics(
      aggregateIncident([], { code:"SHELL_FAILED", source:"linux", project:"g7-other", tool:"linux", exitCode:1 })
    );
    expect(uncorrelated.incidents[0].taskId).toBeNull();
    expect(uncorrelated.summary.uncorrelated).toBe(1);
  });
  test("bounds diagnostics with an explicit summary, priority order and hasMore", () => {
    const base = Date.parse("2026-11-10T12:00:00Z");
    const records: IncidentRecord[] = Array.from({ length: 30 }, (_, index) => {
      const count = index % 4 + 1;
      const taskId = index % 3 === 0 ? index.toString(16).padStart(16, "0") : undefined;
      return {
        id: "SHELL_FAILED:linux:project-" + index + ":linux:1:-:-" + (taskId ?? "-"),
        code: "SHELL_FAILED", source: "linux", project: "project-" + index, tool: "linux", exitCode: 1,
        ...(taskId ? { taskId } : {}), count,
        firstAt: new Date(base).toISOString(), lastAt: new Date(base + index * 60_000).toISOString(),
        suspectedCause: "Comando Linux terminó con error", action: "Examinar exitCode",
        status: count > 2 ? "blocked" : count > 1 ? "repeated" : "open",
        automaticRetryAllowed: false
      };
    });
    const view = buildIncidentDiagnostics(records);
    expect(view.incidents).toHaveLength(DIAGNOSTICS_DEFAULT_LIMIT);
    expect(view.summary).toMatchObject({ total: 30, shown: 20, omitted: 10, hasMore: true,
      taskCorrelated: 10, uncorrelated: 20 });
    expect(view.hasMore).toBe(true);
    expect(view.omitted).toBe(10);
    expect(view.order).toBe(DIAGNOSTICS_ORDER);
    expect(view.summary.byCode.SHELL_FAILED).toBe(30);
    const ranks = view.incidents.map(item => item.status === "blocked" ? 0 : item.status === "repeated" ? 1 : 2);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(view.incidents[0]).toMatchObject({ status: "blocked", project: "project-27" });
    expect(view.incidents.every(item => item.taskId === null || /^[a-f0-9]{16}$/.test(item.taskId))).toBe(true);
    const limited = buildIncidentDiagnostics(records, 5);
    expect(limited.incidents).toHaveLength(5);
    expect(limited.summary).toMatchObject({ total: 30, shown: 5, omitted: 25, hasMore: true });
    expect(buildIncidentDiagnostics(records, Number.NaN).incidents).toHaveLength(DIAGNOSTICS_DEFAULT_LIMIT);
    expect(buildIncidentDiagnostics(records, 999).incidents).toHaveLength(30);
  });
  test("bounds ledger size without dropping the most recent incident", () => {
    let records: ReturnType<typeof aggregateIncident> = [];
    for (let n=0; n<80; n++) {
      records=aggregateIncident(records, {code:"SHELL_FAILED",source:"linux",project:"project-"+n});
    }
    expect(records).toHaveLength(64);
    expect(records[0].project).toBe("project-79");
  });

  test("keeps the legacy six-segment id when an observation has no taskId", () => {
    const legacyId = "SHELL_FAILED:linux:supervised-0123456789abcdef:linux:2:-";
    const historical: IncidentRecord = {
      id: legacyId, code: "SHELL_FAILED", source: "linux",
      project: "supervised-0123456789abcdef", tool: "linux", exitCode: 2, count: 1,
      firstAt: "2026-11-10T12:00:00.000Z", lastAt: "2026-11-10T12:00:00.000Z",
      suspectedCause: "Comando Linux terminó con error", action: "Examinar exitCode",
      status: "open", automaticRetryAllowed: false
    };
    const observation = { code: "SHELL_FAILED", source: "linux",
      project: "supervised-0123456789abcdef", tool: "linux", exitCode: 2 };
    const once = aggregateIncident([historical], observation, new Date("2026-11-10T12:05:00Z"));
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ id: legacyId, count: 2, status: "repeated" });
    const twice = aggregateIncident(once, observation, new Date("2026-11-10T12:06:00Z"));
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ id: legacyId, count: 3, status: "blocked" });
    // An explicit taskId keeps its own seventh segment and never merges with legacy rows.
    const withTask = aggregateIncident([historical], {
      ...observation, taskId: "0123456789abcdef"
    }, new Date("2026-11-10T12:07:00Z"));
    expect(withTask).toHaveLength(2);
    expect(withTask[0].id).toBe(legacyId + ":0123456789abcdef");
    expect(withTask.find(row => row.id === legacyId)?.count).toBe(1);
  });

  test("derives taskId from the deterministic supervised project and keeps an explicit id", () => {
    const derived = "0123456789abcdef";
    const explicit = "fedcba9876543210";
    expect(taskIdFromProject("supervised-" + derived)).toBe(derived);
    expect(taskIdFromProject("supervised-0123456789ABCDEF")).toBeNull();
    expect(taskIdFromProject("g7-test")).toBeNull();
    expect(taskIdFromProject(undefined)).toBeNull();
    const base: IncidentRecord = {
      id: "SHELL_FAILED:linux:supervised-" + derived + ":linux:1:-:-",
      code: "SHELL_FAILED", source: "linux", project: "supervised-" + derived,
      tool: "linux", exitCode: 1, count: 1,
      firstAt: "2026-11-10T12:00:00.000Z", lastAt: "2026-11-10T12:00:00.000Z",
      suspectedCause: "Comando Linux terminó con error", action: "Examinar exitCode",
      status: "open", automaticRetryAllowed: false
    };
    const view = buildIncidentDiagnostics([base]);
    expect(view.incidents[0].taskId).toBe(derived);
    expect(view.summary).toMatchObject({ taskCorrelated: 1, uncorrelated: 0 });
    const explicitView = buildIncidentDiagnostics([{ ...base, taskId: explicit }]);
    expect(explicitView.incidents[0].taskId).toBe(explicit);
    expect(correlateTaskId({ taskId: "not-a-task", project: "supervised-" + derived })).toBe(derived);
    expect(correlateTaskId({ project: "g7-test" })).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  aggregateIncident, cleanObservation, classifyAgentFailure,
  observeLinux, retryDecision
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
  test("bounds ledger size without dropping the most recent incident", () => {
    let records: ReturnType<typeof aggregateIncident> = [];
    for (let n=0; n<80; n++) {
      records=aggregateIncident(records, {code:"SHELL_FAILED",source:"linux",project:"project-"+n});
    }
    expect(records).toHaveLength(64);
    expect(records[0].project).toBe("project-79");
  });
});

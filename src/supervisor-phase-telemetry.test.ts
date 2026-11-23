import { describe, expect, test } from "bun:test";
import {
  createSupervisorPhaseProbe, SUPERVISOR_PHASE_MARKER,
  type SupervisorPhaseEvent
} from "./supervisor-phase-telemetry";

describe("F0-C10/R3 minimal phase telemetry", () => {
  test("emits begin/end with a fixed schema and preserves returned value", async () => {
    const events: SupervisorPhaseEvent[] = [];
    let clock = 123.5;
    const tracer = createSupervisorPhaseProbe({
      probe: "01234567-89ab-4cde-8000-000000000000",
      now: () => clock,
      emit: event => { events.push(event); }
    });
    const result = await tracer.run("create/fork", "create", async () => {
      clock += 19.2;
      return {id: "private-session-id", prompt: "PRIVATE_PROMPT"};
    });
    expect(result.id).toBe("private-session-id");
    expect(events).toEqual([
      {marker: SUPERVISOR_PHASE_MARKER, probe: tracer.probe,
        phase: "create/fork", operation: "create", edge: "begin"},
      {marker: SUPERVISOR_PHASE_MARKER, probe: tracer.probe,
        phase: "create/fork", operation: "create", edge: "end",
        outcome: "ok", durationMs: 19}
    ]);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("private-session-id");
    expect(logged).not.toContain("PRIVATE_PROMPT");
    expect(logged.length).toBeLessThan(440);
  });

  test("failure preserves original error; only error category is logged", async () => {
    const events: SupervisorPhaseEvent[] = [];
    const sensitive = new Error("SECRET_TOKEN_PRIVATE_STACK");
    const tracer = createSupervisorPhaseProbe({
      probe: "deadbeef", now: () => 99, emit: event => { events.push(event); }
    });
    try {
      await tracer.run("submit", "dispatch", async () => { throw sensitive; });
      throw new Error("EXPECTED_THROW");
    } catch(error) {
      expect(error).toBe(sensitive);
    }
    expect(events.map(x => x.edge)).toEqual(["begin", "end"]);
    expect(events[1].outcome).toBe("error");
    expect(JSON.stringify(events)).not.toContain("SECRET_TOKEN_PRIVATE_STACK");
    expect(JSON.stringify(events)).not.toContain("stack");
  });

  test("broken observability emitter cannot alter work", async () => {
    const tracer = createSupervisorPhaseProbe({
      probe: "deadbeef", now: () => NaN, emit: () => { throw new Error("EMITTER_FAILURE"); }
    });
    expect(await tracer.run("setModel", "configure", async () => 17)).toBe(17);
  });

  test("rejects invalid phase/operation without invoking work", async () => {
    let called = false;
    const tracer = createSupervisorPhaseProbe({probe: "deadbeef", emit: () => {}});
    await expect(tracer.run("admit", "notAllowed" as "validate", async () => {
      called = true;
    })).rejects.toThrow("SUPERVISOR_PHASE_OPERATION_INVALID");
    expect(called).toBe(false);
  });

  test("begin marker precedes unresolved work; no fake end", async () => {
    const events: SupervisorPhaseEvent[] = [];
    const tracer = createSupervisorPhaseProbe({probe: "deadbeef", emit: e => {events.push(e);}});
    let release!: (value: string) => void;
    const gate = new Promise<string>(resolve => { release = resolve; });
    const pending = tracer.run("status", "wait", () => gate);
    expect(events.map(x => x.edge)).toEqual(["begin"]);
    release("done");
    expect(await pending).toBe("done");
    expect(events.map(x => x.edge)).toEqual(["begin", "end"]);
  });

  test("long and negative durations are bounded; no user IDs accepted as options", async () => {
    const events: SupervisorPhaseEvent[] = [];
    let clock = 0;
    const tracer = createSupervisorPhaseProbe({
      probe: "abcdef123456", now: () => clock, emit: e => events.push(e)
    });
    await tracer.run("recover", "resumeReceipt", () => { clock = 2_000_000; });
    expect(events[1].durationMs).toBe(600_000);
    await tracer.run("admit", "validate", () => { clock = -1; });
    expect(events[3].durationMs).toBe(0);
    expect(() => createSupervisorPhaseProbe({probe:"request=secret"})).toThrow("SUPERVISOR_PHASE_PROBE_INVALID");
  });
});

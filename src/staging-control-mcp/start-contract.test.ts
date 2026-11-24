import { test } from "bun:test";
import assert from "node:assert/strict";
import { readOnlyStartFields, workflowStartInput } from "./start-contract";

const pins = { mode: "read_only", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40) };
const ordinary = { action: "start", requestId: "0123456789abcdef", repository: "owner/repo", prompt: "Inspect the pinned source" };

test("ordinary start retains its exact legacy shape", () => {
  assert.deepEqual(readOnlyStartFields({}), {});
  const { action: _action, ...expected } = ordinary;
  assert.deepEqual(workflowStartInput(ordinary), expected);
});

test("Workflow forwards immutable pins unchanged including repeated identity", () => {
  const { action: _action, ...expected } = ordinary;
  assert.deepEqual(workflowStartInput({ ...ordinary, ...pins }), { ...expected, ...pins });
  assert.deepEqual(workflowStartInput({ ...ordinary, ...pins }), { ...expected, ...pins });
});

test("pins must be supplied together only in read_only mode", () => {
  for (const input of [{ mode: "read_only" }, { mode: "read_only", sourceCommit: pins.sourceCommit },
    { mode: "read_only", sourceTree: pins.sourceTree }]) {
    assert.throws(() => readOnlyStartFields(input), /SUPERVISOR_SOURCE_PINS_REQUIRED/);
    assert.throws(() => workflowStartInput({ ...ordinary, ...input }), /SUPERVISOR_SOURCE_PINS_REQUIRED/);
  }
  for (const input of [{ sourceCommit: pins.sourceCommit }, { sourceTree: pins.sourceTree },
    { sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree }]) {
    assert.throws(() => readOnlyStartFields(input), /SUPERVISOR_PINS_REQUIRE_READ_ONLY/);
  }
});

test("malformed pins and mode fail closed without coercion", () => {
  for (const value of [null, 42, "", "a".repeat(39), "A".repeat(40), "g".repeat(40), "a".repeat(40) + "\n"]) {
    assert.throws(() => readOnlyStartFields({ ...pins, sourceCommit: value }), /INVALID_SUPERVISOR_SOURCE_PINS/);
    assert.throws(() => readOnlyStartFields({ ...pins, sourceTree: value }), /INVALID_SUPERVISOR_SOURCE_PINS/);
  }
  for (const mode of [null, "", "build", "READ_ONLY", true])
    assert.throws(() => readOnlyStartFields({ ...pins, mode }), /INVALID_SUPERVISOR_MODE/);
});

test("read_only cannot fork; Workflow never allows workspace, fork or model overrides", () => {
  for (const extra of [{ workspace: "custom" }, { sourceSession: "sesAbc" }, { sourceSession: null }])
    assert.throws(() => readOnlyStartFields({ ...pins, ...extra }), /SUPERVISOR_READ_ONLY_FORK_UNSUPPORTED/);
  for (const extra of [{ workspace: "custom" }, { sourceSession: "sesAbc" }, { model: "economy" }, { accepted: true }])
    assert.throws(() => workflowStartInput({ ...ordinary, ...pins, ...extra }), /UNKNOWN_SUPERVISOR_FIELD/);
});

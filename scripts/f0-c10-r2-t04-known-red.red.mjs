// F0-C10/R2-T04 known RED: DO NOT include in bun test or CI green.
// Run explicitly: node --test scripts/f0-c10-r2-t04-known-red.red.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

test("RED: random SDK session IDs orphan after a lost response", () => {
  const sessions = new Set();
  const create = () => { const id = "ses_random_" + (sessions.size + 1); sessions.add(id); return id; };
  create(); // effect committed, reply intentionally lost
  create(); // blind replay
  assert.equal(sessions.size, 1, "one task must not create two sessions");
});

test("RED: stale status update may overwrite a committed cancellation", () => {
  const task = { status: "running", operationId: "op-old" };
  const stale = {...task};
  task.status = "cancel_requested";
  Object.assign(task, {...stale, status: "finished"}); // historical non-transactional put
  assert.equal(task.status, "cancel_requested", "status must not erase cancellation");
});

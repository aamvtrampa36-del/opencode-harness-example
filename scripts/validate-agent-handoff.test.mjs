import { test } from "node:test";
import assert from "node:assert/strict";
import { validateHandoff, findHandoffConflicts } from "./validate-agent-handoff.mjs";

const valid = () => ({
  schema: "agent.handoff.v1",
  task_id: "synthetic-pr-42",
  repository: "example/private-repo",
  branch: "agent/synthetic-pr-42",
  head_sha: "a".repeat(40),
  owner: "review-agent",
  objective: "Verify isolated synthetic PR metadata",
  status: "BLOCKED",
  write_scope: ["docs/review.md"],
  depends_on: ["example/private-repo#12"],
  evidence: [],
  checks: [{name:"real-runtime",status:"not_run"}],
  next_action: "Inspect current CI",
  updated_at: "2026-11-20T00:00:00Z"
});

test("minimal synthetic handoff passes", () => {
  assert.deepEqual(validateHandoff(valid()), []);
});
test("reject malformed root without exception", () => {
  assert.ok(validateHandoff(null).length > 0);
});
test("reject parent path traversal and protected main branch", () => {
  assert.ok(validateHandoff({...valid(),write_scope:["../private"]}).length > 0);
  assert.ok(validateHandoff({...valid(),branch:"main"}).length > 0);
});
test("do not trust shortened SHA", () => {
  assert.ok(validateHandoff({...valid(),head_sha:"deadbeef"}).length > 0);
});
test("fail closed on malformed nested checks", () => {
  assert.ok(validateHandoff({...valid(),status:"COMPLETE_VERIFIED",
    checks:[null],evidence:[{kind:"ci",url:"https://github.com/example/private-repo/actions/runs/1"}]}).length > 0);
});
test("review status requires evidence", () => {
  assert.ok(validateHandoff({...valid(),status:"READY_FOR_REVIEW"}).length > 0);
});
test("complete status requires evidence and all passing checks", () => {
  assert.ok(validateHandoff({...valid(),status:"COMPLETE_VERIFIED",checks:[]}).length > 0);
  assert.ok(validateHandoff({...valid(),status:"COMPLETE_VERIFIED",
    evidence:[{kind:"ci",url:"https://github.com/example/private-repo/actions/runs/1"}],
    checks:[{name:"ci",status:"fail"}]}).length > 0);
  assert.deepEqual(validateHandoff({...valid(),status:"COMPLETE_VERIFIED",
    evidence:[{kind:"ci",url:"https://github.com/example/private-repo/actions/runs/1"}],
    checks:[{name:"ci",status:"pass"}],next_action:""}),[]);
});
test("unverified status must specify the next action", () => {
  assert.ok(validateHandoff({...valid(),next_action:""}).length > 0);
});

test("two independent task branches with disjoint declared scopes do not conflict", () => {
  const a = valid(), b = {...valid(),task_id:"synthetic-next",branch:"agent/synthetic-next",write_scope:["src/foo.ts"]};
  assert.deepEqual(findHandoffConflicts([a,b]), []);
});
test("same branch is a conflict regardless of file separation", () => {
  const a = valid(), b = {...valid(),task_id:"synthetic-next",write_scope:["src/foo.ts"]};
  assert.deepEqual(findHandoffConflicts([a,b])[0].reasons, ["SHARED_BRANCH"]);
});
test("same write target conflicts across separate branches", () => {
  const a = valid(), b = {...valid(),task_id:"synthetic-next",branch:"agent/synthetic-next"};
  assert.deepEqual(findHandoffConflicts([a,b])[0].reasons, ["OVERLAPPING_WRITE_SCOPE"]);
});
test("directory ownership conflicts only at path-component boundaries", () => {
  const a = {...valid(),write_scope:["src/"]};
  const b = {...valid(),task_id:"synthetic-next",branch:"agent/synthetic-next",write_scope:["src/module.ts"]};
  const c = {...valid(),task_id:"synthetic-third",branch:"agent/synthetic-third",write_scope:["src2/module.ts"]};
  assert.deepEqual(findHandoffConflicts([a,b])[0].overlapping, ["src/ <> src/module.ts"]);
  assert.deepEqual(findHandoffConflicts([a,c]), []);
});
test("independent repositories do not share ownership", () => {
  const a = valid(), b = {...valid(),task_id:"synthetic-next",repository:"another/repo"};
  assert.deepEqual(findHandoffConflicts([a,b]), []);
});
test("conflict scan rejects malformed handoffs rather than falsely clearing them", () => {
  assert.throws(() => findHandoffConflicts([valid(), {...valid(),write_scope:["../secret"]}]), /Invalid handoff/);
});
test("duplicate task ids are flagged even if branch names differ", () => {
  const a = valid(), b = {...valid(),branch:"agent/second",write_scope:["src/foo.ts"]};
  assert.deepEqual(findHandoffConflicts([a,b])[0].reasons, ["DUPLICATE_TASK_ID"]);
});

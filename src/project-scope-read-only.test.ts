import { expect, test } from "bun:test";
import { assertScopedTool, requireSameScope, validateProjectScope } from "./project-scope";
import { bindReadOnlyScope, type ReadOnlyAuthority } from "./read-only-policy";
const a: ReadOnlyAuthority = { mode:"read_only", object:"opencode-supervisor-v1", session:"ses_root",
  task:"a".repeat(16), project:"task-root", repository:"aamvtrampa36-del/opencode-harness-example",
  sourceCommit:"b".repeat(40), sourceTree:"c".repeat(40) };
const scope = bindReadOnlyScope(undefined,a);
test("client metadata cannot mint, downgrade or replace durable read_only", () => {
  const requested = validateProjectScope({project:a.project,repository:a.repository,readOnly:a},[a.repository]);
  expect(requested.readOnly).toBeUndefined();
  expect(requireSameScope(scope,requested)).toEqual(scope);
  expect(()=>requireSameScope(undefined,scope)).toThrow("READ_ONLY_DENIED");
  expect(()=>requireSameScope(scope,{...scope,readOnly:{...a,session:"ses_child"}})).toThrow("READ_ONLY_DENIED");
});
test("scope guard rejects missing operations and mutations, even for matching repository", () => {
  for (const operation of [undefined,"branch","write","review","pr","unknown"]) {
    expect(()=>assertScopedTool(scope,{kind:"github",repo:a.repository,operation})).toThrow("READ_ONLY_DENIED");
  }
  expect(()=>assertScopedTool(scope,{kind:"github",repo:a.repository,operation:"read",ref:a.sourceCommit})).not.toThrow();
  expect(()=>assertScopedTool(scope,{kind:"github",repo:a.repository,operation:"read",ref:"main"})).toThrow("READ_ONLY_DENIED");
});
test("scope guard distinguishes local inspect from unproved execution and retains legacy semantics", () => {
  expect(()=>assertScopedTool(scope,{kind:"linux",project:a.project})).toThrow("READ_ONLY_DENIED");
  expect(()=>assertScopedTool(scope,{kind:"linux",project:a.project,operation:"inspect"})).not.toThrow();
  expect(()=>assertScopedTool(scope,{kind:"linux",project:"other",operation:"inspect"})).toThrow("READ_ONLY_DENIED");
  expect(()=>assertScopedTool({project:a.project,repository:a.repository},{kind:"github",repo:a.repository,operation:"write"})).not.toThrow();
});

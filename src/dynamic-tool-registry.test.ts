import { describe, expect, test } from "bun:test";
import {
  DynamicToolRegistry, catalogScope, sameJson, sourceSha256,
  validateDynamicToolSource, type DynamicToolEntry
} from "./dynamic-tool-registry";
import type { Workspace } from "@cloudflare/computer";
import { workspacePlugin } from "./workspace";

class MemoryStore {
  rows = new Map<string, unknown>();
  async get<T>(key: string) { return this.rows.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.rows.set(key, value); }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
  }
}
const code = "export default (input) => ({ count: input.values.length, ok: true })";
const samples = [
  { input: { values: [1, 2] }, expected: { ok: true, count: 2 } },
  { input: { values: [] }, expected: { count: 0, ok: true } }
];
const run = async (_code: string, input: any) => ({ count: input.values.length, ok: true });

describe("Project-scoped Dynamic Worker tool catalogue", () => {
  test("source contract and structured JSON comparison", async () => {
    expect(catalogScope("cdf-cloud-engine")).toBe("cdf-cloud-engine");
    expect(() => catalogScope("../other")).toThrow("INVALID_DYNAMIC_TOOL_SCOPE");
    expect(() => validateDynamicToolSource("export default (x) => fetch(x)"))
      .toThrow("DYNAMIC_TOOL_UNSAFE_SOURCE");
    expect(() => validateDynamicToolSource("import { call } from 'codemode:mcp'; export default () => call()"))
      .toThrow("DYNAMIC_TOOL_UNSAFE_SOURCE");
    expect(() => validateDynamicToolSource("export default input => input")).not.toThrow();
    expect(sameJson({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect((await sourceSha256(code)).length).toBe(64);
  });

  test("requires distinct tests, isolates project namespaces and rejects conflicting versions", async () => {
    const storage = new MemoryStore();
    const registry = new DynamicToolRegistry(storage);
    await expect(registry.propose("one", "json-check", code, [samples[0]]))
      .rejects.toThrow("DYNAMIC_TOOL_TESTS_REQUIRED");
    await expect(registry.propose("one", "json-check", code, [samples[0], samples[0]]))
      .rejects.toThrow("DUPLICATE_DYNAMIC_TOOL_TEST");
    const candidate = await registry.propose("one", "json-check", code, samples);
    expect(candidate.status).toBe("CANDIDATE");
    expect((await registry.list("two")).length).toBe(0);
    await expect(registry.inspect("two", "json-check")).rejects.toThrow("DYNAMIC_TOOL_NOT_FOUND");
    await expect(registry.propose("one", "json-check", "export default () => ({})", samples))
      .rejects.toThrow("DYNAMIC_TOOL_VERSION_CONFLICT");
    expect((await registry.inspect("one", "json-check")).tests).toHaveLength(2);
  });

  test("fails closed until all cases pass, then activation permits reuse", async () => {
    const registry = new DynamicToolRegistry(new MemoryStore());
    await registry.propose("cdf", "json-check", code, samples, [
      "https://developers.cloudflare.com/dynamic-workers/"
    ]);
    await expect(registry.activate("cdf", "json-check"))
      .rejects.toThrow("DYNAMIC_TOOL_NOT_VERIFIED");
    await expect(registry.run("cdf", "json-check", samples[0].input, run))
      .rejects.toThrow("DYNAMIC_TOOL_NOT_ACTIVE");
    const failed = await registry.verify("cdf", "json-check", async () => ({ nope: true }));
    expect(failed.status).toBe("TESTED");
    expect(failed.passed).toBe(false);
    expect(failed.failures).toEqual(["CASE_0_MISMATCH", "CASE_1_MISMATCH"]);
    const verified = await registry.verify("cdf", "json-check", run);
    expect(verified.status).toBe("VERIFIED");
    expect(verified.passed).toBe(true);
    await registry.activate("cdf", "json-check");
    const ran = await registry.run("cdf", "json-check", samples[0].input, run);
    expect(ran.result).toEqual({ count: 2, ok: true });
    expect((await registry.list("cdf"))[0].runs).toBe(1);
    await registry.deactivate("cdf", "json-check");
    await expect(registry.run("cdf", "json-check", samples[0].input, run))
      .rejects.toThrow("DYNAMIC_TOOL_NOT_ACTIVE");
  });

  test("code-execution errors do not promote, and no input or result over limit is accepted", async () => {
    const registry = new DynamicToolRegistry(new MemoryStore());
    await registry.propose("cdf", "json-check", code, samples);
    const outcome = await registry.verify("cdf", "json-check", async () => { throw Error("failure"); });
    expect(outcome.passed).toBe(false);
    expect(outcome.failures).toEqual(["CASE_0_EXECUTION_ERROR", "CASE_1_EXECUTION_ERROR"]);
    await expect(registry.propose("cdf", "another", code, [
      { input: { huge: "x".repeat(40000) }, expected: 1 }, samples[0]
    ])).rejects.toThrow("DYNAMIC_TOOL_JSON_LIMIT");
  });
});

describe("OpenCode plugin integrates catalogue with isolated Dynamic Worker backend", () => {
  test("runs only in pure-tools, scopes records by selected project, blocks plan mutations", async () => {
    const storage = new MemoryStore();
    const registry = new DynamicToolRegistry(storage);
    let usedBackend = "";
    const ws = {
      runtime: {
        backends: () => [
          { id: "codemode", callable: true, description: "shared" },
          { id: "dynamic-mcp", callable: true, description: "remote" },
          { id: "pure-tools", callable: true, description: "pure" }
        ],
        exec: async (_source: string, options: { backend: string; input: any }) => {
          usedBackend = options.backend;
          return {
            async *[Symbol.asyncIterator]() {
              yield { name: "exit", code: 0,
                result: { count: options.input.values.length, ok: true } };
            }
          };
        }
      }
    } as unknown as Workspace;
    const available = new Map<string, any>();
    const plugin = workspacePlugin(
      ws, {}, undefined, undefined, undefined, undefined,
      async () => "cdf-cloud-engine", undefined, undefined, undefined, registry
    );
    await plugin.setup({
      agent: { transform: async () => undefined },
      tool: { transform: async (cb: (editor: any) => unknown) => cb({
        remove: () => undefined,
        add: (spec: any) => available.set(spec.name, spec)
      }) }
    } as any);
    const t = available.get("dynamic_tool");
    expect(t).toBeDefined();
    const ctx = { sessionID: "ses_project", agent: "build" };
    const propose = await t.execute({
      action: "propose", id: "json-check", source: code, tests: samples
    }, ctx);
    expect(JSON.parse(propose.content).status).toBe("CANDIDATE");
    await expect(t.execute({ action: "verify", id: "json-check" },
      { ...ctx, agent: "plan" })).rejects.toThrow("Planificación");
    const verified = await t.execute({ action: "verify", id: "json-check" }, ctx);
    expect(JSON.parse(verified.content).passed).toBe(true);
    expect(usedBackend).toBe("pure-tools");
    await t.execute({ action: "activate", id: "json-check" }, ctx);
    const result = await t.execute({ action: "run", id: "json-check", value: samples[0].input }, ctx);
    expect(JSON.parse(result.content).result).toEqual({ count: 2, ok: true });
    expect((await registry.list("unscoped"))).toHaveLength(0);
  });
});

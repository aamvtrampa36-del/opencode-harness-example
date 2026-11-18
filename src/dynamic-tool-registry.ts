/** Versioned, project-scoped catalogue of pure JavaScript for isolated Dynamic Workers.
 * This is NOT a security sandbox: the pure-tools CodemodeBackend enforces egress,
 * capability and resource boundaries. Registry validation is defence in depth.
 */
export type DynamicToolStatus = "CANDIDATE" | "TESTED" | "VERIFIED" | "ACTIVE" | "DEPRECATED";
export type DynamicToolCase = { input: unknown; expected: unknown };
export type DynamicToolEntry = {
  id: string;
  project: string;
  source: string;
  sha256: string;
  status: DynamicToolStatus;
  tests: DynamicToolCase[];
  documentation: string[];
  createdAt: string;
  verifiedAt?: string;
  lastRunAt?: string;
  runs: number;
  lastDurationMs?: number;
  error?: string;
};
export type RegistryStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};
export type ToolExecutor = (source: string, input: unknown) => Promise<unknown>;

const PREFIX = "dynamic-tools:v1:";
const MAX_ENTRIES = 24;
const MAX_SOURCE_BYTES = 16_000;
const MAX_JSON_BYTES = 32_000;
const MAX_CASES = 8;
const MAX_DOCS = 8;
const IDENTIFIER = /^[a-z][a-z0-9-]{1,39}$/;

/** Scope comes from the trusted session binding, NEVER agent supplied arguments. */
export function catalogScope(project: string): string {
  if (project === "") return "unscoped";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(project)) {
    throw new Error("INVALID_DYNAMIC_TOOL_SCOPE");
  }
  return project;
}
function key(scope: string, id: string) {
  return PREFIX + scope + ":" + id;
}
function json(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined || new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new Error("DYNAMIC_TOOL_JSON_LIMIT");
  }
  return text;
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)])
  );
  return value;
}
export function sameJson(left: unknown, right: unknown): boolean {
  return json(normalize(left)) === json(normalize(right));
}
export function validateDynamicToolSource(source: unknown): asserts source is string {
  if (typeof source !== "string" || !source.trim() || new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new Error("INVALID_DYNAMIC_TOOL_SOURCE");
  }
  if (!/\bexport\s+default\b/.test(source)) throw new Error("DYNAMIC_TOOL_DEFAULT_EXPORT_REQUIRED");
  // The backend, not this lexical guard, enforces isolation. No remote capabilities
  // are ever added to the pure-tools backend.
  if (/\b(import|require|fetch|WebSocket|EventSource|eval|Function|WebAssembly|globalThis|process|navigator|Deno|Bun)\b/.test(source)) {
    throw new Error("DYNAMIC_TOOL_UNSAFE_SOURCE");
  }
}
function validateTests(tests: unknown): asserts tests is DynamicToolCase[] {
  if (!Array.isArray(tests) || tests.length < 2 || tests.length > MAX_CASES) {
    throw new Error("DYNAMIC_TOOL_TESTS_REQUIRED");
  }
  const inputs = new Set<string>();
  for (const test of tests) {
    if (!test || typeof test !== "object" || Array.isArray(test) ||
        !Object.hasOwn(test, "input") || !Object.hasOwn(test, "expected")) {
      throw new Error("INVALID_DYNAMIC_TOOL_TEST");
    }
    const signature = json(test.input);
    json(test.expected);
    if (inputs.has(signature)) throw new Error("DUPLICATE_DYNAMIC_TOOL_TEST");
    inputs.add(signature);
  }
}
export async function sourceSha256(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
}
function safeSummary(entry: DynamicToolEntry) {
  // Never return entire source or synthetic test fixtures on catalog listing.
  const { source: _source, tests: _tests, ...summary } = entry;
  return { ...summary, testsCount: entry.tests.length };
}
export class DynamicToolRegistry {
  constructor(private readonly storage: RegistryStorage) {}

  async list(project: string) {
    const scope = catalogScope(project);
    const rows = await this.storage.list<DynamicToolEntry>({ prefix: PREFIX + scope + ":" });
    return [...rows.values()].map(safeSummary).sort((a, b) => a.id.localeCompare(b.id));
  }

  async inspect(project: string, id: string) {
    const row = await this.lookup(project, id);
    return { ...safeSummary(row), source: row.source, tests: row.tests };
  }

  private async lookup(project: string, id: string): Promise<DynamicToolEntry> {
    if (!IDENTIFIER.test(id)) throw new Error("INVALID_DYNAMIC_TOOL_ID");
    const row = await this.storage.get<DynamicToolEntry>(key(catalogScope(project), id));
    if (!row) throw new Error("DYNAMIC_TOOL_NOT_FOUND");
    return row;
  }

  async propose(project: string, id: string, source: string, tests: DynamicToolCase[],
                documentation: string[] = []) {
    const scope = catalogScope(project);
    if (!IDENTIFIER.test(id)) throw new Error("INVALID_DYNAMIC_TOOL_ID");
    validateDynamicToolSource(source);
    validateTests(tests);
    if (!Array.isArray(documentation) || documentation.length > MAX_DOCS ||
        documentation.some(d => typeof d !== "string" || d.length > 500 || !/^https:\/\//.test(d))) {
      throw new Error("INVALID_DYNAMIC_TOOL_DOCUMENTATION");
    }
    const existing = await this.storage.get<DynamicToolEntry>(key(scope, id));
    const sha256 = await sourceSha256(source);
    if (existing) {
      if (existing.sha256 !== sha256) throw new Error("DYNAMIC_TOOL_VERSION_CONFLICT");
      return safeSummary(existing);
    }
    const count = (await this.list(scope)).length;
    if (count >= MAX_ENTRIES) throw new Error("DYNAMIC_TOOL_CATALOG_LIMIT");
    const entry: DynamicToolEntry = {
      id, project: scope, source, sha256, tests, documentation,
      status: "CANDIDATE", createdAt: new Date().toISOString(), runs: 0
    };
    await this.storage.put(key(scope, id), entry);
    return safeSummary(entry);
  }

  async verify(project: string, id: string, execute: ToolExecutor) {
    const row = await this.lookup(project, id);
    if (row.status === "DEPRECATED") throw new Error("DYNAMIC_TOOL_DEPRECATED");
    // Tests may be supplied by the proposing agent: VERIFIED only means these
    // particular test cases passed, not independent audit or production approval.
    const failures: string[] = [];
    for (let index = 0; index < row.tests.length; index++) {
      const test = row.tests[index];
      try {
        const observed = await execute(row.source, test.input);
        if (!sameJson(observed, test.expected)) failures.push("CASE_" + index + "_MISMATCH");
      } catch {
        failures.push("CASE_" + index + "_EXECUTION_ERROR");
      }
    }
    // Re-read to prevent promoting a deprecated or replaced record after a slow test.
    const current = await this.lookup(project, id);
    if (current.sha256 !== row.sha256 || current.status === "DEPRECATED") {
      throw new Error("DYNAMIC_TOOL_CHANGED_DURING_VERIFICATION");
    }
    const ok = failures.length === 0;
    const updated: DynamicToolEntry = {
      ...current, status: ok ? "VERIFIED" : "TESTED",
      verifiedAt: ok ? new Date().toISOString() : undefined,
      error: ok ? undefined : failures.join(",")
    };
    await this.storage.put(key(catalogScope(project), id), updated);
    return { ...safeSummary(updated), passed: ok, failures };
  }

  async activate(project: string, id: string) {
    const row = await this.lookup(project, id);
    if (row.status !== "VERIFIED" && row.status !== "ACTIVE") throw new Error("DYNAMIC_TOOL_NOT_VERIFIED");
    const updated = { ...row, status: "ACTIVE" as const };
    await this.storage.put(key(catalogScope(project), id), updated);
    return safeSummary(updated);
  }

  async deactivate(project: string, id: string) {
    const row = await this.lookup(project, id);
    const updated = { ...row, status: "DEPRECATED" as const };
    await this.storage.put(key(catalogScope(project), id), updated);
    return safeSummary(updated);
  }

  async run(project: string, id: string, input: unknown, execute: ToolExecutor) {
    json(input);
    const row = await this.lookup(project, id);
    if (row.status !== "ACTIVE") throw new Error("DYNAMIC_TOOL_NOT_ACTIVE");
    const started = Date.now();
    const result = await execute(row.source, input);
    json(result);
    // Avoid resurrecting a revoked record after a concurrent run.
    const current = await this.lookup(project, id);
    if (current.sha256 === row.sha256 && current.status === "ACTIVE") {
      await this.storage.put(key(catalogScope(project), id), {
        ...current, runs: current.runs + 1, lastRunAt: new Date().toISOString(),
        lastDurationMs: Date.now() - started
      });
    }
    return { result, sha256: row.sha256, durationMs: Date.now() - started };
  }
}

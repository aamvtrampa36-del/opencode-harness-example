import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * C05/T07: execute the actual OpenCodeAgent method bodies and GitHub runner
 * from server.ts, with storage, HTTP, container and native SDK boundaries
 * replaced by explicit offline doubles. No replacement of the control flow.
 * Not a workerd/DO/SDK end-to-end test: constructors, RPC transport, alarms
 * and physical persistence are outside this harness. Never import live env.
 */
const REPO = "aamvtrampa36-del/opencode-harness-example";
const ID = "c050700000000001";
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const SESSION = "ses_r2_" + ID;
const OP = "rc-start-" + ID;
const KEY = "supervisor:task:" + ID;
const request = {requestId: ID, repository: REPO, prompt: "Inspect the pinned source only", model: "economy", mode: "read_only", sourceCommit: COMMIT, sourceTree: TREE};

type Event = {kind: string; args: any[]};
type Trace = Event[];
type Fault = "missing" | "wrong-tree" | "import-fail" | "bad-receipt" | "wrong-session" | "lost-create" | "lost-submit" | "pause-import" | "pause-submit";
function signal() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise, release};
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(Error("T07_BOUNDARY_TIMEOUT")), 1500);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// Copy-on-write transactions, serialized; only committed writes are logged.
class MemoryStorage {
  rows = new Map<string, any>();
  tail: Promise<void> = Promise.resolve();
  constructor(private readonly events: Trace) {}
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.rows.get(key));
  }
  async put(key: string, value: unknown) {
    if (key === KEY && !this.rows.has(key)) this.events.push({kind:"reserve", args:[key]});
    if (key === "supervisor:admission:v1") {
      const old = this.rows.get(key)?.slots?.[ID];
      const next = (value as any)?.slots?.[ID];
      if (next && !old) this.events.push({kind:"slot-reserve",args:[ID,next.generation]});
      else if (next && old && (next.generation !== old.generation || next.token !== old.token))
        this.events.push({kind:"slot-transfer",args:[ID,next.generation]});
    }
    this.rows.set(key, structuredClone(value));
  }
  async delete(key: string) { return this.rows.delete(key); }
  async list<T>(options: {prefix?: string; limit?: number} = {}) {
    return new Map<string,T>([...this.rows.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ""))
      .sort(([a],[b]) => a.localeCompare(b)).slice(0, options.limit ?? Infinity)
      .map(([key,value]) => [key, structuredClone(value)] as [string,T]));
  }
  async transaction<T>(fn: (tx: MemoryStorage) => Promise<T>): Promise<T> {
    const before = this.tail, latch = signal();
    this.tail = latch.promise;
    await before;
    const staged: Trace = [];
    const tx = new MemoryStorage(staged);
    tx.rows = new Map(structuredClone([...this.rows]));
    try {
      const result = await fn(tx);
      this.rows = tx.rows;
      this.events.push(...staged);
      return result;
    } finally { latch.release(); }
  }
}

async function loadServerClass(fakeFetch: typeof fetch) {
  const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true);
  const klass = ast.statements.find((n): n is ts.ClassDeclaration =>
    ts.isClassDeclaration(n) && n.name?.text === "OpenCodeAgent");
  if (!klass) throw Error("T07_SERVER_CLASS_NOT_FOUND");
  // Only the Worker/platform constructor and unrelated field initializers are
  // removed. Every method (including future helper methods) is copied verbatim.
  // Keep the real GitHub runner to exercise the real bridge against fake HTTP.
  const members = klass.members.filter(m => ts.isMethodDeclaration(m) ||
    (ts.isPropertyDeclaration(m) && m.name.getText(ast) === "githubRunner"));
  if (!members.some(m => m.name?.getText(ast) === "githubRunner"))
    throw Error("T07_GITHUB_RUNNER_CONTRACT_CHANGED");
  const bindings: Record<string, unknown> = {
    globalThis: Object.create(globalThis, {fetch: {value: fakeFetch}}),
    fetch: fakeFetch
  };
  // Load the real pure modules that implement the server's relevant contracts.
  // An unbound future import is an explicit integration failure, never a mock.
  const safe = /^\.\/(?:supervisor-[\w-]+|github(?:-[\w-]+)?|project-scope|project-container|model-presets|g9-selfdev|openrouter-catalog|repository-import-scope|read-only-policy|read-only-[\w-]+)$/;
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const name = statement.moduleSpecifier.text;
    const named = statement.importClause?.namedBindings;
    if (!safe.test(name) || !named || !ts.isNamedImports(named) || statement.importClause?.isTypeOnly) continue;
    const mod = await import(name);
    for (const binding of named.elements) {
      if (binding.isTypeOnly) continue;
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (!(imported in mod)) throw Error("T07_MISSING_IMPORT:" + name + ":" + imported);
      bindings[binding.name.text] = mod[imported];
    }
  }
  const code = "class OpenCodeAgent {\n" + members.map(m => m.getText(ast)).join("\n") + "\n}";
  const compiled = ts.transpileModule(code, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
    reportDiagnostics: true
  });
  if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error))
    throw Error("T07_SERVER_PROJECTION_TRANSPILE_ERROR");
  return new Function(...Object.keys(bindings), compiled.outputText + "\nreturn OpenCodeAgent;")(...Object.values(bindings));
}

async function fixture(fault?: Fault) {
  const events: Trace = [], storage = new MemoryStorage(events);
  const entered = signal(), release = signal();
  const native = new Map<string, {id:string; parent?:string}>();
  const accepted = new Map<string, string>();
  let lostCreate = fault === "lost-create", lostSubmit = fault === "lost-submit";
  let interrupted = false;
  const log = (kind: string, ...args: any[]) => events.push({kind,args});
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status,headers:{"content-type":"application/json"}});
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    log("http", method, url.pathname);
    if (url.hostname !== "api.github.com" || method !== "GET") throw Error("T07_EXTERNAL_EFFECT_FORBIDDEN");
    const base = "/repos/" + REPO;
    if (url.pathname === base) return json({full_name:REPO, default_branch:"main"});
    if (url.pathname === base + "/commits/" + COMMIT) {
      if (fault === "missing") return json({message:"Not Found"},404);
      return json({sha:COMMIT, commit:{tree:{sha:fault === "wrong-tree" ? "c".repeat(40) : TREE}}});
    }
    throw Error("T07_UNEXPECTED_HTTP:" + url.pathname);
  }) as typeof fetch;
  const Agent = await loadServerClass(fakeFetch);
  const personalConfig = {
    getAllowedRepositories: async () => [REPO],
    getGitHubKey: async () => "offline-fixture-not-a-real-token",
    getOpenRouterKey: async () => undefined
  };
  const handle = (id: string) => ({
    id,
    setAgent: async (name: string) => { log("agent",id,name); },
    setModel: async (model: unknown) => { log("model",id,model); },
    submit: async (_prompt: string, options?: {operationId?: string}) => {
      const op = options?.operationId ?? "unkeyed-child";
      log("submit",id,op);
      if (!accepted.has(op)) { accepted.set(op,id); log("accepted",id,op); }
      if (fault === "pause-submit") { entered.release(); await bounded(release.promise); }
      if (lostSubmit) { lostSubmit = false; throw Error("T07_LOST_SUBMIT_RESPONSE"); }
      return {accepted:true};
    },
    busy: async () => false,
    wait: async (op: string) => {
      log("wait",id,op);
      return accepted.get(op) === id
        ? interrupted ? {status:"unanswered",reason:"interrupted"} : {status:"done"}
        : {status:"unanswered",reason:"not_found"};
    },
    abort: async (op: string) => { log("abort",id,op); interrupted = true; return true; },
    log: async function* () {},
    history: async () => []
  });
  const harness = {
    create: async ({id}: {id:string}) => {
      log("create",id);
      const actual = fault === "wrong-session" ? "ses_wrong" : id;
      native.set(actual,{id:actual});
      if (lostCreate) { lostCreate = false; throw Error("T07_LOST_CREATE_RESPONSE"); }
      return actual;
    },
    session: handle,
    use: async (fn: any) => fn({sessions:{get:async ({sessionID}:any) => {
      log("lookup",sessionID); return native.get(sessionID);
    }}}),
    sessions: {
      list: async () => [...native.values()],
      fork: async (parent: string) => {
        log("fork",parent);
        const child = "ses_t07_child";
        native.set(child,{id:child,parent}); return handle(child);
      },
      create: async () => { log("legacy-create"); return handle("ses_random"); }
    }
  };
  const dev = {
    reserveIsolatedProject: async (...args:any[]) => { log("project",...args); },
    prepareRepository: async (project:string, repository:string, commit:string, tree:string) => {
      log("import",project,repository,commit,tree);
      if (fault === "pause-import") { entered.release(); await bounded(release.promise); }
      if (fault === "import-fail") throw Error("T07_IMPORT_FAILURE");
      const receipt = {project,repository,commit,tree:fault === "bad-receipt" ? "c".repeat(40) : tree,files:1,sha256:"d".repeat(64)};
      if (tree === TREE && commit === COMMIT && receipt.tree === TREE) log("verified",project,repository,commit,tree);
      return receipt;
    }
  };
  function newAgent() {
    const work: Promise<unknown>[] = [];
    const agent = new Agent();
    Object.assign(agent,{
      ctx:{storage,id:{name:"opencode-supervisor-v1"},waitUntil:(p:Promise<unknown>) => {
        work.push(p); p.catch(()=>{});
      }},
      env:{OPENCODE_SUPERVISOR_ENABLED:"true",DEV:{getByName:()=>dev}},
      personalConfig,harness
    });
    // Spy only; do not substitute the GitHub resolver/branch implementation.
    const runner = agent.githubRunner;
    const branch = runner.ensureSupervisorBranch;
    runner.ensureSupervisorBranch = (...args:any[]) => {log("branch",...args); return branch(...args);};
    return {agent, drain:async () => {
      for(let i=0;i<work.length;i++) await bounded(work[i]);
    }};
  }
  const count = (kind:string) => events.filter(e=>e.kind===kind).length;
  const calls = (kind:string) => events.filter(e=>e.kind===kind).map(e=>e.args);
  const record = () => storage.get<any>(KEY);
  return {newAgent,events,storage,entered,release,accepted,native,count,calls,record};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function noDispatch(f:Fixture) {
  for(const k of ["branch","agent","model","submit","accepted"]) expect(f.count(k)).toBe(0);
  expect(f.calls("http").every(a=>a[0]==="GET")).toBe(true);
}
async function launch(f:Fixture) {
  const a = f.newAgent();
  const receipt = await bounded(a.agent.startSupervisedTask(request));
  await a.drain();
  return { ...a, receipt };
}
function successful(f:Fixture) {
  expect(f.count("reserve")).toBe(1);
  expect(f.calls("slot-reserve")).toEqual([[ID,1]]);
  expect(f.calls("create")).toEqual([[SESSION]]);
  expect(f.count("legacy-create")).toBe(0);
  expect(f.count("branch")).toBe(0);
  expect(f.calls("accepted")).toEqual([[SESSION,OP]]);
  expect(f.calls("submit")).toEqual([[SESSION,OP]]);
  expect(f.calls("import").length).toBeGreaterThanOrEqual(1);
  for (const args of f.calls("import")) expect(args).toEqual(["supervised-"+ID,REPO,COMMIT,TREE]);
  const ix = f.events.findIndex(e=>e.kind==="verified");
  expect(ix).toBeGreaterThanOrEqual(0);
  for (const kind of ["agent","model","submit"]) {
    const index = f.events.findIndex(e=>e.kind===kind);
    expect(index).toBeGreaterThan(ix);
  }
}
async function rejectOrTerminal(f:Fixture, requiredEvent:string) {
  const a=f.newAgent();
  // Invalid upstream source may reject the RPC or durably fail the async start.
  try { await bounded(a.agent.startSupervisedTask(request)); }
  catch(e) { if (e instanceof ReferenceError || e instanceof TypeError || String(e).includes("T07_BOUNDARY_TIMEOUT")) throw e; }
  await a.drain();
  expect(f.count(requiredEvent)).toBeGreaterThan(0);
  noDispatch(f);
  const row=await f.record();
  expect(row?.status).not.toBe("running");
  expect(row?.status).not.toBe("finished");
}

describe("C05/T07 real server method contract (offline; RED until combined)", () => {
  test("pinned source is imported before configuration/submit; no branch; one reservation/session/submit", async () => {
    const f=await fixture(); await launch(f); successful(f);
    expect(await f.record()).toMatchObject({baseCommit:COMMIT,sourceTree:TREE,session:SESSION,operationId:OP});
    expect(f.calls("http")).toContainEqual(["GET","/repos/"+REPO+"/commits/"+COMMIT]);
  });
  test("missing commit is queried and fails before model setup", async () => {
    const f=await fixture("missing"); await rejectOrTerminal(f,"http");
    expect(f.calls("http")).toContainEqual(["GET","/repos/"+REPO+"/commits/"+COMMIT]);
    expect(f.count("create")).toBe(0); expect(f.count("import")).toBe(0);
  });
  test("wrong GitHub tree fails before model setup", async () => {
    const f=await fixture("wrong-tree"); await rejectOrTerminal(f,"http");
    expect(f.calls("http")).toContainEqual(["GET","/repos/"+REPO+"/commits/"+COMMIT]);
    expect(f.count("create")).toBe(0); expect(f.count("import")).toBe(0);
  });
  test("container import failure never reaches model or submit", async () => {
    const f=await fixture("import-fail"); await rejectOrTerminal(f,"import");
    expect(f.calls("import")[0]).toEqual(["supervised-"+ID,REPO,COMMIT,TREE]);
  });
  test("mismatched import receipt cannot become verified", async () => {
    const f=await fixture("bad-receipt"); await rejectOrTerminal(f,"import");
    expect(f.count("verified")).toBe(0);
  });
  test("wrong native session ID cannot reach model or submit", async () => {
    const f=await fixture("wrong-session"); await rejectOrTerminal(f,"create");
    expect(f.calls("create")).toEqual([[SESSION]]);
    expect((await f.record())?.session).not.toBe("ses_wrong");
  });
  test("same requestId with changed pins cannot reserve or submit again", async () => {
    const f=await fixture(); const a=await launch(f); successful(f);
    const before=f.events.length;
    await expect(a.agent.startSupervisedTask({...request,sourceTree:"c".repeat(40)})).rejects.toThrow();
    await expect(a.agent.startSupervisedTask({...request,sourceCommit:"e".repeat(40)})).rejects.toThrow();
    await a.drain(); expect(f.events.slice(before).filter(e=>["reserve","slot-reserve","create","import","model","submit","accepted","branch"].includes(e.kind))).toEqual([]);
    successful(f);
  });
  test("concurrent same requestId while import is blocked has no early or duplicate dispatch", async () => {
    const f=await fixture("pause-import"); const a=f.newAgent();
    const start:Promise<unknown>=a.agent.startSupervisedTask(request);
    void start.catch(()=>{});
    try {
      await bounded(f.entered.promise); noDispatch(f);
      const again:Promise<unknown>=a.agent.startSupervisedTask(request);
      void again.catch(()=>{});
      f.release.release();
      await bounded(Promise.all([start,again])); await a.drain();
      successful(f);
    } finally { f.release.release(); await start.catch(()=>{}); }
  });
  test("cancel during import cannot report cancelled then submit; intent fences dispatch", async () => {
    const f=await fixture("pause-import"); const a=f.newAgent();
    const start:Promise<unknown>=a.agent.startSupervisedTask(request);
    void start.catch(()=>{});
    try {
      await bounded(f.entered.promise); noDispatch(f);
      const cancel=await bounded<any>(a.agent.cancelSupervisedTask(ID));
      const during=await f.record();
      f.release.release(); await bounded(start); await a.drain();
      // A confirmed terminal or durable cancel intent cannot be overwritten.
      if (cancel.confirmed || ["cancelled","cancel_requested"].includes(during?.status)) {
        expect(f.count("accepted")).toBe(0);
        expect((await f.record())?.status).not.toBe("running");
      } else {
        // Unconfirmed cancellation must say so, not advertise a false success.
        expect(cancel.confirmed).not.toBe(true);
        expect(cancel.status).not.toBe("cancelled");
      }
      expect(f.count("reserve")).toBe(1); expect(f.count("branch")).toBe(0);
      expect(f.count("accepted")).toBeLessThanOrEqual(1);
    } finally { f.release.release(); await start.catch(()=>{}); }
  });
  test("late submit response cannot roll back concurrent cancellation", async () => {
    const f=await fixture("pause-submit"); const a=f.newAgent();
    const start:Promise<unknown>=a.agent.startSupervisedTask(request);
    void start.catch(()=>{});
    try {
      await bounded(f.entered.promise);
      expect(f.calls("accepted")).toEqual([[SESSION,OP]]);
      const cancel=await bounded<any>(a.agent.cancelSupervisedTask(ID));
      expect(f.calls("abort")).toEqual([[SESSION,OP]]);
      const current=await f.record();
      expect(["cancel_requested","cancelled","unknown"]).toContain(current?.status);
      f.release.release(); await bounded(start); await a.drain();
      expect((await f.record())?.status).not.toBe("running");
      expect(f.calls("accepted")).toEqual([[SESSION,OP]]);
      expect(f.count("reserve")).toBe(1);
      if(cancel.confirmed) expect((await f.record())?.status).toBe("cancelled");
    } finally { f.release.release(); await start.catch(()=>{}); }
  });
  test("restart after native create response loss preserves exact identity, no duplicate create", async () => {
    const f=await fixture("lost-create"); await launch(f);
    expect(f.calls("create")).toEqual([[SESSION]]); noDispatch(f);
    const restarted=f.newAgent();
    await bounded(restarted.agent.startSupervisedTask(request)); await restarted.drain();
    expect(f.calls("create")).toEqual([[SESSION]]);
    expect(f.calls("lookup")).toContainEqual([SESSION]);
    expect(f.count("reserve")).toBe(1); expect(f.count("branch")).toBe(0);
    // Positive exact lookup should resume to a single accepted submit.
    successful(f);
  });
  test("lost submit response + new server instance reconciles native receipt, no second accepted effect", async () => {
    const f=await fixture("lost-submit"); await launch(f); successful(f);
    const restarted=f.newAgent();
    await bounded(restarted.agent.startSupervisedTask(request)); await restarted.drain();
    const status=await bounded<any>(restarted.agent.supervisedTaskStatus(ID));
    expect(f.calls("wait")).toContainEqual([SESSION,OP]);
    expect(status.status).toBe("finished");
    expect(status.passed).toBe(false); expect(status.verified).toBe(false);
    successful(f);
  });
  test("root and inherited child cannot escape GitHub mutation denial", async () => {
    const f=await fixture(); const a=await launch(f); successful(f);
    const branch="opencode/staging-"+ID, child="ses_t07_child";
    const mutations=["branch","write","pr","review"];
    // Check root guard, then attempt the real delegated scope transfer.
    for (const operation of mutations)
      await expect(a.agent.enforceSessionScope(SESSION,{kind:"github",repo:REPO,operation,branch})).rejects.toThrow();
    let denied=false;
    try { await a.agent.inheritSessionScope(SESSION,child,"supervised-"+ID); }
    catch(e) { if(e instanceof ReferenceError || e instanceof TypeError) throw e; denied=true; }
    for(const operation of mutations)
      await expect(a.agent.enforceSessionScope(child,{kind:"github",repo:REPO,operation,branch})).rejects.toThrow();
    // T04 currently requires fail-closed delegation, before native fork.
    expect(denied).toBe(true);
    await expect(a.agent.startSubagent(SESSION,"Read source only","analysis")).rejects.toThrow();
    expect(f.count("fork")).toBe(0);
    expect(f.calls("accepted")).toEqual([[SESSION,OP]]);
    expect(f.count("branch")).toBe(0);
    expect(f.calls("http").every(args=>args[0]==="GET")).toBe(true);
    expect(await f.storage.get("g8-scope:"+child)).toBeUndefined();
  });
});

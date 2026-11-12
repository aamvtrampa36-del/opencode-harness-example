#!/usr/bin/env bun
/**
 * Reusable low-cost E2E selftest for the code OpenCode changes.
 *
 * Fails CLOSED: a "pass" verdict requires a real Bun runtime, a real spawned
 * process chain (proof nonce), a real build of the candidate artifact and
 * HTTP responses byte-identical to that artifact. Simulated, stale or missing
 * runtimes can only produce "fail-closed", never "pass".
 *
 * Reuses existing checks instead of duplicating them: --full delegates to
 * bun test, typecheck, check-invariants and the synthetic test-preview. The
 * E2E core compiles the real artifact (vite build) and serves it with this
 * project's own preview server (src/preview-server.ts), the mechanism
 * scripts/test-preview.mjs already exercises.
 *
 * Usage (repo root):
 *   bun scripts/selftest.mjs --branch opencode/<task> --commit <sha> [flags]
 * Flags:
 *   --project <slug>       name served by the preview server (default selftest-candidate)
 *   --branch <name>        REQUIRED isolated review branch (opencode/*)
 *   --commit <sha>         commit the tested code links to (or --allow-uncommitted)
 *   --allow-uncommitted    local iteration without commit linkage
 *   --receipt <path>       receipt output (default .selftest/receipt.json)
 *   --resume <path>        rerun only previously failed stages and dependents
 *   --only <a,b>           restrict stages
 *   --full                 delegate first to unit tests, typecheck, invariants, preview
 *   --reuse-dist           use an existing dist/ instead of rebuilding
 *   --force-build          rebuild even if a resumed artifact hash matches
 * Exit codes: 0 pass, 1 fail, 2 fail-closed.
 */
// Fail closed before ANY import: a non-Bun runtime must never reach real work.
if (!process.versions || !process.versions.bun) {
  console.error(
    "FAIL-CLOSED: run with Bun (`bun scripts/selftest.mjs`). Without the real runtime no PASS may be attributed."
  );
  process.exit(2);
}
const { spawn, spawnSync } = await import("node:child_process");
const { createHash } = await import("node:crypto");
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = await import("node:fs");
const { tmpdir } = await import("node:os");
const { dirname, join } = await import("node:path");
const { PREVIEW_SOURCE } = await import("../src/preview-server.ts");
const {
  MOBILE_NOTE,
  RECEIPT_SCHEMA,
  STAGE_ORDER,
  assertNoSecrets,
  buildHttpChecks,
  buildReceipt,
  selectStages,
  validateTarget,
} = await import("../src/selftest-core.ts");

const startedAt = new Date().toISOString();
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const tail = (text, max = 4000) => {
  const t = String(text ?? "");
  return t.length <= max ? t : t.slice(-max);
};

if (!existsSync("package.json")) {
  console.error("FAIL-CLOSED: run from the repository root (package.json not found).");
  process.exit(2);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
      else {
        args[a.slice(2)] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

const argv = parseArgs(process.argv.slice(2));
const project = typeof argv.project === "string" ? argv.project : "selftest-candidate";
const branch = typeof argv.branch === "string" ? argv.branch : "";
const commit = typeof argv.commit === "string" ? argv.commit : null;
const allowUncommitted = argv["allow-uncommitted"] === true;
const receiptPath = typeof argv.receipt === "string" ? argv.receipt : ".selftest/receipt.json";
const logDir = ".selftest/logs";
mkdirSync(logDir, { recursive: true });
const distDir = "dist/client";
const workerEntry = "dist/opencode_harness_example/index.js";
const endpoint = "http://127.0.0.1:4321";

const runId = sha256(`${branch}|${commit}|${Date.now()}|${Math.random()}`).slice(0, 12);
const notes = [];
let failClosed = null;
const stages = [];
const checks = [];

function record(stage) {
  stages.push(stage);
  const status = stage.skippedBecause
    ? `skip ${stage.skippedBecause}`
    : stage.ok
      ? "ok"
      : `FAIL exit=${stage.exitCode}`;
  console.log(`[${stage.id}] ${status} (${stage.ms}ms)`);
  if (!stage.ok && !stage.skippedBecause) console.log(tail(stage.logTail, 1200));
}

/** NODE_OPTIONS default calibrated on the 1.1 GB staging container: the stock
 *  512 MB heap SIGABRT'd (exit 134) and an unbounded heap was SIGKILLed by
 *  the system OOM killer (exit 137). Override with NODE_OPTIONS. */
function envFor(kind) {
  const defaults = { build: "--max-old-space-size=768", typecheck: "--max-old-space-size=2048" };
  const extra = !process.env.NODE_OPTIONS && defaults[kind] ? defaults[kind] : process.env.NODE_OPTIONS;
  return { ...process.env, ...(extra ? { NODE_OPTIONS: extra } : {}) };
}

function runStep(id, args, kind) {
  const t0 = Date.now();
  const env = envFor(kind);
  const res = spawnSync(process.execPath, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = [res.stdout, res.stderr].filter(Boolean).join("\n");
  return {
    id,
    ok: res.status === 0,
    exitCode: res.status,
    ms: Date.now() - t0,
    logTail: tail(text),
  };
}

function artifactState() {
  const index = join(distDir, "index.html");
  if (!existsSync(index)) return null;
  const assetsDir = join(distDir, "assets");
  const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  return {
    clientIndexSha256: sha256(readFileSync(index)),
    assetCount: assets.length,
    workerEntrySha256: existsSync(workerEntry) ? sha256(readFileSync(workerEntry)) : null,
  };
}

// ---- target validation (fail closed before anything else) -------------------
const validation = validateTarget({ project, branch, commit, allowUncommitted });
if (!validation.ok) {
  failClosed = `target.${validation.field}: ${validation.reason}`;
  const receipt = buildReceipt({
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    project,
    branch,
    commit,
    commitLinked: false,
    runtime: { bun: process.versions.bun, node: null, platform: `${process.platform}/${process.arch}` },
    buildArtifact: null,
    stages,
    checks,
    failClosed,
    mobile: MOBILE_NOTE,
  });
  assertNoSecrets(receipt);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  console.error(`FAIL-CLOSED: ${failClosed}`);
  console.error(`receipt: ${receiptPath}`);
  process.exit(2);
}

// ---- independent source identity gate ---------------------------------------
// A caller-supplied SHA does NOT prove the tested checkout matches that SHA.
// No promotion receipt may claim commit linkage without verifying Git HEAD
// and a clean tracked worktree. Local iteration can use --allow-uncommitted.
let commitVerified = false;
function rejectUnverifiableSource(reason) {
  const receipt = buildReceipt({
    runId, startedAt, finishedAt: new Date().toISOString(),
    project, branch, commit, commitLinked: false,
    runtime: { bun: process.versions.bun, node: null, platform: `${process.platform}/${process.arch}` },
    buildArtifact: null, stages, checks, failClosed: reason, mobile: MOBILE_NOTE,
  });
  assertNoSecrets(receipt);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  console.error("FAIL-CLOSED: " + reason);
  process.exit(2);
}
if (commit !== null) {
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8", timeout: 8000 });
  const current = String(head.stdout ?? "").trim().toLowerCase();
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(current) || !current.startsWith(commit.toLowerCase())) {
    rejectUnverifiableSource("supplied commit does not match the actual Git HEAD");
  }
  const clean = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 8000 });
  if (clean.status !== 0 || String(clean.stdout ?? "").trim()) {
    rejectUnverifiableSource("tracked source files differ from the committed Git checkout");
  }
  commitVerified = true;
  notes.push("Git HEAD and tracked-tree cleanliness verified for " + current);
}
if (argv["reuse-dist"] === true && !argv.resume) {
  rejectUnverifiableSource("--reuse-dist requires --resume with a matching, previously verified build receipt");
}

// ---- stage selection (fresh or affected-only resume) ------------------------
let selection = { run: [...STAGE_ORDER], skipped: [] };
let priorReceipt = null;
if (argv.resume) {
  let prior;
  try {
    prior = JSON.parse(readFileSync(String(argv.resume), "utf8"));
  } catch (error) {
    console.error(`FAIL-CLOSED: unreadable resume receipt: ${error}`);
    process.exit(2);
  }
  if (prior.schema !== RECEIPT_SCHEMA) {
    console.error(`FAIL-CLOSED: unknown receipt schema ${JSON.stringify(prior.schema)}`);
    process.exit(2);
  }
  if (prior.project !== project || prior.branch !== branch || prior.commit !== commit ||
      prior.commitLinked !== commitVerified || !Array.isArray(prior.stages) ||
      !prior.stages.some(s => s.id === "preflight" && s.ok === true) ||
      !prior.stages.some(s => s.id === "build" && s.ok === true)) {
    rejectUnverifiableSource("resume receipt is not attested to this exact project, branch, commit and successful prior build");
  }
  priorReceipt = prior;
  const priorArtifact = prior.buildArtifact?.clientIndexSha256 ?? null;
  const current = artifactState();
  const forceRebuild =
    argv["force-build"] === true || !current || !priorArtifact ||
    current.clientIndexSha256 !== priorArtifact ||
    current.workerEntrySha256 !== prior.buildArtifact?.workerEntrySha256;
  selection = selectStages({
    previous: (prior.stages ?? [])
      .filter((s) => STAGE_ORDER.includes(s.id))
      .map((s) => ({ id: s.id, ok: s.ok === true })),
    forceRebuild,
  });
  if (forceRebuild) notes.push("artifact hash changed or missing; build rerun");
  // Always perform fresh liveness proof and fresh HTTP responses on resume.
  if (!selection.run.includes("preflight")) {
    selection.run.unshift("preflight");
    selection.skipped = selection.skipped.filter(s => s.id !== "preflight");
  }
  for (const stage of ["serve", "http"]) {
    if (!selection.run.includes(stage)) {
      selection.run.push(stage);
      selection.skipped = selection.skipped.filter(s => s.id !== stage);
    }
  }
  notes.push(`resume: ${selection.run.join(",")} rerun, ${selection.skipped.length} attested stages skipped`);
}
if (argv.only) {
  const only = String(argv.only).split(",").map((s) => s.trim());
  selection.run = selection.run.filter((id) => only.includes(id));
}
for (const skipped of selection.skipped) {
  record({
    id: skipped.id,
    ok: true,
    exitCode: null,
    ms: 0,
    logTail: `not rerun: ${skipped.because}`,
    skippedBecause: skipped.because,
  });
}

// ---- delegated stages (--full composes existing checks, no duplication) -----
if (argv.full === true) {
  for (const [id, args, kind] of [
    ["unit-tests", ["test"], null],
    ["typecheck", ["run", "typecheck"], "typecheck"],
    ["invariants", ["scripts/check-invariants.mjs"], null],
    ["preview-synthetic", ["scripts/test-preview.mjs"], null],
  ]) {
    record(runStep(id, args, kind));
  }
}

// ---- preflight: fresh runtime proof, write probe ----------------------------
if (selection.run.includes("preflight")) {
  const t0 = Date.now();
  const proof = spawnSync(
    process.execPath,
    ["-e", 'process.stdout.write("SELFTEST_PROOF_OK:" + process.env.SELFTEST_PROOF_TOKEN)'],
    { env: { ...process.env, SELFTEST_PROOF_TOKEN: runId }, encoding: "utf8" }
  );
  const proofOk = proof.stdout?.trim() === `SELFTEST_PROOF_OK:${runId}`;
  let writeProbe = false;
  try {
    const probe = mkdtempSync(join(tmpdir(), "selftest-write-probe-"));
    writeFileSync(join(probe, "probe"), "ok");
    rmSync(probe, { recursive: true, force: true });
    writeProbe = true;
  } catch {
    writeProbe = false;
  }
  const ok = proofOk && writeProbe;
  record({
    id: "preflight",
    ok,
    exitCode: ok ? 0 : 1,
    ms: Date.now() - t0,
    logTail: tail(
      `bun=${process.versions.bun} proof=${proofOk} writeProbe=${writeProbe} proofOut=${JSON.stringify(proof.stdout ?? "")}`
    ),
  });
  if (!ok) failClosed = proofOk ? "filesystem write probe failed" : "spawned bun did not echo the fresh proof nonce (stale or simulated runtime)";
}

// ---- build: real candidate artifact -----------------------------------------
let artifact = artifactState();
let buildFailed = false;
if (selection.run.includes("build")) {
  const reusable = argv["reuse-dist"] === true && priorReceipt &&
    priorReceipt.buildArtifact?.clientIndexSha256 === artifact?.clientIndexSha256 &&
    priorReceipt.buildArtifact?.workerEntrySha256 === artifact?.workerEntrySha256
    ? artifact : null;
  if (reusable && reusable.workerEntrySha256) {
    record({
      id: "build",
      ok: true,
      exitCode: 0,
      ms: 0,
      logTail: `reused existing dist (--reuse-dist): ${JSON.stringify(reusable)}`,
      skippedBecause: "--reuse-dist",
    });
  } else {
    const step = runStep("build", ["run", "build"], "build");
    artifact = artifactState();
    const complete = artifact && artifact.workerEntrySha256;
    step.ok = step.ok && !!complete;
    if (!step.ok) buildFailed = true;
    if (!complete) step.logTail = tail(step.logTail + "\nselftest: dist/client/index.html or worker entry missing after build");
    step.logTail = tail(`${step.logTail}\nNODE_OPTIONS=${envFor("build").NODE_OPTIONS ?? "(unset)"}\nartifact=${JSON.stringify(artifact)}`);
    record(step);
    if (!step.ok && !failClosed) notes.push("repair: inspect .selftest/logs/build.log tail; fix the source error, then rerun with --resume");
  }
}
if (buildFailed) {
  artifact = null;
  notes.push("build failed; the dist left on disk is stale and was NOT certified; serve/http skipped");
}

// ---- serve + http: real environment, real responses --------------------------
let server = null;
let temp = null;
try {
  const serveSelected = selection.run.includes("serve") || (selection.run.includes("http") && !stages.find((s) => s.id === "serve" && s.ok));
  const httpSelected = selection.run.includes("http");
  if (serveSelected && !failClosed && !buildFailed) {
    const t0 = Date.now();
    temp = mkdtempSync(join(tmpdir(), "selftest-e2e-"));
    const servedRoot = join(temp, project);
    cpSync(distDir, join(servedRoot, "dist"), { recursive: true });
    writeFileSync(join(servedRoot, "package.json"), JSON.stringify({ name: "selftest-sentinel", private: true }));
    const hasNode = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;
    const logFd = openSync(join(logDir, "serve.log"), "a");
    server = spawn(
      hasNode ? "node" : process.execPath,
      hasNode ? ["--input-type=module", "-e", PREVIEW_SOURCE] : ["-e", PREVIEW_SOURCE],
      { env: { ...process.env, PREVIEW_ROOT: temp }, stdio: ["ignore", logFd, logFd] }
    );
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try {
        const res = await fetch(endpoint + "/__health", { signal: AbortSignal.timeout(500) });
        ready = res.ok;
      } catch {
        /* startup */
      }
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    record({
      id: "serve",
      ok: ready,
      exitCode: ready ? 0 : 1,
      ms: Date.now() - t0,
      logTail: tail(ready ? `preview ready at ${endpoint} (pid ${server.pid}, runtime ${hasNode ? "node" : "bun"}, root ${temp})` : "preview did not become healthy; see .selftest/logs/serve.log"),
    });
    if (!ready && !failClosed) failClosed = "preview HTTP environment never became healthy";
  }

  if (httpSelected && server && !failClosed && !buildFailed) {
    const t0 = Date.now();
    const assets = existsSync(join(distDir, "assets")) ? readdirSync(join(distDir, "assets")) : [];
    const assetJs = assets.find((f) => /^index-.*\.js$/.test(f));
    const runChecks = buildHttpChecks(project, { assetJs: assetJs ?? "MISSING_ASSET.js", nonce: runId });
    for (const check of runChecks) {
      const actual = { status: null, contentType: null, bodySha256: null, bodyMatchesDisk: null };
      let error = null;
      try {
        const res = await fetch(endpoint + check.path, { method: check.method, signal: AbortSignal.timeout(5000) });
        actual.status = res.status;
        actual.contentType = res.headers.get("content-type");
        const body = new Uint8Array(await res.arrayBuffer());
        actual.bodySha256 = sha256(body);
        if (check.expect.bodyEqualsDisk) {
          const disk = readFileSync(join(distDir, check.expect.bodyEqualsDisk));
          actual.bodyMatchesDisk = Buffer.compare(Buffer.from(body), disk) === 0;
        }
      } catch (e) {
        error = String(e);
      }
      const statusOk = actual.status === check.expect.status;
      const typeOk = !check.expect.contentType || String(actual.contentType ?? "").includes(check.expect.contentType);
      const bodyOk = check.expect.bodyEqualsDisk ? actual.bodyMatchesDisk === true : true;
      checks.push({
        id: check.id,
        ok: statusOk && typeOk && bodyOk && !error,
        request: { method: check.method, path: check.path },
        expected: check.expect,
        actual: error ? { ...actual, error } : actual,
      });
    }
    const failed = checks.filter((c) => !c.ok);
    record({
      id: "http",
      ok: failed.length === 0,
      exitCode: failed.length === 0 ? 0 : 1,
      ms: Date.now() - t0,
      logTail: tail(
        failed.length === 0
          ? checks.map((c) => `${c.id}: ${c.actual.status} ${c.actual.contentType ?? ""} matchesDisk=${c.actual.bodyMatchesDisk}`).join("\n")
          : failed.map((c) => `${c.id}: expected ${JSON.stringify(c.expected)} got ${JSON.stringify(c.actual)}`).join("\n")
      ),
    });
  }
} finally {
  if (server) {
    server.kill("SIGTERM");
    setTimeout(() => server.kill("SIGKILL"), 1500).unref?.();
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
}

// Partial/debug runs must never certify a full candidate.
if (argv.only) failClosed = failClosed || "partial --only execution cannot attest a full candidate";
if (selection.run.length === 0 && !selection.skipped.length) failClosed = failClosed || "no checks executed";

// ---- receipt: machine-readable, commit-linked, secret-free -------------------
const receipt = buildReceipt({
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  project: validation.project,
  branch,
  commit,
  commitLinked: commitVerified,
  runtime: { bun: process.versions.bun, node: null, platform: `${process.platform}/${process.arch}` },
  buildArtifact: artifact,
  stages,
  checks,
  failClosed,
  mobile: MOBILE_NOTE,
  notes,
});
assertNoSecrets(receipt);
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
console.log(`receipt: ${receiptPath} verdict=${receipt.verdict}`);
process.exit(receipt.verdict === "pass" ? 0 : receipt.verdict === "fail" ? 1 : 2);

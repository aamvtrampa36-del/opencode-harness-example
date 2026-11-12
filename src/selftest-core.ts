/**
 * Pure rules for the reusable E2E selftest (scripts/selftest.mjs owns all I/O).
 * Every rule here is deliberately strict so the runner can only report "pass"
 * from real, isolated, commit-linked evidence; anything else fails closed.
 */
import { validateProject } from "./dev-guard";

export const STAGE_ORDER = ["preflight", "build", "serve", "http"] as const;
export type Stage = (typeof STAGE_ORDER)[number];

/** stage -> stages it depends on. */
export const STAGE_DEPS: Readonly<Record<Stage, readonly Stage[]>> = {
  preflight: [],
  build: ["preflight"],
  serve: ["build"],
  http: ["serve"],
};

/** The runner may only claim isolation on an OpenCode review branch. */
export const REVIEW_BRANCH = /^opencode\/[A-Za-z0-9._-]+$/;
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
export const RECEIPT_SCHEMA = "opencode-selftest-receipt/1";
export const MOBILE_NOTE =
  "Mobile execution stays with the existing compatible automation " +
  "(.github/workflows/android-apk.yml builds and verifies the APK); " +
  "this receipt claims no real device hardware.";

export type Target = {
  project: string;
  branch: string;
  commit: string | null;
  allowUncommitted?: boolean;
};
export type Validation =
  | { ok: true; project: string }
  | { ok: false; field: "project" | "branch" | "commit"; reason: string };

/** Validate the isolated project/branch/commit triple. Never throws. */
export function validateTarget(target: Target): Validation {
  let project: string;
  try {
    project = validateProject(target.project);
  } catch (error) {
    return {
      ok: false,
      field: "project",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!REVIEW_BRANCH.test(target.branch)) {
    return {
      ok: false,
      field: "branch",
      reason:
        "Branch must be an isolated OpenCode review branch (opencode/*); got " +
        JSON.stringify(target.branch),
    };
  }
  if (target.commit === null) {
    if (!target.allowUncommitted) {
      return {
        ok: false,
        field: "commit",
        reason:
          "Commit SHA required (fail closed): pass --commit <sha>, or --allow-uncommitted for local iteration only",
      };
    }
  } else if (!COMMIT_SHA.test(target.commit)) {
    return { ok: false, field: "commit", reason: "Commit must be a git SHA (7-40 hex)" };
  }
  return { ok: true, project };
}

/** Transitive dependents of a stage, in canonical order (excludes the stage). */
export function dependentsOf(
  stage: Stage,
  order: readonly Stage[] = STAGE_ORDER,
  deps: Readonly<Record<Stage, readonly Stage[]>> = STAGE_DEPS
): Stage[] {
  const selected = new Set<Stage>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of order) {
      if (candidate === stage || selected.has(candidate)) continue;
      if (deps[candidate].some((d) => d === stage || selected.has(d))) {
        selected.add(candidate);
        changed = true;
      }
    }
  }
  return order.filter((s) => selected.has(s));
}

export type PreviousStage = { id: string; ok: boolean };
export type Selection = {
  run: Stage[];
  skipped: { id: Stage; because: string }[];
};

/**
 * Choose which stages to execute. A fresh run executes everything. With a
 * previous receipt only failed stages, their dependents and anything they
 * serve rerun; passed stages are recorded as skipped, not re-executed.
 */
export function selectStages(
  options: {
    previous?: readonly PreviousStage[];
    only?: readonly string[];
    forceRebuild?: boolean;
  } = {}
): Selection {
  const { previous, only, forceRebuild } = options;
  const filter = (stages: Stage[]) =>
    only ? stages.filter((s) => only.includes(s)) : stages;
  if (!previous || previous.length === 0) {
    return { run: filter([...STAGE_ORDER]), skipped: [] };
  }
  const rerun = new Set<Stage>();
  for (const prior of previous) {
    if (!prior.ok && (STAGE_ORDER as readonly string[]).includes(prior.id)) {
      rerun.add(prior.id as Stage);
    }
  }
  for (const failed of [...rerun]) {
    for (const dependent of dependentsOf(failed)) rerun.add(dependent);
  }
  // serve is cheap and http needs a live server: rerun serve with http.
  if (rerun.has("http")) rerun.add("serve");
  if (forceRebuild) {
    for (const s of ["build", "serve", "http"] as const) rerun.add(s);
  }
  const run = STAGE_ORDER.filter((s) => rerun.has(s));
  const skipped = STAGE_ORDER.filter((s) => !rerun.has(s)).map((id) => {
    const prior = previous.find((s) => s.id === id);
    return { id, because: prior?.ok ? "passed previously" : "not requested" };
  });
  return {
    run: filter(run),
    skipped: only ? skipped.filter((s) => !only.includes(s.id)) : skipped,
  };
}

export type HttpExpectation = {
  status: number;
  contentType?: string;
  /** Path relative to the built dist root whose bytes must equal the body. */
  bodyEqualsDisk?: string;
};
export type HttpCheck = {
  id: string;
  method: "GET" | "POST";
  path: string;
  expect: HttpExpectation;
};

/**
 * One functional endpoint (index + its real asset, byte-bound to the built
 * artifact) and three negative endpoints (404, source-tree isolation, method
 * guard). The nonce makes every run unreplayable by a stale or fake server.
 */
export function buildHttpChecks(
  project: string,
  files: { assetJs: string; nonce: string }
): HttpCheck[] {
  return [
    {
      id: "functional-index",
      method: "GET",
      path: `/${project}/dist/`,
      expect: { status: 200, contentType: "text/html", bodyEqualsDisk: "index.html" },
    },
    {
      id: "functional-asset",
      method: "GET",
      path: `/${project}/dist/assets/${files.assetJs}`,
      expect: { status: 200, contentType: "javascript", bodyEqualsDisk: `assets/${files.assetJs}` },
    },
    {
      id: "negative-404",
      method: "GET",
      path: `/${project}/dist/missing-${files.nonce}.js`,
      expect: { status: 404 },
    },
    {
      id: "negative-source-isolation",
      method: "GET",
      path: `/${project}/package.json`,
      expect: { status: 403 },
    },
    {
      id: "negative-method",
      method: "POST",
      path: `/${project}/dist/`,
      expect: { status: 405 },
    },
  ];
}

export type StageResult = {
  id: string;
  ok: boolean;
  exitCode: number | null;
  ms: number;
  logTail: string;
  skippedBecause?: string;
};
export type CheckResult = {
  id: string;
  ok: boolean;
  request: { method: string; path: string };
  expected: HttpExpectation;
  actual: {
    status: number | null;
    contentType: string | null;
    bodySha256: string | null;
    bodyMatchesDisk: boolean | null;
    error?: string;
  };
};
export type BuildArtifact = {
  clientIndexSha256: string;
  assetCount: number;
  workerEntrySha256: string | null;
};
export type Receipt = {
  schema: typeof RECEIPT_SCHEMA;
  runId: string;
  startedAt: string;
  finishedAt: string;
  project: string;
  branch: string;
  commit: string | null;
  commitLinked: boolean;
  runtime: { bun: string; node: string | null; platform: string };
  buildArtifact: BuildArtifact | null;
  stages: StageResult[];
  checks: CheckResult[];
  verdict: "pass" | "fail" | "fail-closed";
  failClosedReason?: string;
  mobile: string;
  notes?: string[];
};
export type ReceiptInput = Omit<Receipt, "schema" | "verdict" | "failClosedReason"> & {
  failClosed?: string;
};

export function buildReceipt(input: ReceiptInput): Receipt {
  const verdict: Receipt["verdict"] = input.failClosed
    ? "fail-closed"
    : input.stages.some((s) => !s.ok) || input.checks.some((c) => !c.ok)
      ? "fail"
      : "pass";
  return {
    schema: RECEIPT_SCHEMA,
    ...input,
    verdict,
    ...(input.failClosed ? { failClosedReason: input.failClosed } : {}),
  };
}

/** Same secret patterns check-invariants.mjs guards; receipts must be clean. */
export const SECRET_PATTERN = /sk-or-v1-[A-Za-z0-9]{16,}|sk-proj-[A-Za-z0-9]{16,}/;

export function assertNoSecrets(receipt: Receipt): void {
  if (SECRET_PATTERN.test(JSON.stringify(receipt))) {
    throw new Error("Receipt contains a possible API secret; refusing to write it");
  }
}

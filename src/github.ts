/**
 * Native GitHub REST bridge for OpenCode Cloud.
 * The token is held only by Cloudflare Worker Secrets, NEVER inside the Linux
 * container, model prompts, client bundles or Git clone URLs.
 *
 * Deliberately narrow: a small allowlist of the owner's repositories, and
 * writes ONLY to opencode/* review branches. No merging, force-push, deletion,
 * releases or production deployments.
 */
import { githubRestNoRedirect, freezeGitHubSourcePin, assertPinnedGitHubAction, assertGitHubSourceIdentity, type GitHubSourcePin } from "./metralla-m05-source";

export const ALLOWED_REPOS = [
  "aamvtrampa36-del/cdf-cloud-engine",
  "aamvtrampa36-del/CDF-WorkBench-",
  "aamvtrampa36-del/opencode-harness-example"
] as const;

export type GitHubAction =
  | { action: "repo"; repo: string }
  | { action: "read"; repo: string; path: string; ref?: string }
  | { action: "pr_search"; repo: string; query: string; page?: number }
  | { action: "pr_info"; repo: string; number: number }
  | { action: "issue_info"; repo: string; number: number }
  | { action: "pr_files"; repo: string; number: number; page?: number }
  | { action: "pr_reviews"; repo: string; number: number; page?: number }
  | { action: "pr_checks"; repo: string; sha: string }
  | { action: "branch"; repo: string; branch: string }
  | { action: "write"; repo: string; path: string; branch: string; content: string; message?: string }
  | { action: "write"; repo: string; path: string; branch: string; expectedHead: string;
      oldText: string; newText: string; message?: string }
  | { action: "pr"; repo: string; branch: string; title: string; body?: string }
  | { action: "review"; repo: string; branch: string };

const BRANCH_RE = /^opencode\/[a-z0-9][a-z0-9._-]{0,59}$/;
const MAX_FILE_BYTES = 100_000;
const MAX_REPLACEMENT_FILE_BYTES = 128_000;
const MAX_REPLACEMENT_TEXT_BYTES = 8_192;

const OWNER = "aamvtrampa36-del";
const OPENCODE_REPO = OWNER + "/opencode-harness-example";
export const OPENCODE_STAGING_BASE = "staging/opencode-g1-rpc-safe-20261120";
const STAGING_REVIEW = /^opencode\/staging-[a-f0-9]{16}$/;
/** New OpenCode-only staging tasks are forked from a fixed, reviewed staging ref.
 * Legacy supervised branches and all other repositories stay on default main. */
function reviewedBase(repo: string, branch: string, defaultBranch: string): string {
  if (!STAGING_REVIEW.test(branch)) return defaultBranch;
  if (repo.toLowerCase() !== OPENCODE_REPO.toLowerCase()) {
    throw new Error("Staging review branches are OpenCode-only");
  }
  return OPENCODE_STAGING_BASE;
}
const REPOSITORY_FORMAT = /^[A-Za-z0-9_.-]{1,100}$/;

/** Authorization stays per-account and is checked at every tool execution. */
export function normalizeOwnedRepository(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid repository name");
  const [owner, name, extra] = value.trim().split("/");
  if (extra || owner?.toLowerCase() !== OWNER || !name || !REPOSITORY_FORMAT.test(name) || name === "." || name === "..") {
    throw new Error("Only repositories belonging to the authorized GitHub account are permitted");
  }
  return OWNER + "/" + name;
}
function repoChecked(repo: unknown, allowed: ReadonlySet<string>): string {
  const canonical = normalizeOwnedRepository(repo);
  if (![...allowed].some(item => item.toLowerCase() === canonical.toLowerCase())) {
    throw new Error("Repository is not authorized for OpenCode");
  }
  return canonical;
}
function branchChecked(branch: unknown): string {
  if (typeof branch !== "string" || !BRANCH_RE.test(branch) ||
      branch.includes("..") || branch.endsWith(".")) {
    throw new Error("Use an opencode/<name> review branch; production branches are read-only");
  }
  return branch;
}
/** Reject invalid pagination and object IDs before contacting private GitHub. */
function positiveNumber(value: unknown, label: string, max = 1_000_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error("Invalid GitHub " + label);
  }
  return value;
}
function shaChecked(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error("Invalid GitHub commit SHA");
  }
  return value.toLowerCase();
}
function pathChecked(path: unknown): string {
  if (typeof path !== "string" || path.length > 180 || !path ||
      path.startsWith("/") || path.includes("\\") ||
      path.split("/").some(x => !x || x === "." || x === "..") ||
      !/^[a-zA-Z0-9_./-]+$/.test(path)) {
    throw new Error("Invalid repository file path");
  }
  return path.split("/").map(encodeURIComponent).join("/");
}
/** Never update narrative canon or operational deployment configuration via a review tool. */
function assertNonCanonicalWrite(repo: string, path: string): void {
  const lower = path.toLowerCase();
  if (lower.startsWith(".github/workflows/") ||
      /^(?:canon|canonical|oficial|official|narrativa|narrative|prosa|chapters|capitulos|biblia|biblias|published|production)(?:\/|$)/.test(lower) ||
      /(?:^|\/)(?:canon|canonical|oficial|official|narrativa|narrative|capitulos|chapters|biblias)(?:\/|$)/.test(lower) ||
      /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.dev\.vars(?:\.[^/]+)?|wrangler(?:\.[a-z0-9_-]+)?\.(?:toml|jsonc?))(?:$|\/)/.test(lower)) {
    throw new Error("Protected official/production path cannot be edited from OpenCode");
  }
  // Both CDF repositories contain operational and editorial data. G8 smoke
  // artifacts belong under docs/opencode-g8/, never within a canonical source.
  void repo;
}
function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("GitHub file exceeds 100KB; split the task");
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}
function fromBase64(value: string): string {
  const data = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(data, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

type GitHubFetch = typeof fetch;

/** T08: contract for ONE shared durable publisher per (repo, base).
 * T03 must provide transactional ownership and monotonic fencing. Acquiring
 * inside one JS isolate is insufficient; a pending/unknown POST blocks release.
 */
export type GitHubPrPublicationScope = {
  repo: string; base: string; branch: string; title: string; body: string;
};
export type GitHubPrPublicationProof = { readonly baseSha: string; readonly headSha: string };
export type GitHubPrPublicationPermit = {
  readonly fencingToken: string;
  readonly retryOnly: boolean;
  /** Pinned to the original write-ahead effect, never regenerated from a changed branch. */
  readonly expectedProof?: GitHubPrPublicationProof;
  /** Durable "publishing" journal + token validation BEFORE HTTP POST. */
  beginExternalEffect(proof: GitHubPrPublicationProof): Promise<void>;
};
export type GitHubRefIntent = Readonly<{repo:string; base:string; branch:string; operation:"branch"|"write"; expected:string|null; target:string}>;
export interface GitHubPrPublicationGate {
  /** Existing supervisor publisher, same transactional authority as PRs. */
  withRefEffect?(intent: GitHubRefIntent, apply: () => Promise<void>, observe: () => Promise<string|null>): Promise<{reconciled:boolean}>;
  withExclusive<T>(
    intent: GitHubPrPublicationScope,
    execute: (permit: GitHubPrPublicationPermit) => Promise<T>
  ): Promise<T>;
}

export class GitHubBridge {
  private readonly allowed: ReadonlySet<string>;
  private readonly sourcePin?: GitHubSourcePin;
  constructor(
    private readonly token: string,
    private readonly http: GitHubFetch = fetch,
    allowedRepos: readonly string[] = ALLOWED_REPOS,
    private readonly publicationGate?: GitHubPrPublicationGate,
    private readonly pilotBase?: {branch:string;sha:string;base:string},
    sourcePin?: GitHubSourcePin
  ) {
    if (!token) throw new Error("GITHUB_TOKEN is not configured in Cloudflare Secrets");
    this.allowed = new Set(allowedRepos.map(normalizeOwnedRepository));
    this.sourcePin = sourcePin ? freezeGitHubSourcePin(sourcePin) : undefined;
    if (this.sourcePin) {
      repoChecked(this.sourcePin.repo, this.allowed);
      if (pilotBase && (pilotBase.branch !== this.sourcePin.branch || pilotBase.sha !== this.sourcePin.commit || pilotBase.base !== this.sourcePin.base)) throw Error("GITHUB_SOURCE_PIN_PILOT_MISMATCH");
    }
  }

  private reviewedBase(repo:string,branch:string,defaultBranch:string){
    if (this.sourcePin) {
      assertPinnedGitHubAction(this.sourcePin, {repo, operation:"branch", branch});
      return this.sourcePin.base;
    }
    if(!this.pilotBase)return reviewedBase(repo,branch,defaultBranch);
    if(repo.toLowerCase()!==OPENCODE_REPO.toLowerCase()||branch!==this.pilotBase.branch||
      !STAGING_REVIEW.test(branch)||this.pilotBase.base!=="f0-c10/integracion-final-20261123"||!/^[a-f0-9]{40}$/.test(this.pilotBase.sha))throw Error("PILOT_GITHUB_BASE_INVALID");
    return this.pilotBase.base;
  }
  private async api(method: string, route: string, data?: unknown, allow404 = false,
    _rejectRedirect = false): Promise<any> {
    const response = await githubRestNoRedirect(this.http, "https://api.github.com" + route, {
      method,
      headers: {
        "Authorization": "Bearer " + this.token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpenCode-Cloud"
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(45_000)
    });
    if (response.status === 404 && allow404) return null;
    const body = await response.json() as any;
    if (!response.ok) {
      const message = typeof body?.message === "string" ? body.message.slice(0, 250) : "API request failed";
      // Stable distinctions for the agent. 404 on a private repository may
      // mean hidden-by-GitHub access denial, not that the PR is absent.
      const kind = response.status === 401 ? "GITHUB_AUTH_REQUIRED"
        : response.status === 403 ? "GITHUB_PERMISSION_OR_RATE_LIMIT"
        : response.status === 404 ? "GITHUB_NOT_ACCESSIBLE"
        : response.status === 429 || response.status >= 500 ? "GITHUB_TRANSIENT"
        : "GITHUB_API_ERROR";
      // Respect Retry-After only as a hint for a future read-only retry.
      // No implicit retry: an in-flight write might already be committed.
      const retryHeader = response.headers.get("retry-after");
      const retrySeconds = retryHeader && /^\d{1,5}$/.test(retryHeader)
        ? Math.min(Number(retryHeader), 3600) : null;
      throw new Error("GitHub API " + response.status + " [" + kind + "]: " + message +
        (retrySeconds === null ? "" : " (retry-after " + retrySeconds + "s)"));
    }
    return body;
  }

  /** Verify the selected immutable source before a scoped mutation. The pin is
   * injected by server-owned admission; it is not accepted from GitHubAction. */
  private async verifyPinnedSource(repo: string, info: any, baseCommit: unknown): Promise<void> {
    if (!this.sourcePin) return;
    if (info?.full_name?.toLowerCase() !== this.sourcePin.repo || baseCommit !== this.sourcePin.commit)
      throw Error("GITHUB_SOURCE_IDENTITY_DIVERGENT");
    const record = await this.api("GET", "/repos/" + repo + "/commits/" + this.sourcePin.commit);
    assertGitHubSourceIdentity(this.sourcePin, {repo:info.full_name, baseCommit, commit:record?.sha, tree:record?.commit?.tree?.sha});
  }

  /**
   * Idempotent branch reservation for the supervisor. The agent-facing branch
   * action remains non-idempotent; this helper only accepts deterministic
   * supervisor branch names and never reuses a branch at a different commit.
   */
  async ensureSupervisorBranch(repoInput: string, branchInput: string): Promise<{
    repo: string; branch: string; source: string; sha: string; reused: boolean;
  }> {
    const repo = repoChecked(repoInput, this.allowed);
    const branch = branchChecked(branchInput);
    if (this.sourcePin) assertPinnedGitHubAction(this.sourcePin, {repo, operation:"branch", branch});
    if (!/^opencode\/(?:staging|supervised)-[a-f0-9]{16}$/.test(branch)) {
      throw new Error("Solo se aceptan ramas deterministas del supervisor");
    }
    const base = "/repos/" + repo;
    const info = await this.api("GET", base);
    const source = this.reviewedBase(repo, branch, info.default_branch);
    const from = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(source));
    const sha = from?.object?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error("Source branch commit is unverifiable");
    }
    if(this.pilotBase&&sha!==this.pilotBase.sha)throw Error("PILOT_SOURCE_SHA_CHANGED");
    await this.verifyPinnedSource(repo, info, sha);
    const ref = base + "/git/ref/heads/" + encodeURIComponent(branch);
    const existing = await this.api("GET", ref, undefined, true);
    if (existing) {
      if (existing.object?.sha !== sha) {
        throw new Error("La rama determinista ya existe con otra base; no se reutilizó");
      }
      return { repo, branch, source, sha, reused: true };
    }
    if (this.sourcePin && this.publicationGate?.withRefEffect) {
      const observed = await this.publicationGate.withRefEffect({repo,base:source,branch,operation:"branch",expected:null,target:sha},
        async () => {
          const created = await this.api("POST", base + "/git/refs", {ref:"refs/heads/"+branch,sha});
          if (created?.object?.sha !== sha) throw Error("GITHUB_BRANCH_EFFECT_UNKNOWN");
        }, async () => (await this.api("GET", ref, undefined, true))?.object?.sha ?? null);
      return {repo,branch,source,sha,reused:observed.reconciled};
    }
    try {
      const created = await this.api("POST", base + "/git/refs", {
        ref: "refs/heads/" + branch, sha
      });
      if (created?.object?.sha !== sha) throw new Error("GitHub creó la rama en un commit inesperado");
      return { repo, branch, source, sha, reused: false };
    } catch (error) {
      // A concurrent retry may have won the create race. Accept only the
      // exact source commit reserved above; never overwrite or force-update.
      if (this.sourcePin) {
        try {
          const observed = await this.api("GET", ref, undefined, true);
          if (observed?.object?.sha === sha) return { repo, branch, source, sha, reused: true };
        } catch { /* A failed read is not evidence of absence. */ }
        throw Error("GITHUB_BRANCH_EFFECT_UNKNOWN");
      }
      const raced = await this.api("GET", ref, undefined, true);
      if (raced?.object?.sha === sha) return { repo, branch, source, sha, reused: true };
      throw error;
    }
  }

  /**
   * Read-only source identity check for supervised read_only tasks. Every
   * request is a GET: no branch, ref, PR or review is created. When no pair is
   * supplied, the reviewed Staging base (OpenCode) or default branch is
   * resolved read-only and its Git tree is returned for the importer.
   */
  async resolveReadOnlySource(
    repoInput: string, sourceCommit?: string, sourceTree?: string
  ): Promise<{ repo: string; source: string; commit: string; tree: string }> {
    const repo = repoChecked(repoInput, this.allowed);
    if ((sourceCommit === undefined) !== (sourceTree === undefined)) {
      throw new Error("sourceCommit y sourceTree deben fijarse juntos");
    }
    if (sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(sourceCommit)) {
      throw new Error("Commit de origen inválido");
    }
    if (sourceTree !== undefined && !/^[a-f0-9]{40}$/.test(sourceTree)) {
      throw new Error("Árbol de origen inválido");
    }
    const base = "/repos/" + repo;
    const info = await this.api("GET", base, undefined, false, true);
    if (info?.full_name?.toLowerCase() !== repo.toLowerCase()) {
      throw new Error("GitHub devolvió datos de repositorio inválidos");
    }
    let source: string;
    let commit: string;
    if (sourceCommit !== undefined) {
      source = "pinned";
      commit = sourceCommit;
    } else {
      source = repo.toLowerCase() === OPENCODE_REPO.toLowerCase()
        ? OPENCODE_STAGING_BASE : info.default_branch;
      if (typeof source !== "string" || !source) {
        throw new Error("No se pudo identificar la base de solo lectura");
      }
      const ref = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(source), undefined, false, true);
      const sha = ref?.object?.sha;
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error("Source branch commit is unverifiable");
      }
      commit = sha.toLowerCase();
    }
    const record = await this.api("GET", base + "/commits/" + commit, undefined, true, true);
    if (!record) throw new Error("El commit de origen no existe en el repositorio autorizado");
    const sha = record?.sha;
    const tree = record?.commit?.tree?.sha;
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha) || sha.toLowerCase() !== commit) {
      throw new Error("GitHub no confirmó el commit de origen solicitado");
    }
    if (typeof tree !== "string" || !/^[a-f0-9]{40}$/.test(tree)) {
      throw new Error("GitHub no devolvió un árbol verificable");
    }
    if (sourceTree !== undefined && tree.toLowerCase() !== sourceTree) {
      throw new Error("El árbol de origen no coincide con el commit verificado");
    }
    return { repo, source, commit, tree: tree.toLowerCase() };
  }

  private async replaceExact(
    repo: string,
    path: string,
    safePath: string,
    branch: string,
    expectedHead: string,
    oldText: string,
    newText: string,
    message?: string
  ): Promise<unknown> {
    if (repo.toLowerCase() !== OPENCODE_REPO.toLowerCase() || !STAGING_REVIEW.test(branch)) {
      throw new Error("Bounded replacement is limited to OpenCode Staging review branches");
    }
    if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
      throw new Error("Expected branch HEAD must be a full Git commit SHA");
    }
    if (typeof oldText !== "string" || !oldText || oldText.length > MAX_REPLACEMENT_TEXT_BYTES ||
        typeof newText !== "string" || newText.length > MAX_REPLACEMENT_TEXT_BYTES ||
        new TextEncoder().encode(oldText).byteLength > MAX_REPLACEMENT_TEXT_BYTES ||
        new TextEncoder().encode(newText).byteLength > MAX_REPLACEMENT_TEXT_BYTES) {
      throw new Error("Old text must be non-empty, and each fragment must be at most 8192 bytes");
    }

    const base = "/repos/" + repo;
    const ref = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(branch));
    if (ref.object?.sha !== expectedHead) {
      throw new Error("GitHub branch HEAD changed; review the current branch before replacing text");
    }
    const file = await this.api("GET",
      base + "/contents/" + safePath + "?ref=" + encodeURIComponent(expectedHead));
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" ||
        !Number.isSafeInteger(file.size) || file.size > MAX_REPLACEMENT_FILE_BYTES) {
      throw new Error("Replacement target must be a text file no larger than 128000 bytes");
    }
    let source: string;
    let sourceBytes: Uint8Array;
    try {
      const binary = atob(file.content.replace(/\s/g, ""));
      sourceBytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    } catch {
      throw new Error("Replacement target must be valid UTF-8 text");
    }
    if (sourceBytes.byteLength > MAX_REPLACEMENT_FILE_BYTES) {
      throw new Error("Replacement target must be a text file no larger than 128000 bytes");
    }
    const first = source.indexOf(oldText);
    if (first < 0) throw new Error("Replacement anchor was not found");
    if (source.indexOf(oldText, first + 1) >= 0) {
      throw new Error("Replacement anchor must match exactly once");
    }
    const updated = source.slice(0, first) + newText + source.slice(first + oldText.length);
    if (new TextEncoder().encode(updated).byteLength > MAX_REPLACEMENT_FILE_BYTES) {
      throw new Error("Updated replacement target would exceed 128000 bytes");
    }

    const parent = await this.api("GET", base + "/git/commits/" + expectedHead);
    // GitHub REST GET /git/commits/{sha} returns tree at the root.
    const baseTree = parent?.tree?.sha;
    if (typeof baseTree !== "string" || !/^[0-9a-f]{40}$/.test(baseTree)) {
      throw new Error("GitHub could not verify the expected commit tree");
    }
    let fileTree = baseTree;
    let mode: "100644" | "100755" | undefined;
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index++) {
      const tree = await this.api("GET", base + "/git/trees/" + fileTree);
      if (!Array.isArray(tree.tree)) throw new Error("GitHub could not verify the replacement target path");
      const entry = tree.tree.find((item: any) => item.path === segments[index]);
      if (!entry) throw new Error("Replacement target is not present in the expected commit tree");
      if (index === segments.length - 1) {
        if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
          throw new Error("Replacement target must be a regular file");
        }
        mode = entry.mode;
      } else {
        if (entry.type !== "tree" || typeof entry.sha !== "string" || !/^[0-9a-f]{40}$/.test(entry.sha)) {
          throw new Error("GitHub could not verify the replacement target path");
        }
        fileTree = entry.sha;
      }
    }
    if (!mode) throw new Error("GitHub could not verify the replacement target mode");
    const blob = await this.api("POST", base + "/git/blobs", { content: updated, encoding: "utf-8" });
    if (typeof blob.sha !== "string" || !/^[0-9a-f]{40}$/.test(blob.sha)) {
      throw new Error("GitHub did not return a valid replacement blob");
    }
    const tree = await this.api("POST", base + "/git/trees", {
      base_tree: baseTree,
      tree: [{ path, mode, type: "blob", sha: blob.sha }]
    });
    if (typeof tree.sha !== "string" || !/^[0-9a-f]{40}$/.test(tree.sha)) {
      throw new Error("GitHub did not return a valid replacement tree");
    }
    const commit = await this.api("POST", base + "/git/commits", {
      message: (message || "fix: replace text from OpenCode").slice(0, 150),
      tree: tree.sha,
      parents: [expectedHead]
    });
    if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) {
      throw new Error("GitHub did not return a valid replacement commit");
    }
    const updateRoute = base + "/git/refs/heads/" + encodeURIComponent(branch);
    if (this.sourcePin) {
      const verify = await this.api("GET", base + "/git/commits/" + commit.sha);
      if (verify?.sha !== commit.sha || verify?.tree?.sha !== tree.sha ||
          !Array.isArray(verify.parents) || verify.parents.length !== 1 || verify.parents[0]?.sha !== expectedHead)
        throw Error("GITHUB_COMMIT_PROOF_INVALID");
      if (!this.publicationGate?.withRefEffect) throw Error("GITHUB_PINNED_EFFECT_COORDINATOR_REQUIRED");
      const outcome = await this.publicationGate.withRefEffect({
        repo,base:this.sourcePin.base,branch,operation:"write",expected:expectedHead,target:commit.sha
      }, async () => {
        const current = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(branch));
        if (current?.object?.sha !== expectedHead) throw Error("GITHUB_REF_CAS_CONFLICT");
        const result = await this.api("PATCH",updateRoute,{sha:commit.sha,force:false});
        if (result?.object?.sha !== commit.sha) throw Error("GITHUB_REF_UPDATE_UNKNOWN");
      }, async () => (await this.api("GET",base+"/git/ref/heads/"+encodeURIComponent(branch)))?.object?.sha ?? null);
      return {repo,branch,path,commitSha:commit.sha,fileSha:blob.sha,expectedHead,mode:"replacement",reconciled:outcome.reconciled};
    }
    let updatedRef: any;
    try {
      updatedRef = await this.api("PATCH", updateRoute, { sha: commit.sha, force: false });
    } catch {
      // A lost response is not permission to replay PATCH. Reconcile read-only.
      let observed: any;
      try { observed = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(branch)); }
      catch { throw new Error("GITHUB_REF_UPDATE_UNKNOWN: readback failed; no retry"); }
      if (observed?.object?.sha !== commit.sha)
        throw new Error("GITHUB_REF_UPDATE_UNKNOWN: exact commit not confirmed; no retry");
      return { repo, branch, path, commitSha: commit.sha, fileSha: blob.sha,
        expectedHead, mode: "replacement", reconciled: true };
    }
    if (updatedRef.object?.sha !== commit.sha) {
      throw new Error("GitHub did not confirm the replacement branch HEAD");
    }
    return { repo, branch, path, commitSha: commit.sha, fileSha: blob.sha, expectedHead, mode: "replacement" };
  }

  async execute(input: GitHubAction): Promise<unknown> {
    const repo = repoChecked(input.repo, this.allowed);
    const base = "/repos/" + repo;
    if (this.sourcePin) {
      assertPinnedGitHubAction(this.sourcePin, {...input, operation:input.action});
      if (["branch","write","pr"].includes(input.action) && !this.publicationGate?.withRefEffect)
        throw Error("GITHUB_PINNED_EFFECT_COORDINATOR_REQUIRED");
      if (input.action === "branch") {
        const result = await this.ensureSupervisorBranch(repo, input.branch);
        return {...result, ref:"refs/heads/" + result.branch};
      }
      if (input.action === "write" || input.action === "pr") {
        const info = await this.api("GET", base);
        const from = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(this.sourcePin.base));
        await this.verifyPinnedSource(repo, info, from?.object?.sha);
      }
    }
    switch (input.action) {
      case "repo": {
        const info = await this.api("GET", base);
        return { name: info.full_name, defaultBranch: info.default_branch, private: info.private };
      }
      case "read": {
        const safePath = pathChecked(input.path);
        const suffix = input.ref ? "?ref=" + encodeURIComponent(input.ref) : "";
        const file = await this.api("GET", base + "/contents/" + safePath + suffix);
        if (file.type !== "file" || file.encoding !== "base64" ||
            typeof file.content !== "string") {
          throw new Error("GitHub resource is not a readable text file");
        }
        if (file.size > MAX_FILE_BYTES) throw new Error("File is larger than 100KB");
        return { repo, path: input.path, sha: file.sha, ref: input.ref || "default", content: fromBase64(file.content) };
      }
      case "pr_search": {
        if (typeof input.query !== "string") throw new Error("Invalid PR discovery query");
        if (/[\r\n\t]/.test(input.query)) throw new Error("Invalid PR discovery query");
        const query = input.query.trim().replace(/\s+/g, " ");
        if (query.length < 2 || query.length > 100 ||
            !/^[\p{L}\p{N} _./#-]+$/u.test(query) ||
            /(?:^|\s)(?:OR|AND|NOT)(?:\s|$)/i.test(query)) {
          throw new Error("Invalid PR discovery query");
        }
        const page = input.page === undefined ? 1 : positiveNumber(input.page, "page", 10);
        const limit = 20;
        // Always scope on the server; never trust a model-provided repository.
        const scoped = "repo:" + repo + " is:pr " + query;
        const results = await this.api("GET", "/search/issues?q=" +
          encodeURIComponent(scoped) + "&per_page=" + limit + "&page=" + page);
        if (!Array.isArray(results?.items) ||
            !Number.isSafeInteger(results.total_count) || results.total_count < 0) {
          throw new Error("Invalid GitHub search response");
        }
        const expected = "/repos/" + repo.toLowerCase();
        const matches = results.items.map((item: any) => {
          if (typeof item?.repository_url !== "string") {
            throw new Error("GitHub PR search missing repository provenance");
          }
          const source = new URL(item.repository_url);
          if (source.hostname !== "api.github.com" ||
              source.pathname.toLowerCase() !== expected ||
              !Number.isSafeInteger(item.number) || !item.pull_request) {
            throw new Error("GitHub PR search returned out-of-scope result");
          }
          return {number: item.number, title: item.title, url: item.html_url,
            state: item.state, updatedAt: item.updated_at};
        });
        return {repo, query, page, matches, totalCount: results.total_count,
          incomplete: Boolean(results.incomplete_results),
          possibleNextPage: page < 10 && page * limit < results.total_count &&
            matches.length === limit ? page + 1 : null,
          source: "SEARCH_INDEX_VERIFY_WITH_PR_INFO"};
      }
      case "pr_info": {
        const number = positiveNumber(input.number, "PR number");
        const pr = await this.api("GET", base + "/pulls/" + number);
        return {
          repo, number, url: pr.html_url, title: pr.title, state: pr.state,
          draft: Boolean(pr.draft), merged: Boolean(pr.merged_at),
          base: pr.base?.ref, baseSha: pr.base?.sha,
          head: pr.head?.ref, headSha: pr.head?.sha,
          mergeable: pr.mergeable ?? null,
          updatedAt: pr.updated_at
        };
      }
      case "issue_info": {
        const number = positiveNumber(input.number, "issue number");
        const issue = await this.api("GET", base + "/issues/" + number);
        return {
          repo, number, url: issue.html_url, title: issue.title,
          state: issue.state, stateReason: issue.state_reason ?? null,
          isPullRequest: Boolean(issue.pull_request),
          updatedAt: issue.updated_at, comments: issue.comments ?? 0
        };
      }
      case "pr_files": {
        const number = positiveNumber(input.number, "PR number");
        const page = input.page === undefined ? 1 : positiveNumber(input.page, "page", 100);
        const files = await this.api("GET", base + "/pulls/" + number +
          "/files?per_page=100&page=" + page);
        if (!Array.isArray(files)) throw new Error("Invalid GitHub PR files response");
        return {
          repo, number, page,
          files: files.map((f: any) => ({
            path: f.filename, status: f.status,
            additions: f.additions, deletions: f.deletions,
            sha: f.sha
          })),
          possibleNextPage: files.length === 100 ? page + 1 : null
        };
      }
      case "pr_reviews": {
        const number = positiveNumber(input.number, "PR number");
        const page = input.page === undefined ? 1 : positiveNumber(input.page, "page", 100);
        const reviews = await this.api("GET", base + "/pulls/" + number +
          "/reviews?per_page=100&page=" + page);
        if (!Array.isArray(reviews)) throw new Error("Invalid GitHub PR reviews response");
        return {
          repo, number, page,
          reviews: reviews.map((r: any) => ({
            id: r.id, state: r.state, author: r.user?.login,
            commitSha: r.commit_id, submittedAt: r.submitted_at
          })),
          possibleNextPage: reviews.length === 100 ? page + 1 : null
        };
      }
      case "pr_checks": {
        const sha = shaChecked(input.sha);
        // Fine-grained GitHub tokens often grant commit statuses but not Checks.
        // Keep the two independent evidence sources separate instead of
        // failing the entire read because one optional source returned 403.
        const [checksResult, statusResult] = await Promise.allSettled([
          this.api("GET", base + "/commits/" + sha + "/check-runs?per_page=100"),
          this.api("GET", base + "/commits/" + sha + "/status")
        ]);
        if (checksResult.status === "rejected" && statusResult.status === "rejected") {
          throw statusResult.reason;
        }
        const checks = checksResult.status === "fulfilled" ? checksResult.value : null;
        const status = statusResult.status === "fulfilled" ? statusResult.value : null;
        if (checks !== null && !Array.isArray(checks?.check_runs)) {
          throw new Error("Invalid GitHub check-runs response");
        }
        if (status !== null && !Array.isArray(status?.statuses)) {
          throw new Error("Invalid GitHub commit-status response");
        }
        const reasonClass = (reason: unknown): string => {
          const message = reason instanceof Error ? reason.message : String(reason);
          return /\[(GITHUB_[A-Z_]+)\]/.exec(message)?.[1] ?? "GITHUB_READ_FAILED";
        };
        return {
          repo, sha, combinedStatus: status?.state ?? null,
          checkRuns: (checks?.check_runs ?? []).map((r: any) => ({
            name: r.name, status: r.status, conclusion: r.conclusion,
            detailsUrl: r.html_url, completedAt: r.completed_at
          })),
          statuses: (status?.statuses ?? []).map((r: any) => ({
            context: r.context, state: r.state, targetUrl: r.target_url
          })),
          checksMayBeTruncated: checks === null ? null : checks.total_count > checks.check_runs.length,
          partial: checks === null || status === null,
          sources: {
            checkRuns: checks === null
              ? { available: false, errorClass: reasonClass((checksResult as PromiseRejectedResult).reason) }
              : { available: true },
            commitStatuses: status === null
              ? { available: false, errorClass: reasonClass((statusResult as PromiseRejectedResult).reason) }
              : { available: true }
          }
        };
      }
      case "branch": {
        const branch = branchChecked(input.branch);
        const info = await this.api("GET", base);
        const source = this.reviewedBase(repo, branch, info.default_branch);
        const from = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(source));
        if (typeof from?.object?.sha !== "string" || !/^[0-9a-f]{40}$/.test(from.object.sha)) {
          throw new Error("Source branch commit is unverifiable");
        }
        const created = await this.api("POST", base + "/git/refs", {
          ref: "refs/heads/" + branch, sha: from.object.sha
        });
        return { repo, branch, source, ref: created.ref, sha: created.object.sha };
      }
      case "write": {
        const branch = branchChecked(input.branch);
        const safePath = pathChecked(input.path);
        assertNonCanonicalWrite(repo, input.path);
        if ("expectedHead" in input || "oldText" in input || "newText" in input) {
          if (!("expectedHead" in input) || !("oldText" in input) || !("newText" in input) || "content" in input) {
            throw new Error("Choose full content or a complete bounded replacement, not both");
          }
          return this.replaceExact(repo, input.path, safePath, branch,
            input.expectedHead, input.oldText, input.newText, input.message);
        }
        // The legacy Contents PUT cannot CAS the branch tip. Pinned tasks use
        // bounded replacement until M08 exposes a full-content expected-head schema.
        if (this.sourcePin) throw Error("GITHUB_PINNED_WRITE_EXPECTED_HEAD_REQUIRED");
        if (typeof input.content !== "string") throw new Error("File content must be plain text");
        const current = await this.api("GET", base + "/contents/" + safePath + "?ref=" + encodeURIComponent(branch), undefined, true);
        // An interrupted PUT can commit remotely even when its response is lost.
        // Reconcile the exact content before retrying to avoid duplicate commits.
        // This never bypasses the branch, repository or protected-path checks.
        if (current?.type === "file" && current.encoding === "base64" &&
            typeof current.content === "string" && current.size <= MAX_FILE_BYTES &&
            fromBase64(current.content) === input.content) {
          return { repo, branch, path: input.path, commitSha: null,
            fileSha: current.sha, unchanged: true, reconciled: true };
        }
        const result = await this.api("PUT", base + "/contents/" + safePath, {
          message: (input.message || "chore: update from OpenCode").slice(0, 150),
          content: toBase64(input.content),
          branch,
          ...(current?.sha ? { sha: current.sha } : {})
        });
        return { repo, branch, path: input.path, commitSha: result.commit?.sha, fileSha: result.content?.sha };
      }
      case "review": {
        const branch = branchChecked(input.branch);
        const info = await this.api("GET", base);
        const source = this.reviewedBase(repo, branch, info.default_branch);
        const comparison = await this.api("GET", base + "/compare/" +
          encodeURIComponent(source) + "..." + encodeURIComponent(branch));
        const files = Array.isArray(comparison.files) ? comparison.files : [];
        // GitHub truncates large comparisons. Never claim a complete review
        // when it returns more than the bounded safe set.
        return {
          repo, branch, base: source,
          aheadBy: comparison.ahead_by,
          behindBy: comparison.behind_by,
          totalCommits: comparison.total_commits,
          truncated: files.length >= 300,
          files: files.slice(0, 300).map((item: any) => ({
            path: item.filename,
            status: item.status,
            additions: item.additions,
            deletions: item.deletions
          }))
        };
      }
      case "pr": {
        const branch = branchChecked(input.branch);
        // Every supervised Staging draft must use one durable publication
        // authority. Legacy/uncoordinated writers fail closed for this scope.
        if (repo.toLowerCase() === OPENCODE_REPO.toLowerCase() &&
            STAGING_REVIEW.test(branch) && !this.publicationGate)
          throw new Error("PR_PUBLICATION_COORDINATOR_REQUIRED");
        if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 160) {
          throw new Error("Pull request title must be between 1 and 160 characters");
        }
        const info = await this.api("GET", base);
        const source = this.reviewedBase(repo, branch, info.default_branch);
        const desiredBody = (input.body || "").slice(0, 5000);
        const attempt = async (permit?: GitHubPrPublicationPermit): Promise<unknown> => {
        // Automatic fail-closed preflight at the *actual agent PR creation*
        // boundary, not merely advisory instructions in AGENTS.md. GitHub's
        // native branch rules remain responsible for enforcing external merges.
        const getHead = async (ref: string): Promise<string> => {
          const raw = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(ref));
          const sha = raw?.object?.sha;
          if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha))
            throw new Error("PR_PREFLIGHT_INCOMPLETE: unverifiable branch SHA");
          return sha.toLowerCase();
        };
        const [baseSha, headSha] = await Promise.all([getHead(source), getHead(branch)]);
        if(this.pilotBase&&baseSha!==this.pilotBase.sha)throw Error("PILOT_SOURCE_SHA_CHANGED");
        if(this.sourcePin&&baseSha!==this.sourcePin.commit)throw Error("GITHUB_SOURCE_IDENTITY_DIVERGENT");
        // A lost POST response must never be reconciled against a DIFFERENT
        // branch HEAD, even if the branch, PR title and body have not changed.
        if (permit?.retryOnly &&
            (permit.expectedProof?.baseSha !== baseSha ||
             permit.expectedProof?.headSha !== headSha))
          throw new Error("PR_PUBLICATION_HEAD_CHANGED: original commit proof does not match current refs");
        const comparison = await this.api("GET", base + "/compare/" +
          encodeURIComponent(this.sourcePin ? baseSha : source) + "..." + encodeURIComponent(this.sourcePin ? headSha : branch));
        if (this.sourcePin && (comparison?.merge_base_commit?.sha !== baseSha || comparison?.behind_by !== 0))
          throw Error("GITHUB_SOURCE_ANCESTRY_DIVERGENT");
        if (!Array.isArray(comparison?.files) || comparison.files.length === 0 ||
            comparison.files.length >= 300 ||
            !Number.isSafeInteger(comparison.total_commits) ||
            comparison.total_commits > 250 ||
            !Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by < 1) {
          throw new Error("PR_PREFLIGHT_INCOMPLETE: base comparison missing or truncated");
        }
        const pathsOf = (items: any[]): Set<string> => {
          const paths = new Set<string>();
          for (const file of items) {
            if (!file || typeof file.filename !== "string" || !file.filename.trim())
              throw new Error("PR_PREFLIGHT_INCOMPLETE: malformed changed filename");
            paths.add(file.filename);
            if (file.status === "renamed") {
              if (typeof file.previous_filename !== "string" || !file.previous_filename.trim())
                throw new Error("PR_PREFLIGHT_INCOMPLETE: renamed file missing prior path");
              paths.add(file.previous_filename);
            }
          }
          return paths;
        };
        const ourPaths = pathsOf(comparison.files);
        if (this.sourcePin) for (const path of ourPaths) {
          assertPinnedGitHubAction(this.sourcePin,{repo,operation:"write",branch,path});
          assertNonCanonicalWrite(repo,path);
        }
        const existing = await this.api("GET", base + "/pulls?state=open&base=" +
          encodeURIComponent(source) + "&per_page=100&page=1");
        if (!Array.isArray(existing) || existing.length >= 100)
          throw new Error("PR_PREFLIGHT_INCOMPLETE: open PR list missing or truncated");

        let matchingDraft: any;
        for (const item of existing) {
          if (!Number.isSafeInteger(item?.number) || item.number < 1 ||
              item?.base?.ref !== source || typeof item?.head?.ref !== "string")
            throw new Error("PR_PREFLIGHT_INCOMPLETE: untrusted PR identity");
          if (item.head.ref === branch) {
            // A previous POST may have created the PR even if its HTTP reply
            // was lost. Reconcile only the identical reviewed intent; never
            // mistake an unrelated PR or fork for the requested operation.
            const exactIntent = item.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase() &&
              item.head?.sha?.toLowerCase() === headSha &&
              item.base?.sha?.toLowerCase() === baseSha &&
              item.title === input.title &&
              (item.body ?? "") === desiredBody &&
              item.draft === true &&
              typeof item.html_url === "string" && item.html_url.length > 0;
            if (exactIntent) {
              if (matchingDraft) throw Error("PR_DUPLICATE_DRAFT");
              matchingDraft = item;
              continue;
            }
            throw new Error("PR_ALREADY_OPEN: same branch with different or unverifiable intent");
          }
        }
        if (matchingDraft) {
          const [b,h] = await Promise.all([getHead(source),getHead(branch)]);
          if (b!==baseSha || h!==headSha) throw Error("PR_PREFLIGHT_STALE");
          // Record the exact observed proof before adopting a preexisting draft.
          // No external mutation follows this marker.
          if (permit && !permit.retryOnly) await permit.beginExternalEffect({baseSha,headSha});
          return {repo,number:matchingDraft.number,url:matchingDraft.html_url,draft:true,
            base:source,head:branch,baseSha,headSha,reconciled:true};
        }
        // Only a bounded batch of GitHub diffs enters memory at any time.
        for (let index = 0; index < existing.length; index += 5) {
          const batch = existing.slice(index, index + 5);
          const inspected = await Promise.all(batch.map(async (item: any) => {
            const files = await this.api("GET", base + "/pulls/" + item.number +
              "/files?per_page=100&page=1");
            if (!Array.isArray(files) || files.length >= 100)
              throw new Error("PR_PREFLIGHT_INCOMPLETE: competitor changed files truncated");
            const competitors = pathsOf(files);
            return { number: item.number,
              collision: [...ourPaths].filter(path => competitors.has(path)).sort() };
          }));
          const conflict = inspected.find(item => item.collision.length);
          if (conflict) {
            throw new Error("PR_WRITE_SCOPE_CONFLICT: PR #" + conflict.number +
              " overlaps " + conflict.collision.slice(0, 5).join(", ").slice(0, 330));
          }
        }
        // A concurrent push changing either tip invalidates this review.
        const [baseShaNow, headShaNow] = await Promise.all([getHead(source), getHead(branch)]);
        if (baseShaNow !== baseSha || headShaNow !== headSha)
          throw new Error("PR_PREFLIGHT_STALE: branch moved during collision preflight");
        if (permit?.retryOnly) throw new Error("PR_PUBLISH_UNKNOWN: same intent previously attempted; no second POST");
        if (permit) await permit.beginExternalEffect({ baseSha, headSha });
        const created = await this.api("POST", base + "/pulls", {
          title: input.title, body: desiredBody,
          head: branch, base: source, draft: true
        });
        // GitHub PR creation targets a BRANCH, not an immutable commit. A
        // competing external push between final GET and POST can change what
        // GitHub actually published. Only the returned PR SHA can confirm it.
        if (permit && (created?.head?.ref !== branch || created?.base?.ref !== source ||
                       created?.head?.sha?.toLowerCase() !== headSha ||
                       created?.base?.sha?.toLowerCase() !== baseSha))
          throw new Error("PR_PUBLICATION_HEAD_CHANGED: PR response does not confirm the reviewed commit");
        return { repo, number: created.number, url: created.html_url, draft: created.draft,
          base: source, head: branch, baseSha, headSha };
        };
        return this.publicationGate
          ? this.publicationGate.withExclusive({ repo, base: source, branch, title: input.title, body: desiredBody }, attempt)
          : attempt();
      }
      default:
        throw new Error("Unsupported GitHub action");
    }
  }
}

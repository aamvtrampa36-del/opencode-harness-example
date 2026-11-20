/**
 * Native GitHub REST bridge for OpenCode Cloud.
 * The token is held only by Cloudflare Worker Secrets, NEVER inside the Linux
 * container, model prompts, client bundles or Git clone URLs.
 *
 * Deliberately narrow: a small allowlist of the owner's repositories, and
 * writes ONLY to opencode/* review branches. No merging, force-push, deletion,
 * releases or production deployments.
 */
export const ALLOWED_REPOS = [
  "aamvtrampa36-del/cdf-cloud-engine",
  "aamvtrampa36-del/CDF-WorkBench-",
  "aamvtrampa36-del/opencode-harness-example"
] as const;

export type GitHubAction =
  | { action: "repo"; repo: string }
  | { action: "read"; repo: string; path: string; ref?: string }
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
export const OPENCODE_STAGING_BASE = "staging/opencode-g1-20261118";
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
      /(?:^|\/)(?:\.env|\.dev\.vars|wrangler(?:\.[a-z0-9_-]+)?\.(?:toml|jsonc?))(?:$|\/)/.test(lower)) {
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

export class GitHubBridge {
  private readonly allowed: ReadonlySet<string>;
  constructor(
    private readonly token: string,
    private readonly http: GitHubFetch = fetch,
    allowedRepos: readonly string[] = ALLOWED_REPOS
  ) {
    if (!token) throw new Error("GITHUB_TOKEN is not configured in Cloudflare Secrets");
    this.allowed = new Set(allowedRepos.map(normalizeOwnedRepository));
  }

  private async api(method: string, route: string, data?: unknown, allow404 = false): Promise<any> {
    const response = await this.http("https://api.github.com" + route, {
      method,
      headers: {
        "Authorization": "Bearer " + this.token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpenCode-Cloud"
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    if (response.status === 404 && allow404) return null;
    const body = await response.json() as any;
    if (!response.ok) {
      const message = typeof body?.message === "string" ? body.message.slice(0, 250) : "API request failed";
      throw new Error("GitHub API " + response.status + ": " + message);
    }
    return body;
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
    if (!/^opencode\/(?:staging|supervised)-[a-f0-9]{16}$/.test(branch)) {
      throw new Error("Solo se aceptan ramas deterministas del supervisor");
    }
    const base = "/repos/" + repo;
    const info = await this.api("GET", base);
    const source = reviewedBase(repo, branch, info.default_branch);
    const from = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(source));
    const sha = from?.object?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error("Source branch commit is unverifiable");
    }
    const ref = base + "/git/ref/heads/" + encodeURIComponent(branch);
    const existing = await this.api("GET", ref, undefined, true);
    if (existing) {
      if (existing.object?.sha !== sha) {
        throw new Error("La rama determinista ya existe con otra base; no se reutilizó");
      }
      return { repo, branch, source, sha, reused: true };
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
      const raced = await this.api("GET", ref, undefined, true);
      if (raced?.object?.sha === sha) return { repo, branch, source, sha, reused: true };
      throw error;
    }
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
    if (!/^[0-9a-f]{40}$/.test(expectedHead)) throw new Error("Expected branch HEAD must be a full Git commit SHA");
    if (typeof oldText !== "string" || !oldText || oldText.length > MAX_REPLACEMENT_TEXT_BYTES ||
        new TextEncoder().encode(oldText).byteLength > MAX_REPLACEMENT_TEXT_BYTES ||
        typeof newText !== "string" || newText.length > MAX_REPLACEMENT_TEXT_BYTES ||
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
        typeof file.size !== "number" || file.size > MAX_REPLACEMENT_FILE_BYTES) {
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
    if (source.indexOf(oldText, first + oldText.length) >= 0) {
      throw new Error("Replacement anchor must match exactly once");
    }
    const updated = source.slice(0, first) + newText + source.slice(first + oldText.length);
    if (new TextEncoder().encode(updated).byteLength > MAX_REPLACEMENT_FILE_BYTES) {
      throw new Error("Updated replacement target would exceed 128000 bytes");
    }

    const parent = await this.api("GET", base + "/git/commits/" + expectedHead);
    const baseTree = parent.commit?.tree?.sha;
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
    const updatedRef = await this.api("PATCH",
      base + "/git/refs/heads/" + encodeURIComponent(branch), { sha: commit.sha, force: false });
    if (updatedRef.object?.sha !== commit.sha) {
      throw new Error("GitHub did not confirm the replacement branch HEAD");
    }
    return { repo, branch, path, commitSha: commit.sha, fileSha: blob.sha, expectedHead, mode: "replacement" };
  }

  async execute(input: GitHubAction): Promise<unknown> {
    const repo = repoChecked(input.repo, this.allowed);
    const base = "/repos/" + repo;
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
      case "branch": {
        const branch = branchChecked(input.branch);
        const info = await this.api("GET", base);
        const source = reviewedBase(repo, branch, info.default_branch);
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
        if (typeof input.content !== "string") throw new Error("File content must be plain text");
        const current = await this.api("GET", base + "/contents/" + safePath + "?ref=" + encodeURIComponent(branch), undefined, true);
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
        const source = reviewedBase(repo, branch, info.default_branch);
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
        if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 160) {
          throw new Error("Pull request title must be between 1 and 160 characters");
        }
        const info = await this.api("GET", base);
        const source = reviewedBase(repo, branch, info.default_branch);
        const created = await this.api("POST", base + "/pulls", {
          title: input.title, body: (input.body || "").slice(0, 5000),
          head: branch, base: source, draft: true
        });
        return { repo, number: created.number, url: created.html_url, draft: created.draft, base: source, head: branch };
      }
      default:
        throw new Error("Unsupported GitHub action");
    }
  }
}

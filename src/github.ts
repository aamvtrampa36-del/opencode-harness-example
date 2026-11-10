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
  | { action: "pr"; repo: string; branch: string; title: string; body?: string }
  | { action: "review"; repo: string; branch: string };

const BRANCH_RE = /^opencode\/[a-z0-9][a-z0-9._-]{0,59}$/;
const MAX_FILE_BYTES = 100_000;

const OWNER = "aamvtrampa36-del";
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
      /(?:^|\/)(?:\.env|\.dev\.vars|wrangler\.toml|wrangler\.jsonc?)(?:$|\/)/.test(lower)) {
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
        const from = await this.api("GET", base + "/git/ref/heads/" + encodeURIComponent(info.default_branch));
        const created = await this.api("POST", base + "/git/refs", {
          ref: "refs/heads/" + branch, sha: from.object.sha
        });
        return { repo, branch, ref: created.ref, sha: created.object.sha };
      }
      case "write": {
        const branch = branchChecked(input.branch);
        const safePath = pathChecked(input.path);
        assertNonCanonicalWrite(repo, input.path);
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
        const comparison = await this.api("GET", base + "/compare/" +
          encodeURIComponent(info.default_branch) + "..." + encodeURIComponent(branch));
        const files = Array.isArray(comparison.files) ? comparison.files : [];
        // GitHub truncates large comparisons. Never claim a complete review
        // when it returns more than the bounded safe set.
        return {
          repo, branch, base: info.default_branch,
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
        const created = await this.api("POST", base + "/pulls", {
          title: input.title, body: (input.body || "").slice(0, 5000),
          head: branch, base: info.default_branch, draft: true
        });
        return { repo, number: created.number, url: created.html_url, draft: created.draft, base: info.default_branch, head: branch };
      }
      default:
        throw new Error("Unsupported GitHub action");
    }
  }
}

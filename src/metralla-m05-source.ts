import { pilotFetchNoRedirect } from "./pilot-http";

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^aamvtrampa36-del\/[A-Za-z0-9_.-]{1,100}$/i;
const BRANCH = /^opencode\/(?:staging|supervised)-[a-f0-9]{16}$/;
const PATH = /^[A-Za-z0-9_./-]{1,180}$/;
const safePath = (path: string) => typeof path === "string" && PATH.test(path) &&
  path.split("/").every(p => p && p !== "." && p !== ".." && p.toLowerCase() !== ".git");
const baseRef = (ref: string) => typeof ref === "string" && /^[A-Za-z0-9_./-]{1,180}$/.test(ref) &&
  !ref.includes("..") && ref.split("/").every(p => p && !p.startsWith(".") && !p.endsWith(".lock") && !p.endsWith("."));

/** Server-owned input, obtained from fenced admission, never from tool arguments. */
export type GitHubSourcePin = Readonly<{
  repo: string; base: string; branch: string; commit: string; tree: string; paths: readonly string[];
}>;
export function freezeGitHubSourcePin(pin: GitHubSourcePin): GitHubSourcePin {
  if (!pin || typeof pin.repo !== "string" || !REPO.test(pin.repo) || /\/(?:\.|\.\.)$/.test(pin.repo) ||
      !baseRef(pin.base) || typeof pin.branch !== "string" || !BRANCH.test(pin.branch) || pin.base === pin.branch ||
      typeof pin.commit !== "string" || !SHA.test(pin.commit) || typeof pin.tree !== "string" || !SHA.test(pin.tree) ||
      !Array.isArray(pin.paths) || pin.paths.length > 256 || !pin.paths.every(safePath) ||
      new Set(pin.paths).size !== pin.paths.length) throw Error("GITHUB_SOURCE_PIN_INVALID");
  return Object.freeze({repo: pin.repo.toLowerCase(), base: pin.base, branch: pin.branch,
    commit: pin.commit, tree: pin.tree, paths: Object.freeze([...pin.paths])});
}
export function sameGitHubSourcePin(a: GitHubSourcePin, b: GitHubSourcePin): boolean {
  const x = freezeGitHubSourcePin(a), y = freezeGitHubSourcePin(b);
  return x.repo === y.repo && x.base === y.base && x.branch === y.branch && x.commit === y.commit &&
    x.tree === y.tree && x.paths.length === y.paths.length && x.paths.every(p => y.paths.includes(p));
}
export function assertPinnedGitHubAction(pin: GitHubSourcePin, action: {
  repo: string; operation?: string; branch?: string; ref?: string; path?: string;
}): void {
  const p = freezeGitHubSourcePin(pin);
  if (typeof action.repo !== "string" || action.repo.toLowerCase() !== p.repo) throw Error("GITHUB_SOURCE_SCOPE_REPO");
  if (action.operation === "branch" || action.operation === "pr" || action.operation === "review" || action.operation === "write") {
    if (action.branch !== p.branch) throw Error("GITHUB_SOURCE_SCOPE_BRANCH");
    if (action.operation === "write" && (!action.path || !safePath(action.path) || !p.paths.includes(action.path)))
      throw Error("GITHUB_SOURCE_SCOPE_PATH");
    return;
  }
  if (action.operation === "read") {
    if (action.ref !== p.commit && action.ref !== p.branch) throw Error("GITHUB_SOURCE_SCOPE_REF");
    if (!action.path || !safePath(action.path)) throw Error("GITHUB_SOURCE_SCOPE_PATH");
    return;
  }
  if (["repo", "pr_search", "pr_info", "issue_info", "pr_files", "pr_reviews", "pr_checks"].includes(action.operation ?? "") &&
      action.branch === undefined && action.ref === undefined) return;
  throw Error("GITHUB_SOURCE_SCOPE_OPERATION");
}
export function assertGitHubSourceIdentity(pin: GitHubSourcePin, observed: {
  repo: unknown; baseCommit: unknown; commit: unknown; tree: unknown;
}): void {
  const p = freezeGitHubSourcePin(pin);
  if (typeof observed.repo !== "string" || observed.repo.toLowerCase() !== p.repo ||
      observed.baseCommit !== p.commit || observed.commit !== p.commit || observed.tree !== p.tree)
    throw Error("GITHUB_SOURCE_IDENTITY_DIVERGENT");
}

/** All authenticated REST routes use the existing M04 transport; no replay. */
export async function githubRestNoRedirect(http: typeof fetch, input: string, init?: RequestInit): Promise<Response> {
  try { return await pilotFetchNoRedirect(http, input, init); }
  catch (error) {
    if (error instanceof Error && error.message === "PILOT_HTTP_REDIRECT_REFUSED")
      throw Error("GitHub source identity redirect refused");
    throw Error(init?.method && init.method !== "GET" ? "GITHUB_TRANSPORT_EFFECT_UNKNOWN" : "GITHUB_TRANSPORT_FAILED");
  }
}

/** GitHub archive REST is a distinct GET protocol: one verified codeload 302
 * handoff, same repo/format/commit, no account bearer at codeload, no second hop.
 * No 3xx is ever accepted as success. Never include Location in errors. */
export async function githubArchiveResponse(http: typeof fetch, repo: string, format: "tarball" | "zipball",
  headers: HeadersInit, signal: AbortSignal, commit?: string): Promise<Response> {
  if (!REPO.test(repo) || /\/(?:\.|\.\.)$/.test(repo) || (commit !== undefined && !SHA.test(commit)))
    throw Error("GITHUB_ARCHIVE_SOURCE_INVALID");
  let response: Response;
  try {
    response = await http("https://api.github.com/repos/" + repo + "/" + format + (commit ? "/" + commit : ""),
      {method: "GET", headers, redirect: "manual", signal});
  } catch { throw Error("No se pudo descargar el archivo de GitHub"); }
  if (response.redirected || response.type === "opaqueredirect" || response.status === 0) {
    void response.body?.cancel().catch(() => {}); throw Error("Redirección de archivo GitHub no autorizada");
  }
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get("Location");
  void response.body?.cancel().catch(() => {});
  let target: URL;
  try { target = new URL(location || ""); }
  catch { throw Error("Redirección de archivo GitHub no autorizada"); }
  const parts = target.pathname.split("/");
  const archiveTypes = format === "tarball" ? ["legacy.tar.gz", "tar.gz"] : ["legacy.zip", "zip"];
  if (response.status !== 302 || target.origin !== "https://codeload.github.com" || target.username || target.password || target.hash ||
      parts.length < 5 || parts.slice(1, 3).join("/").toLowerCase() !== repo.toLowerCase() ||
      !archiveTypes.includes(parts[3]) || !parts.slice(4).every(p => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== "..") ||
      (commit !== undefined && (parts.length !== 5 || parts[4] !== commit)))
    throw Error("Redirección de archivo GitHub no autorizada");
  try { return await githubRestNoRedirect(http, target.href, {method: "GET", headers: {"User-Agent": "OpenCode-Cloud"}, signal}); }
  catch { throw Error("No se pudo descargar el archivo temporal de GitHub"); }
}

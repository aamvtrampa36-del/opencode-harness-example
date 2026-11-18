/**
 * Single source of truth for the optional TokenEconomizer connector.
 *
 * The connector is a pinned, upstream Python hook (microsoft/TokenEconomizer) plus this
 * repository's OpenCode event adapter. It lives in its own Container and its state never
 * touches project files. This module is dependency-free on purpose: the Worker, the
 * connector Container and the unit tests all read the same pin, paths and environment.
 *
 * The adaptation is deliberately model-free. `envfacts` learns short environment facts from
 * recurring failures and makes no model or network calls; loop guarding, tool pruning and
 * repository maps stay off because this adapter does not provide their capabilities.
 */
export const TOKEN_ECONOMIZER_COMMIT = "7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0";
export const TOKEN_ECONOMIZER_REPOSITORY = "https://github.com/microsoft/TokenEconomizer.git";
export const TOKEN_ECONOMIZER_ROOT = "/workspace/projects/opencode-connectors/token-economizer";
export const TOKEN_ECONOMIZER_STATE = "/workspace/projects/opencode-connectors/state";
export const TOKEN_ECONOMIZER_WORKSPACES = "/workspace/projects/opencode-connectors/workspaces";

/** Events the connector Container accepts from the adapter; anything else is rejected. */
export const TOKEN_ECONOMIZER_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"
] as const;
export type TokenEconomizerEvent = typeof TOKEN_ECONOMIZER_EVENTS[number];

export function isTokenEconomizerEvent(value: string): value is TokenEconomizerEvent {
  return (TOKEN_ECONOMIZER_EVENTS as readonly string[]).includes(value);
}

/** The one transcript location the hook may write and read for a session. */
export function tokenEconomizerTranscriptPath(sessionID: string): string {
  return TOKEN_ECONOMIZER_STATE + "/opencode-sessions/" + sessionID + ".json";
}

/** Workspace the hook sees for a project; it only reads the checkout's environment. */
export function tokenEconomizerWorkspace(project: string): string {
  return TOKEN_ECONOMIZER_WORKSPACES + "/" + project;
}

/**
 * Environment for one hook call. It is built explicitly instead of inheriting the Container
 * environment, so no host credential, proxy or side-call switch reaches the hook. No value
 * here is a secret.
 */
export const TOKEN_ECONOMIZER_ENV: Readonly<Record<string, string>> = Object.freeze({
  PYTHONPATH: TOKEN_ECONOMIZER_ROOT,
  TE_CORE_PATH: TOKEN_ECONOMIZER_ROOT,
  TOKENECONOMIZER_HOME: TOKEN_ECONOMIZER_STATE,
  PYTHONUTF8: "1",
  TE_OPENCODE_MODE: "run",
  TE_MICROSKILLS: "envfacts",
  TE_LOOPGUARD: "off",
  TE_TOOLPRUNE: "off",
  TE_REPOMAP: "off"
});

/**
 * Dispatcher equivalent for this host: the official plugin's `te-hook` shell launcher needs
 * a POSIX path and writes the session export itself, while this adapter already has the
 * transcript in memory. The runner writes that transcript to the permitted path, calls the
 * same upstream entry point (`tokeneconomizer.plugin.hook.run`) with `host_hint="opencode"`,
 * hardens the state root, and prints exactly one JSON object. Any failure answers `{}`.
 */
export const TOKEN_ECONOMIZER_RUNNER = `import contextlib, json, os, sys
body = json.load(sys.stdin)
payload = body.get("payload") or {}
transcript = body.get("transcript")
path = payload.get("transcript_path")
if path and isinstance(transcript, str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as stream:
        stream.write(transcript)
try:
    from tokeneconomizer.plugin.hook import run
    with contextlib.redirect_stdout(sys.stderr):
        result = run(payload, os.environ, host_hint="opencode") or {}
    from tokeneconomizer.plugin.paths import secure_root
    secure_root(os.environ)
except Exception:
    result = {}
print(json.dumps(result, ensure_ascii=False))`;

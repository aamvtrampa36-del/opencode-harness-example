import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOKEN_ECONOMIZER_COMMIT, TOKEN_ECONOMIZER_ENV, TOKEN_ECONOMIZER_EVENTS,
  TOKEN_ECONOMIZER_REPOSITORY, TOKEN_ECONOMIZER_ROOT, TOKEN_ECONOMIZER_RUNNER,
  TOKEN_ECONOMIZER_STATE, TOKEN_ECONOMIZER_WORKSPACES,
  isTokenEconomizerEvent, tokenEconomizerTranscriptPath, tokenEconomizerWorkspace
} from "./token-economizer-contract";

const documentation = readFileSync(
  new URL("../docs/OPEN_CODE_EXTENSIONS_20261115.md", import.meta.url), "utf8"
);
const clonePresent = existsSync(join(TOKEN_ECONOMIZER_ROOT, "tokeneconomizer", "plugin", "hook.py"));
const python3 = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

describe("TokenEconomizer connector contract", () => {
  test("pins one full upstream commit and the documentation records the same pin", () => {
    expect(TOKEN_ECONOMIZER_COMMIT).toMatch(/^[a-f0-9]{40}$/);
    expect(documentation).toContain("`" + TOKEN_ECONOMIZER_COMMIT + "`");
    expect(TOKEN_ECONOMIZER_REPOSITORY).toBe("https://github.com/microsoft/TokenEconomizer.git");
  });

  test("keeps the hook state, workspaces and checkout in separate connector directories", () => {
    for (const path of [TOKEN_ECONOMIZER_ROOT, TOKEN_ECONOMIZER_STATE, TOKEN_ECONOMIZER_WORKSPACES]) {
      expect(path.startsWith("/workspace/projects/opencode-connectors/")).toBe(true);
    }
    expect(new Set([TOKEN_ECONOMIZER_ROOT, TOKEN_ECONOMIZER_STATE, TOKEN_ECONOMIZER_WORKSPACES]).size).toBe(3);
    expect(tokenEconomizerTranscriptPath("sesabc")).toBe(
      TOKEN_ECONOMIZER_STATE + "/opencode-sessions/sesabc.json"
    );
    expect(tokenEconomizerWorkspace("app-demo")).toBe(TOKEN_ECONOMIZER_WORKSPACES + "/app-demo");
  });

  test("enables only the model-free micro-skill and carries no credential", () => {
    expect(TOKEN_ECONOMIZER_ENV.TE_MICROSKILLS).toBe("envfacts");
    expect(TOKEN_ECONOMIZER_ENV.TE_LOOPGUARD).toBe("off");
    expect(TOKEN_ECONOMIZER_ENV.TE_TOOLPRUNE).toBe("off");
    expect(TOKEN_ECONOMIZER_ENV.TE_REPOMAP).toBe("off");
    expect(TOKEN_ECONOMIZER_ENV.TE_OPENCODE_MODE).toBe("run");
    expect(TOKEN_ECONOMIZER_ENV.PYTHONPATH).toBe(TOKEN_ECONOMIZER_ROOT);
    expect(TOKEN_ECONOMIZER_ENV.TOKENECONOMIZER_HOME).toBe(TOKEN_ECONOMIZER_STATE);
    const credentialNames = ["OPENROUTER_API_KEY", "GITHUB_TOKEN", "TE_SIDECALL", "TE_DISABLE",
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
    for (const key of Object.keys(TOKEN_ECONOMIZER_ENV)) {
      expect(credentialNames).not.toContain(key);
      expect(key).toMatch(/^[A-Z0-9_]+$/);
      expect(typeof TOKEN_ECONOMIZER_ENV[key]).toBe("string");
    }
    expect(Object.isFrozen(TOKEN_ECONOMIZER_ENV)).toBe(true);
  });

  test("accepts exactly the adapter's five events", () => {
    expect([...TOKEN_ECONOMIZER_EVENTS]).toEqual([
      "SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"
    ]);
    for (const name of TOKEN_ECONOMIZER_EVENTS) expect(isTokenEconomizerEvent(name)).toBe(true);
    for (const name of ["PreToolUse", "session.idle", "Sessionend", ""]) {
      expect(isTokenEconomizerEvent(name)).toBe(false);
    }
  });

  test("runner calls the official entry point, writes only the given transcript and fails open", () => {
    expect(TOKEN_ECONOMIZER_RUNNER).toContain("from tokeneconomizer.plugin.hook import run");
    expect(TOKEN_ECONOMIZER_RUNNER).toContain('host_hint="opencode"');
    expect(TOKEN_ECONOMIZER_RUNNER).toContain("from tokeneconomizer.plugin.paths import secure_root");
    expect(TOKEN_ECONOMIZER_RUNNER).toContain('payload.get("transcript_path")');
    expect(TOKEN_ECONOMIZER_RUNNER).toContain("except Exception:");
    for (const forbidden of ["urllib", "requests", "socket", "http://", "https://", "subprocess",
      "openai", "anthropic", "TE_SIDECALL"]) {
      expect(TOKEN_ECONOMIZER_RUNNER.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("the shipped installer and adapter still use these contract values", () => {
    const devContainer = readFileSync(new URL("./dev-container.ts", import.meta.url), "utf8");
    const adapter = readFileSync(new URL("./token-economizer-adapter.ts", import.meta.url), "utf8");
    expect(devContainer).toContain('TOKEN_ECONOMIZER_COMMIT = "' + TOKEN_ECONOMIZER_COMMIT + '"');
    expect(devContainer).toContain('TOKEN_ECONOMIZER_ROOT = "' + TOKEN_ECONOMIZER_ROOT + '"');
    expect(devContainer).toContain('TOKEN_ECONOMIZER_STATE = "' + TOKEN_ECONOMIZER_STATE + '"');
    expect(devContainer).toContain(TOKEN_ECONOMIZER_WORKSPACES);
    for (const [key, value] of Object.entries(TOKEN_ECONOMIZER_ENV)) {
      const spelling = value === TOKEN_ECONOMIZER_ROOT ? "TOKEN_ECONOMIZER_ROOT"
        : value === TOKEN_ECONOMIZER_STATE ? "TOKEN_ECONOMIZER_STATE" : "\"" + value + "\"";
      expect(devContainer).toContain(key + ": " + spelling);
    }
    for (const name of TOKEN_ECONOMIZER_EVENTS) expect(devContainer).toContain('"' + name + '"');
    const shippedRunner = /const TOKEN_ECONOMIZER_RUNNER = `([\s\S]*?)`;/.exec(devContainer)?.[1];
    expect(shippedRunner).toBeTruthy();
    expect(new Function("return `" + shippedRunner + "`;")()).toBe(TOKEN_ECONOMIZER_RUNNER);
    expect(adapter).toContain('import { tokenEconomizerWorkspace } from "./token-economizer-contract"');
    expect(adapter).toContain("tokenEconomizerWorkspace(project)");
    expect(adapter).not.toContain('"/workspace/projects/opencode-connectors/workspaces/"');
  });

  test.skipIf(!clonePresent || !python3)("the exact runner executes against the pinned checkout", () => {
    const home = mkdtempSync(join(tmpdir(), "te-contract-"));
    const workspace = join(home, "workspace");
    try {
      const result = spawnSync("python3", ["-c", TOKEN_ECONOMIZER_RUNNER], {
        input: JSON.stringify({ payload: {
          session_id: "ses" + "0".repeat(32), cwd: workspace,
          hook_event_name: "SessionStart", source: "startup"
        } }),
        encoding: "utf8",
        cwd: home,
        timeout: 20_000,
        env: { PATH: process.env.PATH ?? "", ...TOKEN_ECONOMIZER_ENV, TOKENECONOMIZER_HOME: join(home, "state") }
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toBeTypeOf("object");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

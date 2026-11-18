import { describe, expect, test } from "bun:test";
import { BUN_RUNTIME_VERSION, commandRequiresBun } from "./dev-runtime";

describe("managed Linux Bun runtime", () => {
  test("keeps Bun pinned to the package manager version", () => {
    expect(BUN_RUNTIME_VERSION).toBe("1.4.4");
  });

  test("detects explicit bun and bunx commands in shell chains", () => {
    expect(commandRequiresBun("bun --version")).toBe(true);
    expect(commandRequiresBun("npm test && bunx wrangler deploy --dry-run")).toBe(true);
    expect(commandRequiresBun("node check.mjs || bun run verify")).toBe(true);
  });

  test("does not install Bun when a command only mentions it as text", () => {
    expect(commandRequiresBun("printf 'bun --version'" )).toBe(false);
    expect(commandRequiresBun("node -e \"console.log('bun')\"")).toBe(false);
    expect(commandRequiresBun("npm test")).toBe(false);
  });
});

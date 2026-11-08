import { describe, expect, test } from "bun:test";
import { INSPECT_SOURCE, validateInspectionPath } from "./linux-inspect";

describe("read-only Linux file inspection", () => {
  test("accepts project-root listing and nested source files", () => {
    expect(validateInspectionPath("", "list")).toBe("");
    expect(validateInspectionPath("src", "list")).toBe("src");
    expect(validateInspectionPath("src/index.ts", "read")).toBe("src/index.ts");
  });
  test("rejects traversal, absolute paths, bad separators and sensitive files", () => {
    for (const value of [
      "../secret", "/etc/passwd", "src/../.env", "src//main.ts", "src\\secret",
      ".env", ".env.local", ".git/config", "node_modules/pkg/index.js",
      "keys/private.pem", "secrets.json", "config/credentials.json",
      "a".repeat(241)
    ]) {
      expect(() => validateInspectionPath(value, "read")).toThrow();
    }
    expect(() => validateInspectionPath("", "read")).toThrow();
  });
  test("uses a syntactically valid Node script and realpath symlink defense", () => {
    expect(() => new Function(INSPECT_SOURCE)).not.toThrow();
    expect(INSPECT_SOURCE).toContain("fs.realpathSync");
    expect(INSPECT_SOURCE).toContain("relativeParts");
    expect(INSPECT_SOURCE).toContain("Sensitive files are not readable");
    expect(INSPECT_SOURCE).not.toContain("writeFileSync");
    expect(INSPECT_SOURCE).not.toContain("execSync");
    expect(INSPECT_SOURCE).not.toContain("spawnSync");
  });
});

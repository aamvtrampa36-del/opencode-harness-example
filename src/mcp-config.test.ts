import { describe, expect, test } from "bun:test";
import { publicMcp, validateRemoteMcp } from "./mcp-config";

describe("remote MCP validation", () => {
  const base = { id: "my-tools", url: "https://example.com/mcp", enabled: true };
  test("preserve a public HTTPS endpoint", () => {
    const config = validateRemoteMcp(base);
    expect(config).toEqual({ ...base });
  });
  test("do not return bearer secrets to browser", () => {
    const cfg = validateRemoteMcp({ ...base, token: "private-token-example" });
    const publicValue = publicMcp(cfg);
    expect(publicValue.hasToken).toBe(true);
    expect(JSON.stringify(publicValue)).not.toContain("private-token-example");
  });
  test("reject direct access to local or private endpoints", () => {
    for (const url of [
      "http://example.com/mcp", "https://localhost/mcp",
      "https://host.local/mcp", "https://host.internal/mcp",
      "https://127.0.0.1/mcp", "https://192.168.1.2/mcp",
      "https://[::1]/mcp", "https://user:password@example.com/mcp",
      "https://example.com:8080/mcp", "https://example.com:8443/mcp"
    ]) {
      expect(() => validateRemoteMcp({ ...base, url })).toThrow();
    }
  });
  test("reject invalid profile identifiers, tokens, and flags", () => {
    expect(() => validateRemoteMcp({ ...base, id: "../secret" })).toThrow();
    expect(() => validateRemoteMcp({ ...base, enabled: "yes" })).toThrow();
    expect(() => validateRemoteMcp({ ...base, token: "secret\nheader" })).toThrow();
  });
});

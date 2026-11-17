import { describe, expect, test } from "bun:test";
import { isPersonalMemoryNote, validatePersonalMemoryContent } from "./personal-memory";

describe("explicit cross-session memory", () => {
  test("trims a small note and rejects empty, oversized, or credential-like content", () => {
    expect(validatePersonalMemoryContent("  Prefiero español.  ")).toBe("Prefiero español.");
    expect(() => validatePersonalMemoryContent("  ")).toThrow("no puede estar vacía");
    expect(() => validatePersonalMemoryContent("x".repeat(2_001))).toThrow("2000 caracteres");
    expect(() => validatePersonalMemoryContent("api_key: verysecretvalue12345")).toThrow("No guardes claves");
  });

  test("only accepts persisted notes with a stable UUID and timestamps", () => {
    expect(isPersonalMemoryNote({ id: "f2f96f1a-9c4a-47db-b865-089e3a27789b", content: "Nota", createdAt: 1, updatedAt: 2 })).toBe(true);
    expect(isPersonalMemoryNote({ id: "bad", content: "Nota", createdAt: 1, updatedAt: 2 })).toBe(false);
  });
});

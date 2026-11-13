import { describe, expect, test } from "bun:test";
import { readSessionMode, saveSessionMode } from "./session-mode";

describe("safe session mode", () => {
  test("an existing review session does not silently become build on reload", () => {
    const storage = { getItem: (key: string) => key === "opencode-session-mode:object-a:ses-one" ? "review" : null };
    expect(readSessionMode(storage, "object-a", "ses-one")).toBe("review");
  });

  test("unknown or invalid persisted modes fall back to review", () => {
    expect(readSessionMode({ getItem: () => null }, "a", "old")).toBe("review");
    expect(readSessionMode({ getItem: () => "invalid" }, "a", "old")).toBe("review");
  });

  test("switching workspace or conversation never inherits another mode", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    saveSessionMode(storage, "one", "ses-a", "build");
    saveSessionMode(storage, "one", "ses-b", "plan");
    expect(readSessionMode(storage, "one", "ses-a")).toBe("build");
    expect(readSessionMode(storage, "one", "ses-b")).toBe("plan");
    expect(readSessionMode(storage, "two", "ses-a")).toBe("review");
  });
});

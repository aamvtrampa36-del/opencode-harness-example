import { describe, expect, test } from "bun:test";
import { readSessionMode, saveSessionMode } from "./session-mode";

describe("general session defaults", () => {
  test("legacy persistent modes return to the general chat experience", () => {
    const storage = { getItem: (key: string) => key === "opencode-session-mode:object-a:ses-one" ? "review" : null };
    expect(readSessionMode(storage, "object-a", "ses-one")).toBe("build");
  });

  test("new sessions and invalid old values start in general build mode", () => {
    expect(readSessionMode({ getItem: () => null }, "a", "new")).toBe("build");
    expect(readSessionMode({ getItem: () => "invalid" }, "a", "old")).toBe("build");
  });

  test("saved mode values never turn a conversation into a persistent mode", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    saveSessionMode(storage, "one", "ses-a", "build");
    saveSessionMode(storage, "one", "ses-b", "plan");
    expect(readSessionMode(storage, "one", "ses-a")).toBe("build");
    expect(readSessionMode(storage, "one", "ses-b")).toBe("build");
    expect(readSessionMode(storage, "two", "ses-a")).toBe("build");
  });
});

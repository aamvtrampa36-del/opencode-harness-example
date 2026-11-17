import { describe, expect, test } from "bun:test";
import { readSessionSpecialization, saveSessionSpecialization } from "./session-specialization";

describe("per-conversation work templates", () => {
  test("a new conversation starts general and does not inherit another template", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }
    };
    saveSessionSpecialization(storage, "owner", "ses-a", "planificacion");
    expect(readSessionSpecialization(storage, "owner", "ses-a")).toBe("planificacion");
    expect(readSessionSpecialization(storage, "owner", "ses-b")).toBe("");
    expect(readSessionSpecialization(storage, "other-owner", "ses-a")).toBe("");
  });

  test("clearing a template leaves the conversation on the general option", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }
    };
    saveSessionSpecialization(storage, "owner", "ses-a", "planificacion");
    saveSessionSpecialization(storage, "owner", "ses-a", "");
    expect(readSessionSpecialization(storage, "owner", "ses-a")).toBe("");
  });
});

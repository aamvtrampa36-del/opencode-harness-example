import { describe, expect, test } from "bun:test";
import { checkIsolatedBackup } from "./isolated-backup-check";

describe("isolated backup proof", () => {
  test("requires source and restored files to agree", async () => {
    const names: string[] = [];
    let created = 0;
    const open = (name: string) => {
      const index = created++;
      names.push(name);
      return {
        run: async () => ({exitCode: 0}),
        saveBackup: async () => ({sha256: "a".repeat(64)}),
        downloadSavedBackup: async () => new Response("archive"),
        restoreExternalBackup: async (source: string, target: string) => ({
          source, target, sha256: "b".repeat(64)
        }),
        inspect: async () => ({contents: index === 0 ? "backup-check-v1" : "wrong"})
      };
    };
    await expect(checkIsolatedBackup(open, "1234567890ab")).rejects.toThrow("no conserva");
    expect(names[0]).not.toBe(names[1]);
  });
});

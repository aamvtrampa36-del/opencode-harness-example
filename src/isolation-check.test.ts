import { describe, expect, test } from "bun:test";
import { checkIsolation } from "./isolation-check";

describe("real isolation probe", () => {
  test("routes each synthetic project to its own container and validates all receipts", async () => {
    const opened: string[] = [];
    let i = 0;
    const receipts = ["A_READY", "B_READY", "A_UNCHANGED", "B_UNCHANGED"];
    const result = await checkIsolation(name => {
      opened.push(name);
      return { run: async (project: string) => ({ project, exitCode: 0, stdout: receipts[i++], stderr: "", truncated: false, persistence: "test" }) };
    }, "1234567890ab");
    expect(result.passed).toBe(true);
    expect(opened).toEqual(["project-v1:isocheck-a-1234567890ab", "project-v1:isocheck-b-1234567890ab"]);
    expect(i).toBe(4);
  });
  test("rejects a shared container even when every shell command returns success", async () => {
    const shared = { run: async (project: string) => ({ project, exitCode: 0, stdout: "", stderr: "", truncated: false, persistence: "test" }) };
    await expect(checkIsolation(() => shared, "1234567890ab")).rejects.toThrow();
  });
  test("rejects non-random test identities before starting a container", async () => {
    let opened = false;
    await expect(checkIsolation(() => { opened = true; throw Error("unexpected"); }, "../other")).rejects.toThrow();
    expect(opened).toBe(false);
  });
});

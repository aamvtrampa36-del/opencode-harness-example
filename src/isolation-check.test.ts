import { describe, expect, test } from "bun:test";
import { checkIsolation } from "./isolation-check";

describe("real isolation probe", () => {
  test("routes each synthetic project to its own container and validates all receipts", async () => {
    const opened: string[] = [];
    let i = 0;
    const receipts = ["A_READY", "B_READY", "A_ATTACKED", "B_ATTACKED", "A_UNCHANGED", "B_UNCHANGED"];
    const commands: Array<{project: string; command: string}> = [];
    const result = await checkIsolation(name => {
      opened.push(name);
      return { run: async (project: string, command: string) => { commands.push({project,command}); return { project, exitCode: 0, stdout: receipts[i++], stderr: "", truncated: false, persistence: "test" }; } };
    }, "1234567890ab");
    expect(result.passed).toBe(true);
    expect(opened).toEqual(["project-v1:isocheck-a-1234567890ab", "project-v1:isocheck-b-1234567890ab"]);
    expect(i).toBe(6);
    const a = "isocheck-a-1234567890ab", b = "isocheck-b-1234567890ab";
    expect(commands[2].project).toBe(a);
    expect(commands[2].command).toContain(b);
    expect(commands[3].project).toBe(b);
    expect(commands[3].command).toContain(a);
    for (const command of [commands[2].command, commands[3].command]) {
      expect(command).toContain("../");
      expect(command).toContain("ln -s");
      expect(command).toContain("intrusion");
    }
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

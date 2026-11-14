import { describe, expect, test } from "bun:test";
import { resolveScopedLinuxProject } from "./scoped-linux-tools";

describe("session-derived Linux tool targets", () => {
  const project = async (_session: string) => "repo-opencode-harness-example";
  test("derives target from bound session without model-provided IDs", async () => {
    expect(await resolveScopedLinuxProject("s", undefined, project))
      .toBe("repo-opencode-harness-example");
  });
  test("preserves old compatible IDs, rejects guessed or foreign projects", async () => {
    expect(await resolveScopedLinuxProject("s", "repo-opencode-harness-example", project))
      .toBe("repo-opencode-harness-example");
    expect(resolveScopedLinuxProject("s", "opencode-harness-example", project))
      .rejects.toThrow("Proyecto diferente");
  });
  test("requires an explicit project only for unbound sessions", async () => {
    expect(resolveScopedLinuxProject("s", "", async () => ""))
      .rejects.toThrow("Selecciona un proyecto");
    expect(await resolveScopedLinuxProject("s", "primera-app", async () => ""))
      .toBe("primera-app");
  });
});

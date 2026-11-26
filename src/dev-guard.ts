/** A deliberately small guardrail around untrusted user/model parameters. */
export const PROJECT_SLUG = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_SHELL_SOURCE = 12_000;
export const MAX_SHELL_OUTPUT = 32_000;

export function validateProject(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_SLUG.test(value)) {
    throw new Error("Invalid project: use 1–40 lowercase letters, numbers or hyphens, starting with a letter.");
  }
  return value;
}
export function validateCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SHELL_SOURCE) {
    throw new Error("Command must contain 1–12,000 characters.");
  }
  return value;
}

/** Legacy personal is a shared workspace, never a supervised project VM. */
export function assertLinuxExecutionScope(name: string | undefined, project: unknown): string {
  const id = validateProject(project);
  if (name !== "project-v1:" + id &&
      !(name === "personal" && !/^supervised-[a-f0-9]{16}$/.test(id))) {
    throw Error("LINUX_PROJECT_SCOPE_MISMATCH");
  }
  return id;
}

/** Executed inside the VM, before the shell starts. Root is server-owned.
 * Initial cwd guard, NOT a sandbox for arbitrary shell commands. */
export function linuxProjectCwdSource(root = "/workspace/projects"): string {
  return `;(() => {
    const fs = require("node:fs"), path = require("node:path");
    const root = ${JSON.stringify(root)}, project = process.argv[2];
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(project || "") ||
        !path.isAbsolute(root) || path.resolve(root) !== root || root === "/")
      throw Error("LINUX_PROJECT_CWD_INVALID");
    const target = path.join(root, project);
    let current = "/";
    for (const part of target.slice(1).split("/")) {
      current = path.join(current, part);
      try { fs.mkdirSync(current); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const entry = fs.lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(current) !== current)
        throw Error("LINUX_PROJECT_CWD_MISMATCH");
    }
    process.chdir(target);
    if (process.cwd() !== target) throw Error("LINUX_PROJECT_CWD_MISMATCH");
  })();`;
}

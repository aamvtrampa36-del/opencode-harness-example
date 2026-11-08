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

/** Keep the managed Linux shell aligned with the repository's pinned package manager. */
export const BUN_RUNTIME_VERSION = "1.4.4";

/** Install Bun only when a shell request explicitly uses bun or bunx. */
export function commandRequiresBun(command: string): boolean {
  return /(?:^|&&|\|\||[;&|\r\n]|\(\s*)\s*bun(?:x)?(?=\s|$)/.test(command);
}

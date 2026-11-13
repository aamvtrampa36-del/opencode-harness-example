/**
 * Staging-only addition to the committed baseline Wrangler-generated types
 * (same pattern as src/dev-bindings.d.ts). The binding is declared ONLY in
 * wrangler.g1.jsonc and points at the private bucket
 * opencode-v1-recovery-20261112. Optional on purpose: the external backup
 * drill fails closed with a clear error when the binding is absent instead
 * of assuming it exists. Regenerate env.d.ts with `bun run types` only after
 * an authorized deployment; production wrangler.jsonc keeps no R2 binding.
 */
interface Env {
  RECOVERY_R2?: R2Bucket;
}

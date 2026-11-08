/**
 * Addition to the committed baseline Wrangler-generated environment types.
 * Regenerate env.d.ts with `bun run types` after deploying the new binding.
 */
interface Env {
  DEV: DurableObjectNamespace<import("./server").DevContainer>;
}

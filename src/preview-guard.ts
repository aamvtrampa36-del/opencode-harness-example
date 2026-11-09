/** Fail-closed routing for the isolated G1 Preview.
 * Worker deployment aliases are publicly routable unless separately protected.
 * Keep them inaccessible while the single G1 Preview hostname uses Cloudflare Access.
 * Remove this G1-specific guard after an account-wide preview access policy is verified.
 */
const G1_PREVIEW_SUFFIX = "-opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev";

export function blockUnprotectedPreviewHost(hostname: string, allowedHost?: string): boolean {
  const host = hostname.toLowerCase();
  return host.endsWith(G1_PREVIEW_SUFFIX) &&
    (!allowedHost || host !== allowedHost.toLowerCase());
}

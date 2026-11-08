/**
 * Guard OpenRouter egress from the embedded OpenCode host.
 * Saving/removing a key in app settings must take effect even if a resumed
 * OpenCode session still holds an earlier integration credential.
 * No secrets appear in returned errors, logs, or the browser.
 */
export function guardedProviderFetch(
  loadAuthorizedKey: () => Promise<readonly string[]>,
  transport: typeof fetch = fetch
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const isOpenRouter = url.hostname === "openrouter.ai" || url.hostname.endsWith(".openrouter.ai");
    if (isOpenRouter) {
      const authorization = request.headers.get("Authorization");
      const eligible = await loadAuthorizedKey();
      if (authorization) {
        const permitted = eligible.some((key) => key.length > 0 && authorization === "Bearer " + key);
        if (!permitted) {
          return Response.json({ error: { message: "OpenRouter key inactive or replaced in OpenCode settings" } },
            { status: 403, headers: { "Cache-Control": "no-store" } });
        }
      } else if (/\/(chat\/completions|completions|responses|embeddings|images\/generations)(?:\/|$)/.test(url.pathname)) {
        return Response.json({ error: { message: "Connect OpenRouter before requesting inference" } }, { status: 403 });
      }
    }
    return transport(request);
  };
}

import { describe, expect, test } from "bun:test";
import { RemoteMcpOAuthProvider } from "./mcp-oauth";

describe("owner-persisted MCP OAuth provider", () => {
  test("persists PKCE and tokens in its MCP-specific store", async () => {
    const values = new Map<string, unknown>();
    const store = {
      async get<T>(key: string): Promise<T | undefined> { return values.get(key) as T | undefined; },
      async put<T>(key: string, value: T): Promise<void> { values.set(key, value); },
      async delete(key: string): Promise<boolean> { return values.delete(key); }
    };
    const provider = new RemoteMcpOAuthProvider({ id: "cdf-workbench", state: "random-state",
      callbackUrl: "https://opencode.example/api/settings/mcp/oauth/callback", store });
    expect(provider.state()).toBe("random-state");
    expect(provider.clientMetadata.redirect_uris).toEqual([provider.redirectUrl]);
    await provider.saveCodeVerifier("pkce-verifier");
    expect(await provider.codeVerifier()).toBe("pkce-verifier");
    await provider.saveTokens({ access_token: "private-access", token_type: "Bearer", refresh_token: "private-refresh" });
    expect((await provider.tokens())?.access_token).toBe("private-access");
    expect(values.has("mcp-oauth:cdf-workbench:tokens")).toBe(true);
    await provider.invalidateCredentials("tokens");
    expect(await provider.tokens()).toBeUndefined();
  });
});

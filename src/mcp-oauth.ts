import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens
} from "@modelcontextprotocol/client";

export type OAuthTokenRecord = { tokens: StoredOAuthTokens; savedAt: number };
export type OAuthStore = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
};

/** Persists the SDK's standard MCP OAuth state in the owner settings DO. */
export class RemoteMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly prefix: string;
  private readonly stateValue: string;
  private readonly store: OAuthStore;
  authorizationUrl?: URL;

  constructor(options: {
    id: string;
    callbackUrl: string;
    state: string;
    store: OAuthStore;
  }) {
    this.prefix = `mcp-oauth:${options.id}:`;
    this.redirectUrl = options.callbackUrl;
    this.stateValue = options.state;
    this.store = options.store;
    this.clientMetadata = {
      client_name: "OpenCode Cloud",
      software_id: "opencode-cloud",
      software_version: "1",
      redirect_uris: [options.callbackUrl],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none"
    };
  }

  state(): string { return this.stateValue; }
  async clientInformation(_ctx?: OAuthClientInformationContext) {
    return await this.store.get<StoredOAuthClientInformation>(this.prefix + "client");
  }
  async saveClientInformation(value: StoredOAuthClientInformation) {
    await this.store.put(this.prefix + "client", value);
  }
  async tokens(_ctx?: OAuthClientInformationContext) {
    return (await this.store.get<OAuthTokenRecord>(this.prefix + "tokens"))?.tokens;
  }
  async saveTokens(tokens: StoredOAuthTokens) {
    await this.store.put(this.prefix + "tokens", { tokens, savedAt: Date.now() } satisfies OAuthTokenRecord);
  }
  async saveCodeVerifier(verifier: string) {
    await this.store.put(this.prefix + "verifier", verifier);
  }
  async codeVerifier() {
    const verifier = await this.store.get<string>(this.prefix + "verifier");
    if (!verifier) throw new Error("OAuth PKCE verifier is missing");
    return verifier;
  }
  async saveDiscoveryState(state: OAuthDiscoveryState) {
    await this.store.put(this.prefix + "discovery", state);
  }
  async discoveryState() {
    return await this.store.get<OAuthDiscoveryState>(this.prefix + "discovery");
  }
  async redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const keys = scope === "all"
      ? ["client", "tokens", "verifier", "discovery"]
      : [scope];
    await Promise.all(keys.map(key => this.store.delete(this.prefix + key)));
  }
}

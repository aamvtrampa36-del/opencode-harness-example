/** Registered remote MCP endpoints only. Local MCP commands require a
 * separate Linux-side integration, not shell execution inside the Worker. */
export type RemoteMcpConfig = {
  id: string;
  url: string;
  enabled: boolean;
  auth?: "none" | "bearer" | "oauth";
  scope?: string;
  toolAllowlist?: string[];
  token?: string;
  connected?: boolean;
};

export type PublicMcpConfig = Omit<RemoteMcpConfig, "token"> & { hasToken: boolean; auth: "none" | "bearer" | "oauth" };

export function publicMcp(config: RemoteMcpConfig): PublicMcpConfig {
  const auth = config.auth ?? (config.token ? "bearer" : "none");
  return { id: config.id, url: config.url, enabled: config.enabled, auth,
    ...(config.scope ? { scope: config.scope } : {}),
    ...(config.toolAllowlist ? { toolAllowlist: [...config.toolAllowlist] } : {}),
    ...(auth === "oauth" ? { connected: Boolean(config.connected) } : {}),
    hasToken: Boolean(config.token || (auth === "oauth" && config.connected)) };
}

export function validateRemoteMcp(value: unknown): RemoteMcpConfig {
  if (typeof value !== "object" || value === null) throw new Error("Invalid MCP configuration");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(item.id)) {
    throw new Error("MCP name must be 2–40 lowercase letters, digits or hyphens");
  }
  if (typeof item.url !== "string" || item.url.length > 600) throw new Error("Invalid MCP URL");
  let url: URL;
  try { url = new URL(item.url); } catch { throw new Error("Invalid MCP URL"); }
  // Normalize the host: strip any trailing dots so "localhost.", "host.local."
  // and "host.internal." are rejected exactly like their plain forms.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.includes(":") || /^\d+(\.\d+){3}$/.test(host) ||
      !host.includes(".")) {
    throw new Error("MCP must use a public HTTPS domain without embedded credentials or private address");
  }
  if (typeof item.enabled !== "boolean") throw new Error("Enabled must be a boolean");
  const auth = item.auth === undefined ? (item.token ? "bearer" : "none") : item.auth;
  if (auth !== "none" && auth !== "bearer" && auth !== "oauth") throw new Error("Invalid MCP authentication mode");
  if (auth === "bearer" && !item.token && item.hasToken !== true) {
    throw new Error("Bearer authentication requires a token");
  }
  if (auth !== "bearer" && item.token) throw new Error("A token is only valid for bearer authentication");
  const scope = item.scope === undefined || item.scope === "" ? undefined : item.scope;
  if (scope !== undefined && (typeof scope !== "string" || scope.length > 300 || !/^[a-z0-9:_./ -]+$/i.test(scope))) {
    throw new Error("Invalid OAuth scope");
  }
  let toolAllowlist: string[] | undefined;
  if (item.toolAllowlist !== undefined) {
    if (!Array.isArray(item.toolAllowlist) || item.toolAllowlist.length > 100 ||
        item.toolAllowlist.some(name => typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(name))) {
      throw new Error("Invalid MCP tool allowlist");
    }
    toolAllowlist = [...new Set(item.toolAllowlist as string[])];
  }
  if (item.token !== undefined && item.token !== "") {
    if (typeof item.token !== "string" || item.token.length > 512 ||
        item.token.length < 8 || /\s/.test(item.token)) {
      throw new Error("Invalid bearer token");
    }
  }
  return {
    id: item.id, url: url.toString(), enabled: item.enabled,
    auth: auth as RemoteMcpConfig["auth"],
    ...(scope ? { scope } : {}),
    ...(toolAllowlist ? { toolAllowlist } : {}),
    ...(typeof item.token === "string" && item.token ? { token: item.token } : {}),
    ...(typeof item.connected === "boolean" ? { connected: item.connected } : {})
  };
}

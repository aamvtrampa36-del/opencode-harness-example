/** Registered remote MCP endpoints only. Local MCP commands require a
 * separate Linux-side integration, not shell execution inside the Worker. */
export type RemoteMcpConfig = {
  id: string;
  url: string;
  enabled: boolean;
  token?: string;
};

export type PublicMcpConfig = Omit<RemoteMcpConfig, "token"> & { hasToken: boolean };

export function publicMcp(config: RemoteMcpConfig): PublicMcpConfig {
  return { id: config.id, url: config.url, enabled: config.enabled, hasToken: Boolean(config.token) };
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
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.includes(":") || /^\d+(\.\d+){3}$/.test(host) ||
      !host.includes(".")) {
    throw new Error("MCP must use a public HTTPS domain without embedded credentials or private address");
  }
  if (typeof item.enabled !== "boolean") throw new Error("Enabled must be a boolean");
  if (item.token !== undefined && item.token !== "") {
    if (typeof item.token !== "string" || item.token.length > 512 ||
        item.token.length < 8 || /\s/.test(item.token)) {
      throw new Error("Invalid bearer token");
    }
  }
  return {
    id: item.id, url: url.toString(), enabled: item.enabled,
    ...(typeof item.token === "string" && item.token ? { token: item.token } : {})
  };
}

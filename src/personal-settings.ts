import { DurableObject } from "cloudflare:workers";
import { aggregateIncident, type IncidentRecord } from "./incident-diagnostics";
import { ALLOWED_REPOS, normalizeOwnedRepository } from "./github";
import { MAX_SPECIALIZATIONS, mergeSpecializations, validateSpecialization, type Specialization } from "./specializations";
import { publicMcp, validateRemoteMcp, type PublicMcpConfig, type RemoteMcpConfig } from "./mcp-config";
import { auth, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { RemoteMcpOAuthProvider, type OAuthTokenRecord } from "./mcp-oauth";
import type { ConnectorEventName } from "./connector-adapter";

/**
 * One owner-scoped, persisted settings object shared by all browser workspaces.
 * Stored keys are never returned by HTTP endpoints or put in agent prompts.
 * Access to the public Worker is protected by Cloudflare Access, while only
 * Worker-to-DO RPC methods can read these credentials.
 */
const MAX_KEY = 512;
const NO_STORE = { "Cache-Control": "no-store" };
const OAUTH_ATTEMPT_TTL = 15 * 60 * 1000;

export type TokenEconomizerHookStatus = {
  name: ConnectorEventName;
  at: number;
  succeeded: boolean;
};

export type TokenEconomizerContextStatus = { at: number; characters: number };

export type TemplateProposal = { id: string; createdAt: number; template: Specialization };

export interface ProviderStatus {
  openRouterConfigured: boolean;
  githubConfigured: boolean;
}

type KeyUsage = {
  label?: string;
  usage?: number;
  usage_daily?: number;
  usage_monthly?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
};

function checkedKey(value: unknown, prefix: string): string {
  if (typeof value !== "string" || value.length < 15 || value.length > MAX_KEY ||
      /[\r\n\s]/.test(value) || !value.startsWith(prefix)) {
    throw new Error("La clave tiene un formato inválido.");
  }
  return value;
}

async function checkProvider(url: string, token: string): Promise<KeyUsage> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "OpenCode-Cloud"
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("La credencial fue rechazada por el proveedor.");
    }
    throw new Error(`No se pudo validar la conexión (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as { data?: KeyUsage };
  return data?.data ?? {};
}

export class PersonalSettings extends DurableObject<Env> {
  /** Read-only owner-scoped incident ledger, without prompt or credential text. */
  async listIncidents(): Promise<IncidentRecord[]> {
    return (await this.ctx.storage.get<IncidentRecord[]>("incident-ledger-v1")) ?? [];
  }

  async recordIncident(observation: unknown): Promise<IncidentRecord> {
    // Serializes parallel agent/tool reports, preventing lost duplicate counts.
    return this.ctx.storage.transaction(async (tx) => {
      const previous = (await tx.get<IncidentRecord[]>("incident-ledger-v1")) ?? [];
      const updated = aggregateIncident(previous, observation);
      await tx.put("incident-ledger-v1", updated);
      return updated[0];
    });
  }

  /** Bound AI inference expense: at most two optional tool-loop checks per UTC day. */
  async reserveAgentCheck(): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const usage = (await this.ctx.storage.get<{ day: string; count: number }>("agent-check-quota-v1")) ??
      { day, count: 0 };
    const count = usage.day === day ? usage.count : 0;
    if (count >= 2) return false;
    await this.ctx.storage.put("agent-check-quota-v1", { day, count: count + 1 });
    return true;
  }

  async status(): Promise<ProviderStatus> {
    const [router, github] = await Promise.all([
      this.ctx.storage.get<string>("openrouter-api-key"),
      this.ctx.storage.get<string>("github-api-key")
    ]);
    return { openRouterConfigured: Boolean(router), githubConfigured: Boolean(github) };
  }

  async getOpenRouterKey(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("openrouter-api-key");
  }

  async defaultImageModel(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("default-image-model-v1");
  }

  async setDefaultImageModel(model: string | undefined): Promise<void> {
    if (model === undefined) {
      await this.ctx.storage.delete("default-image-model-v1");
      return;
    }
    if (typeof model !== "string" || model.length > 160 ||
        !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:+-]*$/i.test(model)) {
      throw new Error("Modelo de imagen inválido");
    }
    await this.ctx.storage.put("default-image-model-v1", model);
  }

  async getGitHubKey(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("github-api-key");
  }

  private async remoteMcpRecords(): Promise<RemoteMcpConfig[]> {
    return (await this.ctx.storage.get<RemoteMcpConfig[]>("remote-mcps-v1")) ?? [];
  }

  async getRemoteMcps(): Promise<RemoteMcpConfig[]> {
    const saved = await this.remoteMcpRecords();
    return Promise.all(saved.map(async config => {
      if (config.auth !== "oauth") return config;
      let record = await this.ctx.storage.get<OAuthTokenRecord>(`mcp-oauth:${config.id}:tokens`);
      if (record?.tokens.refresh_token && typeof record.tokens.expires_in === "number" &&
          record.savedAt + record.tokens.expires_in * 1000 < Date.now() + 60_000) {
        try {
          const callback = await this.ctx.storage.get<string>(`mcp-oauth:${config.id}:callback`);
          if (!callback) throw new Error("OAuth callback is unavailable");
          const provider = new RemoteMcpOAuthProvider({ id: config.id, callbackUrl: callback,
            state: crypto.randomUUID(), store: this.ctx.storage });
          const result = await auth(provider, { serverUrl: config.url, scope: config.scope });
          record = await this.ctx.storage.get<OAuthTokenRecord>(`mcp-oauth:${config.id}:tokens`);
          if (result !== "AUTHORIZED") record = undefined;
        } catch {
          record = undefined;
        }
      }
      return { ...config, connected: Boolean(record?.tokens.access_token),
        ...(record?.tokens.access_token ? { token: record.tokens.access_token } : {}) };
    }));
  }

  async startRemoteMcpOAuth(input: { id: string; callbackUrl: string; scope?: string; workspace?: string }): Promise<{ authorizationUrl: string }> {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(input.id)) throw new Error("Invalid MCP ID");
    const config = (await this.ctx.storage.get<RemoteMcpConfig[]>("remote-mcps-v1") ?? [])
      .find(item => item.id === input.id);
    if (!config || config.auth !== "oauth") throw new Error("Guarda primero el servidor MCP con autenticación OAuth");
    const callback = new URL(input.callbackUrl);
    if (callback.protocol !== "https:" || callback.pathname !== "/api/settings/mcp/oauth/callback" ||
        callback.search || callback.hash || callback.username || callback.password) {
      throw new Error("Invalid OAuth callback URL");
    }
    if (input.workspace && !/^[a-f0-9-]{36}$/i.test(input.workspace)) throw new Error("Invalid workspace");
    const scope = input.scope?.trim() || config.scope;
    if (scope && (scope.length > 300 || !/^[a-z0-9:_./ -]+$/i.test(scope))) throw new Error("Invalid OAuth scope");
    const state = crypto.randomUUID();
    const provider = new RemoteMcpOAuthProvider({ id: input.id, callbackUrl: callback.toString(), state, store: this.ctx.storage });
    const result = await auth(provider, { serverUrl: config.url, forceReauthorization: true,
      ...(scope ? { scope } : {}) });
    if (result !== "REDIRECT" || !provider.authorizationUrl) throw new Error("OAuth server did not start an authorization flow");
    if (provider.authorizationUrl.protocol !== "https:" || provider.authorizationUrl.username || provider.authorizationUrl.password) {
      throw new Error("OAuth authorization endpoint must use HTTPS");
    }
    await this.ctx.storage.put(`mcp-oauth:${input.id}:callback`, callback.toString());
    await this.ctx.storage.put(`mcp-oauth:${input.id}:attempt-state`, state);
    await this.ctx.storage.put(`mcp-oauth-attempt:${state}`, {
      id: input.id, callbackUrl: callback.toString(), scope, workspace: input.workspace,
      createdAt: Date.now()
    });
    return { authorizationUrl: provider.authorizationUrl.toString() };
  }

  async completeRemoteMcpOAuth(state: string, code: string, issuer?: string): Promise<{ id: string; workspace?: string }> {
    if (!/^[a-f0-9-]{36}$/i.test(state) || typeof code !== "string" || code.length > 4096 || !code) {
      throw new Error("Invalid OAuth callback");
    }
    const attemptKey = `mcp-oauth-attempt:${state}`;
    const attempt = await this.ctx.storage.get<{ id: string; callbackUrl: string; scope?: string; workspace?: string; createdAt: number }>(attemptKey);
    const storedState = attempt && await this.ctx.storage.get<string>(`mcp-oauth:${attempt.id}:attempt-state`);
    if (!attempt || storedState !== state || Date.now() - attempt.createdAt > OAUTH_ATTEMPT_TTL) {
      await this.ctx.storage.delete(attemptKey);
      throw new Error("OAuth attempt expired or state did not match");
    }
    try {
      const config = (await this.ctx.storage.get<RemoteMcpConfig[]>("remote-mcps-v1") ?? [])
        .find(item => item.id === attempt.id);
      if (!config || config.auth !== "oauth") throw new Error("MCP server configuration changed during OAuth");
      const provider = new RemoteMcpOAuthProvider({ id: attempt.id, callbackUrl: attempt.callbackUrl,
        state, store: this.ctx.storage });
      const result = await auth(provider, { serverUrl: config.url, authorizationCode: code,
        ...(attempt.scope ? { scope: attempt.scope } : {}), ...(issuer ? { iss: issuer } : {}) });
      if (result !== "AUTHORIZED") throw new Error("OAuth authorization did not complete");
      await this.ctx.storage.delete(`mcp-oauth:${attempt.id}:verifier`);
      const updated = (await this.ctx.storage.get<RemoteMcpConfig[]>("remote-mcps-v1") ?? [])
        .map(item => item.id === attempt.id ? { ...item, scope: attempt.scope ?? item.scope, connected: true } : item);
      await this.ctx.storage.put("remote-mcps-v1", updated);
      return { id: attempt.id, ...(attempt.workspace ? { workspace: attempt.workspace } : {}) };
    } finally {
      await this.ctx.storage.delete(attemptKey);
      await this.ctx.storage.delete(`mcp-oauth:${attempt.id}:attempt-state`);
    }
  }

  /** Optional personal integrations stay off until explicitly installed and enabled. */
  async connectorSettings(): Promise<{ tokenEconomizerEnabled: boolean }> {
    return { tokenEconomizerEnabled:
      (await this.ctx.storage.get<boolean>("connector-token-economizer-enabled-v1")) ?? false };
  }

  async setTokenEconomizerEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("El estado del conector debe ser verdadero o falso.");
    await this.ctx.storage.put("connector-token-economizer-enabled-v1", enabled);
  }

  async tokenEconomizerLastHook(): Promise<TokenEconomizerHookStatus | undefined> {
    return this.ctx.storage.get<TokenEconomizerHookStatus>("connector-token-economizer-last-hook-v1");
  }

  async tokenEconomizerLastContext(): Promise<TokenEconomizerContextStatus | undefined> {
    return this.ctx.storage.get<TokenEconomizerContextStatus>("connector-token-economizer-last-context-v1");
  }

  async recordTokenEconomizerHook(name: ConnectorEventName, succeeded: boolean,
    contextCharacters = 0): Promise<void> {
    await this.ctx.storage.put("connector-token-economizer-last-hook-v1", {
      name, at: Date.now(), succeeded
    } satisfies TokenEconomizerHookStatus);
    if (succeeded && Number.isSafeInteger(contextCharacters) && contextCharacters > 0) {
      await this.ctx.storage.put("connector-token-economizer-last-context-v1", {
        at: Date.now(), characters: contextCharacters
      } satisfies TokenEconomizerContextStatus);
    }
  }

  async listPublicMcps(): Promise<PublicMcpConfig[]> {
    return (await this.getRemoteMcps()).map(publicMcp);
  }

  async saveRemoteMcp(value: unknown): Promise<PublicMcpConfig> {
    const input = validateRemoteMcp(value);
    const current = await this.remoteMcpRecords();
    const existing = current.find(e => e.id === input.id);
    if (!existing && current.length >= 12) throw new Error("MCP limit reached (12 servers)");
    const raw = value as Record<string, unknown>;
    const token = input.token || (raw.clearToken === true ? undefined : existing?.token);
    const authMode = raw.auth === undefined ? (existing?.auth ?? input.auth) : input.auth;
    const updated: RemoteMcpConfig = {
      id: input.id, url: input.url, enabled: input.enabled, auth: authMode,
      ...(input.scope ? { scope: input.scope } : existing?.scope ? { scope: existing.scope } : {}),
      ...(input.toolAllowlist ? { toolAllowlist: input.toolAllowlist } : existing?.toolAllowlist ? { toolAllowlist: existing.toolAllowlist } : {}),
      ...(authMode === "bearer" && token ? { token } : {}),
      ...(authMode === "oauth" ? { connected: existing?.connected ?? false } : {})
    };
    if (existing && (existing.url !== updated.url || existing.auth !== updated.auth)) {
      for (const key of ["client", "tokens", "verifier", "discovery", "callback", "attempt-state"])
        await this.ctx.storage.delete(`mcp-oauth:${input.id}:${key}`);
      updated.connected = false;
    }
    await this.ctx.storage.put("remote-mcps-v1",
      [...current.filter(e => e.id !== updated.id), updated].sort((a, b) => a.id.localeCompare(b.id)));
    return publicMcp(updated);
  }

  async removeRemoteMcp(id: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new Error("Invalid MCP ID");
    await this.ctx.storage.put("remote-mcps-v1",
      (await this.remoteMcpRecords()).filter(config => config.id !== id));
    for (const key of ["client", "tokens", "verifier", "discovery", "callback", "attempt-state"])
      await this.ctx.storage.delete(`mcp-oauth:${id}:${key}`);
  }

  /** Return the seven virtual defaults plus persisted overrides/custom entries. */
  async listSpecializations(): Promise<Specialization[]> {
    const saved = (await this.ctx.storage.get<Specialization[]>("specializations-v1")) ?? [];
    return mergeSpecializations(saved);
  }

  async getSpecialization(id: string): Promise<Specialization | undefined> {
    const found = (await this.listSpecializations()).find(p => p.id === id);
    return found?.enabled ? found : undefined;
  }

  async saveSpecialization(input: unknown): Promise<Specialization> {
    const next = validateSpecialization(input);
    // Only custom edits are persisted. Defaults are virtual, preventing a
    // rollout from overwriting any prior user data.
    const saved = (await this.ctx.storage.get<Specialization[]>("specializations-v1")) ?? [];
    const all = mergeSpecializations(saved);
    if (!all.some(p => p.id === next.id) && all.length >= MAX_SPECIALIZATIONS) {
      throw new Error("The specialization limit has been reached");
    }
    await this.ctx.storage.put("specializations-v1",
      [...saved.filter(p => p.id !== next.id), next].sort((a,b) => a.id.localeCompare(b.id)));
    return next;
  }

  /** Deleting an override restores that built-in; custom templates are removed. */
  async removeSpecialization(id: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new Error("Invalid specialization ID");
    const saved = (await this.ctx.storage.get<Specialization[]>("specializations-v1")) ?? [];
    await this.ctx.storage.put("specializations-v1", saved.filter(p => p.id !== id));
  }

  async listTemplateProposals(): Promise<TemplateProposal[]> {
    return (await this.ctx.storage.get<TemplateProposal[]>("specialization-proposals-v1")) ?? [];
  }

  /** Agent-created templates stay as drafts until the owner approves them in Settings. */
  async proposeSpecialization(input: unknown): Promise<{ id: string }> {
    const template = validateSpecialization(input);
    if (!template.enabled) throw new Error("A proposed template must be enabled");
    const proposals = await this.listTemplateProposals();
    if (proposals.length >= 5) throw new Error("There are already five pending template suggestions");
    const id = crypto.randomUUID();
    await this.ctx.storage.put("specialization-proposals-v1", [
      ...proposals,
      { id, createdAt: Date.now(), template }
    ]);
    return { id };
  }

  async approveTemplateProposal(id: string): Promise<Specialization> {
    const proposals = await this.listTemplateProposals();
    const proposal = proposals.find(item => item.id === id);
    if (!proposal) throw new Error("Template suggestion not found");
    if ((await this.listSpecializations()).some(item => item.id === proposal.template.id)) {
      throw new Error("Template ID already exists. Ask the agent to suggest a different ID.");
    }
    const saved = await this.saveSpecialization(proposal.template);
    await this.ctx.storage.put("specialization-proposals-v1", proposals.filter(item => item.id !== id));
    return saved;
  }

  async rejectTemplateProposal(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid template suggestion ID");
    await this.ctx.storage.put("specialization-proposals-v1",
      (await this.listTemplateProposals()).filter(item => item.id !== id));
  }

  async connectOpenRouter(raw: unknown): Promise<{ configured: true; usage: KeyUsage }> {
    const key = checkedKey(raw, "sk-or-");
    const usage = await checkProvider("https://openrouter.ai/api/v1/key", key);
    await this.ctx.storage.put("openrouter-api-key", key);
    return { configured: true, usage: {
      label: usage.label,
      usage: usage.usage,
      usage_daily: usage.usage_daily,
      usage_monthly: usage.usage_monthly,
      limit: usage.limit,
      limit_remaining: usage.limit_remaining,
      limit_reset: usage.limit_reset
    } };
  }

  async disconnectOpenRouter(): Promise<void> {
    await this.ctx.storage.delete("openrouter-api-key");
  }

  async openRouterUsage(): Promise<KeyUsage | null> {
    const key = await this.getOpenRouterKey();
    if (!key) return null;
    const info = await checkProvider("https://openrouter.ai/api/v1/key", key);
    return {
      label: info.label, usage: info.usage, usage_daily: info.usage_daily,
      usage_monthly: info.usage_monthly,
      limit: info.limit, limit_remaining: info.limit_remaining,
      limit_reset: info.limit_reset
    };
  }

  /** Repository authorizations are owned by the user, not compiled into tool code. */
  async getAllowedRepositories(): Promise<string[]> {
    const additions = (await this.ctx.storage.get<string[]>("approved-repositories-v1")) ?? [];
    return [...new Set([...ALLOWED_REPOS, ...additions])];
  }

  async authorizeRepository(input: unknown): Promise<{ repository: string; defaultBranch: string }> {
    const repo = normalizeOwnedRepository(input);
    const key = await this.getGitHubKey();
    if (!key) throw new Error("Conecta GitHub primero para verificar el acceso al repositorio.");
    const response = await fetch("https://api.github.com/repos/" + repo, {
      headers: {
        Authorization: "Bearer " + key,
        Accept: "application/vnd.github+json",
        "User-Agent": "OpenCode-Cloud",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error("El token no tiene acceso a este repositorio (HTTP " + response.status + ").");
    const result = await response.json() as { full_name?: string; default_branch?: string };
    if (result.full_name?.toLowerCase() !== repo.toLowerCase() || !result.default_branch) {
      throw new Error("Los metadatos de GitHub no coinciden con el repositorio solicitado.");
    }
    const current = await this.getAllowedRepositories();
    if (current.length >= 30 && !current.some(name => name.toLowerCase() === repo.toLowerCase())) {
      throw new Error("Límite de 30 repositorios autorizados.");
    }
    if (!ALLOWED_REPOS.some(name => name.toLowerCase() === repo.toLowerCase())) {
      const additions = (await this.ctx.storage.get<string[]>("approved-repositories-v1")) ?? [];
      if (!additions.some(name => name.toLowerCase() === repo.toLowerCase())) {
        await this.ctx.storage.put("approved-repositories-v1", [...additions, repo]);
      }
    }
    return { repository: repo, defaultBranch: result.default_branch };
  }

  async revokeRepository(input: unknown): Promise<void> {
    const repo = normalizeOwnedRepository(input);
    if (ALLOWED_REPOS.some(name => name.toLowerCase() === repo.toLowerCase())) {
      throw new Error("Los repositorios originales se mantienen autorizados para evitar romper proyectos existentes.");
    }
    const additions = (await this.ctx.storage.get<string[]>("approved-repositories-v1")) ?? [];
    await this.ctx.storage.put("approved-repositories-v1",
      additions.filter(name => name.toLowerCase() !== repo.toLowerCase()));
  }

  async connectGitHub(raw: unknown): Promise<{ configured: true; account: string }> {
    const key = checkedKey(raw, "github_pat_");
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "OpenCode-Cloud",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error("GitHub rechazó el token. Comprueba sus permisos.");
    const user = (await response.json()) as { login?: string };
    if (user.login?.toLowerCase() !== "aamvtrampa36-del") {
      throw new Error("El token debe pertenecer a la cuenta de GitHub autorizada.");
    }
    await this.ctx.storage.put("github-api-key", key);
    return { configured: true, account: user.login };
  }

  async disconnectGitHub(): Promise<void> {
    await this.ctx.storage.delete("github-api-key");
  }
}

export { NO_STORE };

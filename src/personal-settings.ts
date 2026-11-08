import { DurableObject } from "cloudflare:workers";
import { ALLOWED_REPOS, normalizeOwnedRepository } from "./github";
import { MAX_SPECIALIZATIONS, validateSpecialization, type Specialization } from "./specializations";

/**
 * One owner-scoped, persisted settings object shared by all browser workspaces.
 * Stored keys are never returned by HTTP endpoints or put in agent prompts.
 * Access to the public Worker is protected by Cloudflare Access, while only
 * Worker-to-DO RPC methods can read these credentials.
 */
const MAX_KEY = 512;
const NO_STORE = { "Cache-Control": "no-store" };

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

  async getGitHubKey(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("github-api-key");
  }

  async listSpecializations(): Promise<Specialization[]> {
    return (await this.ctx.storage.get<Specialization[]>("specializations-v1")) ?? [];
  }

  async getSpecialization(id: string): Promise<Specialization | undefined> {
    const found = (await this.listSpecializations()).find(p => p.id === id);
    return found?.enabled ? found : undefined;
  }

  async saveSpecialization(input: unknown): Promise<Specialization> {
    const next = validateSpecialization(input);
    const all = await this.listSpecializations();
    if (!all.some(p => p.id === next.id) && all.length >= MAX_SPECIALIZATIONS) {
      throw new Error("The specialization limit has been reached");
    }
    await this.ctx.storage.put("specializations-v1",
      [...all.filter(p => p.id !== next.id), next].sort((a,b) => a.id.localeCompare(b.id)));
    return next;
  }

  async removeSpecialization(id: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new Error("Invalid specialization ID");
    const all = await this.listSpecializations();
    await this.ctx.storage.put("specializations-v1", all.filter(p => p.id !== id));
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

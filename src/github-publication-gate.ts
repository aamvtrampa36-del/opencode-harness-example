/**
 * F0-C10/R2-T08: durable, fail-closed admission for GitHub draft PR side effects.
 *
 * The caller MUST pass storage from one shared Durable Object identity, not
 * a per-request or in-memory store. All writers must use the same instance.
 * This is not the T03 task scheduler and does not admit inference jobs.
 */
export interface PublicationTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface PublicationStorage {
  transaction<T>(run: (tx: PublicationTransaction) => Promise<T>): Promise<T>;
}
export interface PublicationIntent {
  repo: string;
  base: string;
  branch: string;
  title: string;
  body: string;
}
export interface PublicationProof {
  baseSha: string;
  headSha: string;
}
export interface PublicationReceipt {
  repo: string;
  number: number;
  url: string;
  draft: true;
  base: string;
  head: string;
  [key: string]: unknown;
}
type PublicationState = {
  generation: number;
  phase: "free" | "preflight" | "unknown";
  owner?: string;
  intentHash?: string;
  proof?: PublicationProof;
};
type Decision =
  | { kind: "receipt"; receipt: PublicationReceipt }
  | { kind: "busy" }
  | { kind: "reconcile"; state: PublicationState }
  | { kind: "acquired"; state: PublicationState };

function requireHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid publication intent hash");
}
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, "0")).join("");
}
function validProof(proof: PublicationProof): boolean {
  return /^[a-f0-9]{40}$/.test(proof.baseSha) && /^[a-f0-9]{40}$/.test(proof.headSha);
}

/**
 * A transaction arbitrates the whole repo/base PR publication scope.
 * No automatic TTL expiry: an unknown POST never frees the slot merely
 * because a Worker restarted. An operator-owned T03 recovery workflow must
 * inspect an ambiguous outcome before changing any unknown ledger entry.
 */
export class GitHubPublicationGate {
  constructor(private readonly storage: PublicationStorage) {}

  async run(
    intent: PublicationIntent,
    publish: (beforePost: (proof: PublicationProof) => Promise<void>) => Promise<PublicationReceipt>,
    reconcile: (proof: PublicationProof) => Promise<PublicationReceipt | null>
  ): Promise<PublicationReceipt> {
    const scope = await sha256(JSON.stringify([intent.repo.toLowerCase(), intent.base]));
    const hash = await sha256(JSON.stringify([
      intent.repo.toLowerCase(), intent.base, intent.branch, intent.title, intent.body, "draft"
    ]));
    requireHash(scope);
    requireHash(hash);
    const key = "github:publication:scope:" + scope;
    const receiptKey = "github:publication:receipt:" + hash;
    const owner = crypto.randomUUID();

    const decision = await this.storage.transaction<Decision>(async tx => {
      const receipt = await tx.get<PublicationReceipt>(receiptKey);
      if (receipt) return { kind: "receipt", receipt };
      const prior = await tx.get<PublicationState>(key);
      if (prior?.phase === "unknown") {
        if (prior.intentHash === hash && prior.proof && validProof(prior.proof)) {
          return { kind: "reconcile", state: prior };
        }
        return { kind: "busy" };
      }
      if (prior?.phase === "preflight") return { kind: "busy" };
      const state: PublicationState = {
        generation: (prior?.generation ?? 0) + 1,
        phase: "preflight", owner, intentHash: hash
      };
      await tx.put(key, state);
      return { kind: "acquired", state };
    });

    if (decision.kind === "receipt") return decision.receipt;
    if (decision.kind === "busy") throw new Error("PR_PUBLICATION_BUSY_OR_UNKNOWN: exclusive publication not available");
    const expectedGeneration = decision.state.generation;

    const finish = async (receipt: PublicationReceipt): Promise<PublicationReceipt> => {
      if (!receipt || receipt.repo.toLowerCase() !== intent.repo.toLowerCase() ||
          receipt.base !== intent.base || receipt.head !== intent.branch ||
          receipt.draft !== true || !Number.isSafeInteger(receipt.number) || receipt.number < 1 ||
          typeof receipt.url !== "string" || !receipt.url.startsWith("https://github.com/")) {
        throw new Error("PR_PUBLICATION_UNKNOWN: unverified publication receipt");
      }
      return this.storage.transaction(async tx => {
        const state = await tx.get<PublicationState>(key);
        const oldReceipt = await tx.get<PublicationReceipt>(receiptKey);
        if (oldReceipt) return oldReceipt;
        if (state?.generation !== expectedGeneration || state.intentHash !== hash ||
            (state.phase !== "preflight" && state.phase !== "unknown") ||
            (state.phase === "preflight" && state.owner !== owner)) {
          throw new Error("PR_PUBLICATION_FENCED: publication owner changed");
        }
        await tx.put(receiptKey, receipt);
        await tx.put(key, { generation: expectedGeneration, phase: "free" } satisfies PublicationState);
        return receipt;
      });
    };

    if (decision.kind === "reconcile") {
      // Reconciliation is READ-ONLY and must never re-POST on a 404, stale
      // search index, failed read, 503, or divergent GitHub PR payload.
      const existing = await reconcile(decision.state.proof!);
      if (!existing) throw new Error("PR_PUBLICATION_UNKNOWN: no authoritative matching PR receipt; do not retry POST");
      return finish(existing);
    }

    let effectMarked = false;
    const beforePost = async (proof: PublicationProof): Promise<void> => {
      if (effectMarked || !validProof(proof)) throw new Error("PR_PUBLICATION_FENCED: invalid effect proof");
      await this.storage.transaction(async tx => {
        const state = await tx.get<PublicationState>(key);
        if (state?.phase !== "preflight" || state.owner !== owner ||
            state.generation !== expectedGeneration || state.intentHash !== hash) {
          throw new Error("PR_PUBLICATION_FENCED: stale or missing exclusive publication owner");
        }
        // Journal before POST. If the response vanishes, the durable state
        // remains UNKNOWN; no new writer can acquire this scope.
        await tx.put(key, { ...state, phase: "unknown", proof });
      });
      effectMarked = true;
    };

    try {
      const result = await publish(beforePost);
      return await finish(result);
    } catch (error) {
      if (!effectMarked) {
        // Safe to unlock only when the external effect boundary was not
        // reached. Stale owner cannot delete a newer generation.
        await this.storage.transaction(async tx => {
          const state = await tx.get<PublicationState>(key);
          if (state?.phase === "preflight" && state.owner === owner &&
              state.generation === expectedGeneration && state.intentHash === hash) {
            await tx.put(key, { generation: expectedGeneration, phase: "free" } satisfies PublicationState);
          }
        });
      }
      // After beforePost, preserve UNKNOWN even for 503 / timeout. No blind
      // retry, no automatic lease expiry, no optimistic success.
      throw error;
    }
  }
}

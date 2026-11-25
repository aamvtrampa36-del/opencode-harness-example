import type { GitHubPrPublicationGate, GitHubPrPublicationScope, GitHubPrPublicationPermit,
  GitHubPrPublicationProof, GitHubRefIntent, GitHubPreparedRefIntent } from "./github";

/**
 * R2-T08: transactional publication gate for the SINGLE existing supervisor DO.
 * Storage is scoped to one DO, not a distributed lock across different DOs.
 * server.ts must route every supervised Staging PR through that same object.
 *
 * Uncertain external effects stay quarantined, even when TTL has elapsed.
 * No network request runs inside a storage.transaction.
 */
type Phase = "reserved" | "publishing" | "unknown";
type Active = {
  intentHash: string;
  token: string;
  generation: number;
  deadline: number;
  phase: Phase;
  /** Immutable reviewed commit identity, written atomically BEFORE POST. */
  proof?: GitHubPrPublicationProof;
};
type Ledger = { version: 1; generation: number; active?: Active };
type Receipt = {
  version: 1; intentHash: string; repo: string; base: string; branch: string;
  number: number; url: string; headSha: string; baseSha: string; draft: true;
};
type Claimed = { retryOnly: boolean; token: string; generation: number; proof?: GitHubPrPublicationProof };
const PREFIX = "github:pr-publisher:v1:";
const TTL_MS = 60_000;
const SHA = /^[a-f0-9]{40}$/i;
const HASH = /^[a-f0-9]{64}$/i;

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
function readLedger(value: unknown): Ledger {
  if (value === undefined) return { version: 1, generation: 0 };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("PR_LEDGER_INVALID");
  const entry = value as Partial<Ledger>;
  if (entry.version !== 1 || !Number.isSafeInteger(entry.generation) || entry.generation! < 0)
    throw Error("PR_LEDGER_INVALID");
  const a = entry.active;
  if (a && (!HASH.test(a.intentHash) || !/^[0-9a-f-]{36}$/i.test(a.token) ||
    !Number.isSafeInteger(a.generation) || a.generation < 1 ||
    !Number.isSafeInteger(a.deadline) || !["reserved", "publishing", "unknown"].includes(a.phase) ||
    (a.proof !== undefined && (!a.proof || !SHA.test(a.proof.headSha) || !SHA.test(a.proof.baseSha)))))
    throw Error("PR_LEDGER_INVALID");
  return entry as Ledger;
}
function readReceipt(value: unknown): Receipt | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("PR_RECEIPT_INVALID");
  const r = value as Receipt;
  if (r.version !== 1 || !HASH.test(r.intentHash) ||
    typeof r.repo !== "string" || typeof r.base !== "string" ||
    typeof r.branch !== "string" || !Number.isSafeInteger(r.number) || r.number < 1 ||
    typeof r.url !== "string" || r.draft !== true || !SHA.test(r.headSha) ||
    !SHA.test(r.baseSha)) throw Error("PR_RECEIPT_INVALID");
  return r;
}
function validateReceipt(value: unknown, intent: GitHubPrPublicationScope, hash: string): Receipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("PR_RECEIPT_UNVERIFIED");
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.number) || (v.number as number) < 1 || v.draft !== true ||
    v.repo !== intent.repo || v.base !== intent.base || v.head !== intent.branch ||
    typeof v.headSha !== "string" || !SHA.test(v.headSha) ||
    typeof v.baseSha !== "string" || !SHA.test(v.baseSha) ||
    v.url !== "https://github.com/" + intent.repo + "/pull/" + v.number) {
    throw Error("PR_RECEIPT_UNVERIFIED");
  }
  return {
    version: 1, intentHash: hash, repo: intent.repo, base: intent.base,
    branch: intent.branch, number: v.number as number, url: v.url as string,
    headSha: v.headSha.toLowerCase(), baseSha: v.baseSha.toLowerCase(), draft: true
  };
}

export function assertSupervisedPublicationScope(
  input: { repo: string; branch: string; action: string },
  sessionID: unknown,
  task: { id: string; repository: string; branch: string; project: string;
    session?: string; status: string } | undefined
): void {
  const match = /^opencode\/staging-([a-f0-9]{16})$/.exec(input.branch);
  if (input.action !== "pr" || !match || !task ||
      task.id !== match[1] || task.branch !== input.branch ||
      task.repository.toLowerCase() !== input.repo.toLowerCase() ||
      task.project !== "supervised-" + task.id ||
      typeof sessionID !== "string" || !sessionID ||
      task.session !== sessionID ||
      !["preparing", "running"].includes(task.status))
    throw Error("PR_PUBLICATION_SESSION_SCOPE_DENIED");
}

/** Do not instantiate per project: the storage must be the same supervisor DO. */
export class DurableGitHubPublicationGate implements GitHubPrPublicationGate {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly clock: () => number = Date.now,
    private readonly validateOwner?: (
      tx: DurableObjectTransaction, intent: GitHubPrPublicationScope
    ) => Promise<void>
  ) {}

  /** Same repo/base ledger and owner fence as PR publication. The per-intent
   * record is a receipt, not another scheduler. Unknown blocks all writers.
   * A null/404 observation never proves absence of an earlier effect. */
  async withRefEffect(intent: GitHubRefIntent, apply: () => Promise<void>,
    observe: () => Promise<string|null>): Promise<{reconciled:boolean}> {
    return this.withPreparedRefEffect({...intent,identity:intent.target},async()=>intent.target,async(_,fence)=>{
      await fence();await apply();
    },observe);
  }

  async withPreparedRefEffect(intent:GitHubPreparedRefIntent,prepare:()=>Promise<string>,
    apply:(target:string,fence:()=>Promise<void>)=>Promise<void>,observe:()=>Promise<string|null>):
    Promise<{target:string;reconciled:boolean}> {
    if (!intent || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(intent.repo) ||
        !intent.base || intent.base===intent.branch ||
        !/^opencode\/(?:staging|supervised)-[a-f0-9]{16}$/.test(intent.branch) ||
        typeof intent.identity!=="string" || !intent.identity || intent.identity.length>1500000 ||
        (intent.operation==="branch"?intent.expected!==null:
          intent.operation!=="write" || !intent.expected || !SHA.test(intent.expected)))
      throw Error("GITHUB_REF_INTENT_INVALID");
    const scope={repo:intent.repo,base:intent.base,branch:intent.branch,title:"",body:""};
    const key=PREFIX+await digest(intent.repo.toLowerCase()+"\n"+intent.base);
    const hash=await digest(JSON.stringify(["ref",intent.repo.toLowerCase(),intent.base,intent.branch,intent.operation,intent.expected,intent.identity]));
    const receiptKey=key+":ref:"+hash;
    const now=this.clock();
    if(!Number.isSafeInteger(now)||now<0)throw Error("PR_LEDGER_CLOCK_INVALID");
    const claim=await this.storage.transaction(async tx=>{
      if(this.validateOwner)await this.validateOwner(tx,scope);
      const ledger=readLedger(await tx.get<Ledger>(key));
      const done=await tx.get<unknown>(receiptKey);
      if(done!==undefined&&(typeof done!=="string"||!SHA.test(done)))throw Error("GITHUB_REF_RECEIPT_INVALID");
      if(ledger.active){
        const a=ledger.active;
        if(a.phase!=="reserved"){
          if(a.intentHash!==hash||!a.proof)throw Error("PR_PUBLICATION_BUSY_UNKNOWN");
          return {retryOnly:true,generation:a.generation,token:a.token,target:a.proof.headSha};
        }
        if(a.deadline>now)throw Error("PR_PUBLICATION_BUSY");
      }
      if(typeof done==="string")return {retryOnly:true,generation:ledger.generation,token:"",target:done};
      const generation=ledger.generation+1,token=crypto.randomUUID();
      if(!Number.isSafeInteger(generation))throw Error("PR_LEDGER_EPOCH_EXHAUSTED");
      ledger.generation=generation;
      ledger.active={intentHash:hash,token,generation,deadline:now+TTL_MS,phase:"reserved"};
      await tx.put(key,ledger);
      return {retryOnly:false,generation,token,target:undefined};
    });
    const owned=(a:Active|undefined)=>!!a&&a.intentHash===hash&&a.token===claim.token&&a.generation===claim.generation;
    let target=claim.target;
    try{
      if(!claim.retryOnly){
        target=await prepare();
        if(typeof target!=="string"||!SHA.test(target)||target===intent.expected)throw Error("GITHUB_REF_TARGET_INVALID");
        const exact=target;
        await this.storage.transaction(async tx=>{
          if(this.validateOwner)await this.validateOwner(tx,scope);
          const ledger=readLedger(await tx.get<Ledger>(key)),a=ledger.active;
          if(!a||!owned(a)||a.phase!=="reserved"||a.deadline<=this.clock())throw Error("PR_PUBLICATION_FENCE_REJECTED");
          a.phase="publishing";a.proof={baseSha:intent.expected??exact,headSha:exact};
          await tx.put(key,ledger);
        });
        const fence=async()=>this.storage.transaction(async tx=>{
          if(this.validateOwner)await this.validateOwner(tx,scope);
          const a=readLedger(await tx.get<Ledger>(key)).active;
          if(!a||!owned(a)||a.phase!=="publishing"||a.proof?.headSha!==exact||a.deadline<=this.clock())
            throw Error("PR_PUBLICATION_FENCE_REJECTED");
        });
        try{await apply(exact,fence);}catch{/* only exact readback can settle */}
      }
      if(!target||await observe()!==target)throw Error("GITHUB_REF_EFFECT_UNKNOWN");
      const exact=target;
      await this.storage.transaction(async tx=>{
        const ledger=readLedger(await tx.get<Ledger>(key));
        if(ledger.active){
          if(!owned(ledger.active)||ledger.active.proof?.headSha!==exact)throw Error("PR_PUBLICATION_FENCE_REJECTED");
          delete ledger.active;await tx.put(key,ledger);
        }else if(await tx.get(receiptKey)!==exact)throw Error("PR_PUBLICATION_FENCE_REJECTED");
        await tx.put(receiptKey,exact);
      });
      return {target:exact,reconciled:claim.retryOnly};
    }catch(error){
      let unknown=claim.retryOnly;
      await this.storage.transaction(async tx=>{
        const ledger=readLedger(await tx.get<Ledger>(key)),a=ledger.active;
        if(a&&owned(a)){
          if(a.phase==="reserved")delete ledger.active;
          else {a.phase="unknown";unknown=true;}
          await tx.put(key,ledger);
        }
      });
      if(unknown)throw Error("GITHUB_REF_EFFECT_UNKNOWN");
      throw error;
    }
  }

  async withExclusive<T>(
    intent: GitHubPrPublicationScope,
    execute: (permit: GitHubPrPublicationPermit) => Promise<T>
  ): Promise<T> {
    if (typeof intent.repo !== "string" || typeof intent.base !== "string" ||
        typeof intent.branch !== "string" || typeof intent.title !== "string" ||
        typeof intent.body !== "string") throw Error("PR_INTENT_INVALID");
    const scopeId = await digest(intent.repo.toLowerCase() + "\n" + intent.base);
    const intentHash = await digest(JSON.stringify([
      intent.repo.toLowerCase(), intent.base, intent.branch, intent.title, intent.body
    ]));
    const branchId = await digest(intent.branch);
    const key = PREFIX + scopeId;
    const receiptKey = key + ":branch:" + branchId;
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw Error("PR_LEDGER_CLOCK_INVALID");

    // Atomic admission and permanent per-branch intent. No HTTP inside tx.
    const claim = await this.storage.transaction(async tx => {
      if (this.validateOwner) await this.validateOwner(tx, intent);
      const ledger = readLedger(await tx.get<Ledger>(key));
      const receipt = readReceipt(await tx.get<Receipt>(receiptKey));
      if (receipt && receipt.intentHash !== intentHash)
        throw Error("PR_BRANCH_INTENT_CONFLICT");
      const active = ledger.active;
      if (active) {
        if (active.phase !== "reserved") {
          if (active.intentHash !== intentHash)
            throw Error("PR_PUBLICATION_BUSY_UNKNOWN");
          return { retryOnly: true, token: "", generation: active.generation, proof: active.proof };
        }
        if (active.deadline > now) throw Error("PR_PUBLICATION_BUSY");
        // Only a reservation with NO beginExternalEffect can expire.
      }
      if (receipt) return { retryOnly: true, token: "", generation: ledger.generation,
        proof: { baseSha: receipt.baseSha, headSha: receipt.headSha } };
      const generation = ledger.generation + 1;
      if (!Number.isSafeInteger(generation)) throw Error("PR_LEDGER_EPOCH_EXHAUSTED");
      const token = crypto.randomUUID();
      ledger.generation = generation;
      ledger.active = { intentHash, token, generation, deadline: now + TTL_MS, phase: "reserved" };
      await tx.put(key, ledger);
      return { retryOnly: false, token, generation };
    }) as Claimed;

    const permit: GitHubPrPublicationPermit = {
      fencingToken: claim.token,
      retryOnly: claim.retryOnly,
      expectedProof: claim.proof,
      beginExternalEffect: async proof => {
        if (claim.retryOnly) throw Error("PR_PUBLISH_UNKNOWN");
        if (!proof || !SHA.test(proof.baseSha) || !SHA.test(proof.headSha))
          throw Error("PR_PUBLICATION_PROOF_INVALID");
        await this.storage.transaction(async tx => {
          // Cancellation/branch ownership may have changed during HTTP preflight.
          // Check within the same durable tx as the publishing marker.
          if (this.validateOwner) await this.validateOwner(tx, intent);
          const ledger = readLedger(await tx.get<Ledger>(key));
          const a = ledger.active;
          if (!a || a.intentHash !== intentHash || a.token !== claim.token ||
            a.generation !== claim.generation || a.phase !== "reserved" ||
            a.deadline <= this.clock())
            throw Error("PR_PUBLICATION_FENCE_REJECTED");
          a.phase = "publishing";
          a.proof = { baseSha: proof.baseSha.toLowerCase(), headSha: proof.headSha.toLowerCase() };
          await tx.put(key, ledger); // write-ahead commit identity BEFORE POST
        });
      }
    };

    try {
      const result = await execute(permit);
      const receipt = validateReceipt(result, intent, intentHash);
      await this.storage.transaction(async tx => {
        const ledger = readLedger(await tx.get<Ledger>(key));
        const existing = readReceipt(await tx.get<Receipt>(receiptKey));
        if (existing && existing.intentHash !== intentHash)
          throw Error("PR_BRANCH_INTENT_CONFLICT");
        if (ledger.active) {
          if (ledger.active.intentHash !== intentHash ||
            (!claim.retryOnly && (ledger.active.token !== claim.token ||
               ledger.active.generation !== claim.generation)))
            throw Error("PR_PUBLICATION_FENCE_REJECTED");
          const pinned = ledger.active.proof;
          if (!pinned || pinned.headSha !== receipt.headSha ||
              pinned.baseSha !== receipt.baseSha)
            throw Error("PR_PUBLICATION_HEAD_CHANGED");
          delete ledger.active;
          await tx.put(key, ledger);
        } else if (!existing) {
          throw Error("PR_PUBLICATION_FENCE_REJECTED");
        }
        if (existing && (existing.number!==receipt.number || existing.url!==receipt.url ||
            existing.headSha!==receipt.headSha || existing.baseSha!==receipt.baseSha))
          throw Error("PR_RECEIPT_IDENTITY_CHANGED");
        await tx.put(receiptKey, receipt);
      });
      return result;
    } catch (error) {
      // A crash after "publishing" leaves it persisted. HTTP lost after POST
      // must NOT trigger a second POST and must NOT free the publication scope.
      if (!claim.retryOnly) {
        await this.storage.transaction(async tx => {
          const ledger = readLedger(await tx.get<Ledger>(key));
          const a = ledger.active;
          if (!a || a.token !== claim.token || a.generation !== claim.generation) return;
          if (a.phase === "reserved") delete ledger.active;
          else a.phase = "unknown";
          await tx.put(key, ledger);
        });
      }
      throw error;
    }
  }
}

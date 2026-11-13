import type { GitHubBridge } from "./github";
import { assertScopedTool, validateProjectScope } from "./project-scope";

/** G8 staging-only, read-only verification against the two existing draft PRs.
 * Never creates branches, commits, PRs, merges or deployments.
 */
export const G8_PROOFS = [
  { repo: "aamvtrampa36-del/cdf-cloud-engine", project: "cdf-cloud-engine",
    branch: "opencode/g8-cdf-isolation-20261110", marker: "G8-CDF-ISOLATION-PROOF", pr: 160 },
  { repo: "aamvtrampa36-del/CDF-WorkBench-", project: "cdf-workbench",
    branch: "opencode/g8-workbench-isolation-20261110", marker: "G8-WORKBENCH-ISOLATION-PROOF", pr: 36 }
] as const;
const FILE = "docs/opencode-g8/isolated-review-20261110.md";

export async function verifyG8Proofs(
  execute: GitHubBridge["execute"],
  approved: readonly string[]
) {
  const results: Array<{ repo: string; branch: string; pr: number; file: string; passed: true }> = [];
  for(const p of G8_PROOFS){
    const scope = validateProjectScope({project:p.project,repository:p.repo},approved);
    assertScopedTool(scope,{kind:"github",repo:p.repo});
    const other = G8_PROOFS.find(entry => entry.repo !== p.repo)!;
    let denied = false;
    try { assertScopedTool(scope,{kind:"github",repo:other.repo}); }
    catch { denied = true; }
    if(!denied)throw new Error("Isolation failed: cross-repository action was allowed");
    const metadata = await execute({action:"repo",repo:p.repo}) as {name?:string;defaultBranch?:string};
    if(metadata.name?.toLowerCase()!==p.repo.toLowerCase() || metadata.defaultBranch!=="main"){
      throw new Error("Unexpected repository identity or default branch");
    }
    const file = await execute({action:"read",repo:p.repo,path:FILE,ref:p.branch}) as {repo?:string;content?:string;ref?:string};
    if(file.repo?.toLowerCase()!==p.repo.toLowerCase() || file.ref!==p.branch ||
        !file.content?.includes(p.marker) || file.content.includes(other.marker)){
      throw new Error("Repository evidence mismatch: stop before any change");
    }
    const comparison = await execute({action:"review",repo:p.repo,branch:p.branch}) as {
      repo?:string;base?:string;branch?:string;files?:{path:string;status:string}[];truncated?:boolean
    };
    if(comparison.repo?.toLowerCase()!==p.repo.toLowerCase() ||
      comparison.base!=="main" || comparison.branch!==p.branch ||
      comparison.truncated ||
      comparison.files?.length!==1 || comparison.files[0]?.path!==FILE ||
      comparison.files[0]?.status!=="added"){
      throw new Error("Unexpected diff in G8 review branch; manual review required");
    }
    results.push({repo:p.repo,branch:p.branch,pr:p.pr,file:FILE,passed:true});
  }
  return { status:"passed" as const, results, writes:0, merges:0, inferenceCalls:0 };
}

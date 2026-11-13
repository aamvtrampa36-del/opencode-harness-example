import { describe, expect, test } from "bun:test";
import { verifyG8Proofs, G8_PROOFS } from "./g8-smoke";
import type { GitHubBridge, GitHubAction } from "./github";
const approved = G8_PROOFS.map(x=>x.repo);

describe("G8 two independent review branches without mutations",()=>{
  test("validates target identity, exact changes and cross-repo isolation via bridge reads only",async()=>{
    const requests:GitHubAction[]=[];
    const execute=async(action:GitHubAction):Promise<unknown>=>{
      requests.push(action);
      const proof=G8_PROOFS.find(x=>x.repo===action.repo)!;
      if(action.action==="repo")return {name:proof.repo,defaultBranch:"main",private:true};
      if(action.action==="read")return {repo:proof.repo,ref:proof.branch,path:action.path,content:"Marker: "+proof.marker};
      if(action.action==="review")return {repo:proof.repo,branch:proof.branch,base:"main",truncated:false,
        files:[{path:"docs/opencode-g8/isolated-review-20261110.md",status:"added"}]};
      throw Error("Read-only smoke must not mutate");
    };
    const result=await verifyG8Proofs(execute as GitHubBridge["execute"],approved);
    expect(result).toMatchObject({status:"passed",writes:0,merges:0,inferenceCalls:0});
    expect(result.results).toHaveLength(2);
    expect(requests).toHaveLength(6);
    expect(requests.every(x=>["repo","read","review"].includes(x.action))).toBe(true);
  });
  test("rejects wrong marker or unexpected diff and never follows through with a write",async()=>{
    const requests:GitHubAction[]=[];
    const execute=async(action:GitHubAction):Promise<unknown>=>{
      requests.push(action);
      if(action.action==="repo")return{name:action.repo,defaultBranch:"main"};
      if(action.action==="read")return{repo:action.repo,ref:G8_PROOFS[0].branch,content:"wrong marker"};
      throw Error("Should not get here");
    };
    await expect(verifyG8Proofs(execute as GitHubBridge["execute"],approved)).rejects.toThrow("mismatch");
    expect(requests.every(x=>["repo","read"].includes(x.action))).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { assessG8LiveHistory, g8LivePrompt, G8_LIVE_FILE } from "./g8-live-agent";
import { G8_PROOFS } from "./g8-smoke";

function msg(name:string,status:string,text:string) {
  return {type:"assistant",content:[{type:"tool",name,state:{status,content:[{type:"text",text}]}}]};
}
const evidence=(i:number)=>({
  repo:G8_PROOFS[i].repo,branch:G8_PROOFS[i].branch,
  base:"main",truncated:false,
  files:[{path:G8_LIVE_FILE,status:"added",additions:16,deletions:0}]
});

describe("G8 live agent real-tool acceptance evidence", () => {
  for (const i of [0,1]) {
    test("accepts only completed repo_review with exact diff in repository "+i,()=>{
      const result=assessG8LiveHistory(
        [msg("repo_review","completed",JSON.stringify(evidence(i)))], G8_PROOFS[i]);
      expect(result).toMatchObject({
        passed:true,matchedTools:1,completedTools:1,failedTools:0
      });
      expect(g8LivePrompt(G8_PROOFS[i])).toContain(G8_PROOFS[i].branch);
      expect(g8LivePrompt(G8_PROOFS[i])).toContain("repo_review");
    });
    test("rejects model prose claiming success without tool evidence in repo "+i,()=>{
      const plain = [{type:"assistant", content:[{type:"text",text:"Everything passed, exact branch and diff."}]}];
      expect(assessG8LiveHistory(plain,G8_PROOFS[i])).toMatchObject({passed:false,matchedTools:0});
    });
    test("rejects wrong repo, branch, changed file or tool error "+i,()=>{
      const proof=G8_PROOFS[i];
      const wrongRepo={...evidence(i),repo:G8_PROOFS[1-i].repo};
      const wrongBranch={...evidence(i),branch:"main"};
      const canonical={...evidence(i),files:[{path:"canon/BIBLIA.md",status:"modified"}]};
      const extra={...evidence(i),files:[...evidence(i).files,{path:".github/workflows/deploy.yml",status:"modified"}]};
      for(const candidate of [wrongRepo,wrongBranch,canonical,extra]){
        expect(assessG8LiveHistory([msg("repo_review","completed",JSON.stringify(candidate))],proof).passed).toBe(false);
      }
      expect(assessG8LiveHistory([msg("repo_review","error",JSON.stringify(evidence(i)))],proof))
        .toMatchObject({passed:false,failedTools:1});
      expect(assessG8LiveHistory([msg("github","completed",JSON.stringify(evidence(i)))],proof))
        .toMatchObject({passed:false,matchedTools:0});
    });
  }
});

import { describe, expect, test } from "bun:test";
import {
  assessG9History, g9AgentPrompt, G9_REPO, G9_BRANCH, G9_PROJECT,
  G9_SOURCE, G9_TEST_PATH, G9_BROKEN, G9_FIXED, G9_TEST_SOURCE
} from "./g9-selfdev";

const wrap=(name:string,status:string,result:unknown)=>({
  type:"assistant",
  content:[{type:"tool",name,state:{
    status,content:[{type:"text",text:JSON.stringify(result)}]
  }}]
});
const red=wrap("linux","completed",{
  project:G9_PROJECT,exitCode:1,stdout:"not ok 1 - G9: add(2,3) is five"
});
const write=wrap("github","completed",{
  repo:G9_REPO,branch:G9_BRANCH,path:G9_SOURCE,
  commitSha:"example-agent-commit"
});
const green=wrap("linux","completed",{
  project:G9_PROJECT,exitCode:0,stdout:"ok 1 - G9: add(2,3) is five"
});
const review=wrap("repo_review","completed",{
  repo:G9_REPO,branch:G9_BRANCH,base:"main",truncated:false,
  files:[{path:G9_SOURCE,status:"added"},{path:G9_TEST_PATH,status:"added"}]
});
const pr=wrap("github","completed",{
  repo:G9_REPO,head:G9_BRANCH,base:"main",draft:true,
  url:"https://github.com/aamvtrampa36-del/opencode-harness-example/pull/900"
});

describe("G9 genuine agent developer flow acceptance",()=>{
  test("counts only actual ordered completed tools and a draft PR",()=>{
    const v=assessG9History([red,write,green,review,pr]);
    expect(v).toMatchObject({
      passed:true,observedRed:true,observedGreenAfterRed:true,
      actualAgentWrite:true,actualAgentReview:true,actualAgentDraftPR:true,
      toolCalls:5,failedTools:0
    });
    expect(v.prUrl).toContain("/pull/900");
  });
  test("rejects agent prose, green-only, wrong order, and failed tool calls",()=>{
    const prose=[{type:"assistant",content:[{
      type:"text",text:"I changed code and all tests passed."
    }]}];
    for(const history of [
      prose,[green,write,review,pr],[write,red,green,review,pr],
      [red,green,write,review,pr],[red,write,green,pr,review]
    ]){
      expect(assessG9History(history).passed).toBe(false);
    }
    const toolError=wrap("github","error",{
      repo:G9_REPO,branch:G9_BRANCH,path:G9_SOURCE,commitSha:"fake"
    });
    expect(assessG9History([red,toolError,green,review,pr]).passed).toBe(false);
  });
  test("rejects mismatched repo, extra changed files, wrong branch and merged PR",()=>{
    const wrongRepo=wrap("github","completed",{
      repo:"someone/other",branch:G9_BRANCH,path:G9_SOURCE,commitSha:"fake"
    });
    const extra=wrap("repo_review","completed",{
      repo:G9_REPO,branch:G9_BRANCH,base:"main",
      files:[{path:G9_SOURCE},{path:G9_TEST_PATH},{path:"canon/official.md"}]
    });
    const merged=wrap("github","completed",{
      repo:G9_REPO,head:G9_BRANCH,base:"main",draft:false,
      url:"https://github.com/aamvtrampa36-del/opencode-harness-example/pull/900"
    });
    const wrongBranch=wrap("github","completed",{
      repo:G9_REPO,branch:"main",path:G9_SOURCE,commitSha:"fake"
    });
    for(const history of [
      [red,wrongRepo,green,review,pr],
      [red,wrongBranch,green,review,pr],
      [red,write,green,extra,pr],
      [red,write,green,review,merged]
    ])expect(assessG9History(history).passed).toBe(false);
  });
  test("the isolated correction can be tested in Node without any project dependency",()=>{
    expect(G9_BROKEN).toContain("a - b");
    expect(G9_FIXED).toContain("a + b");
    expect(G9_TEST_SOURCE).toContain("assert.equal(add(2, 3), 5)");
    const prompt=g9AgentPrompt();
    expect(prompt).toContain(G9_REPO);
    expect(prompt).toContain(G9_BRANCH);
    expect(prompt).toContain("linux");
    expect(prompt).toContain("github");
    expect(prompt).toContain("no finjas éxito");
  });
});

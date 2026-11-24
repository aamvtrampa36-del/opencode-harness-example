// Offline build receipt only. This module never uploads, deploys or grants approval.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { resolve, relative, join, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const sha40 = /^[a-f0-9]{40}$/;
const sha64 = /^[a-f0-9]{64}$/;
export const STAGING_WORKERS = [
  ["opencode-g1-staging","wrangler.g1.jsonc"],
  ["opencode-staging-control-mcp","wrangler.mcp-staging.jsonc"]
];
export function validateBuildReceipt(r, expected) {
  if(!r || r.schema!=="opencode-staging-package/v1" || r.kind!=="dry-run" || r.deployed!==false) throw Error("Not an offline package receipt");
  if(!sha40.test(r.commit) || !sha40.test(r.tree) || r.commit!==expected.commit || r.tree!==expected.tree) throw Error("Source identity mismatch");
  if(!/^[1-9][0-9]*$/.test(r.runId) || r.runId!==expected.runId) throw Error("CI identity mismatch");
  if(!Array.isArray(r.workers)||r.workers.length!==2) throw Error("Expected both Staging workers");
  for(const [name,config] of STAGING_WORKERS){
    const matches=r.workers.filter(w=>w?.name===name);
    if(matches.length!==1)throw Error("Worker identity mismatch");
    const w=matches[0];
    if(w.config!==config||!sha64.test(w.configSha256)||!sha64.test(w.bundleSha256)||!Number.isSafeInteger(w.files)||w.files<1)throw Error("Invalid package evidence");
  }
  if(!sha64.test(r.assetsSha256)||!Number.isSafeInteger(r.assetFiles)||r.assetFiles<1)throw Error("Missing asset evidence");
  return true;
}
export function digestDirectory(root) {
  if(!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())throw Error("Expected regular directory");
  const base=realpathSync(root), records=[];
  function walk(dir){
    for(const name of readdirSync(dir).sort()){
      const p=join(dir,name), stat=lstatSync(p);
      if(stat.isSymbolicLink())throw Error("Symlink in package");
      if(stat.isDirectory())walk(p);
      else if(stat.isFile())records.push([relative(base,p).split(sep).join("/"),createHash("sha256").update(readFileSync(p)).digest("hex")]);
      else throw Error("Non-regular package member");
    }
  }
  walk(base);
  if(!records.length)throw Error("Empty package");
  records.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  return {files:records.length,sha256:createHash("sha256").update(JSON.stringify(records)).digest("hex")};
}
const git=(...args)=>execFileSync("git",args,{encoding:"utf8"}).trim();
function main(){
  const [principal,mcp,assets]=process.argv.slice(2);
  if(!principal||!mcp||!assets)throw Error("Usage: node scripts/staging-release-receipt.mjs PRINCIPAL MCP ASSETS");
  const commit=git("rev-parse","HEAD"), tree=git("rev-parse","HEAD^{tree}");
  if(commit!==process.env.GITHUB_SHA||git("status","--porcelain","--untracked-files=no"))throw Error("Unexpected or modified checkout");
  const dirs=[principal,mcp];
  const workers=STAGING_WORKERS.map(([name,config],i)=>{
    const d=digestDirectory(dirs[i]);
    return {name,config,configSha256:createHash("sha256").update(readFileSync(config)).digest("hex"),bundleSha256:d.sha256,files:d.files};
  });
  const a=digestDirectory(assets);
  const receipt={schema:"opencode-staging-package/v1",kind:"dry-run",deployed:false,commit,tree,runId:process.env.GITHUB_RUN_ID,workers,assetsSha256:a.sha256,assetFiles:a.files};
  validateBuildReceipt(receipt,{commit,tree,runId:process.env.GITHUB_RUN_ID});
  console.log(JSON.stringify(receipt));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();

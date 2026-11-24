// No credentials, publication, upload or live inference in this comparator.
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,statSync} from "node:fs";
import {join,resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {digestDirectory} from "./staging-release-receipt.mjs";
const hash=p=>createHash("sha256").update(readFileSync(p)).digest("hex");
const git=(...a)=>execFileSync("git",a,{encoding:"utf8"}).trim();
const command=(file,...args)=>execFileSync(file,args,{encoding:"utf8"}).trim();
const groups=["principal","mcp","assets","configuration"];
export function manifest(root){
  return Object.fromEntries(groups.map(name=>[name,digestDirectory(join(root,name))]));
}
export function diffManifests(a,b){
  const differences=[];
  for(const name of groups){
    if(!a?.[name]?.manifest||!b?.[name]?.manifest)throw Error("Incomplete manifest: "+name);
    const x=new Map(a[name].manifest), y=new Map(b[name].manifest);
    for(const path of [...new Set([...x.keys(),...y.keys()])].sort()){
      if(x.get(path)!==y.get(path))differences.push({group:name,path,kind:!x.has(path)?"added":!y.has(path)?"missing":"bytes",a:x.get(path)??null,b:y.get(path)??null});
    }
  }
  return differences;
}
export function compareInputs(a,b){
  if(!a||!b||a.schema!=="opencode-repro-build/v1"||b.schema!==a.schema)throw Error("Invalid build receipts");
  if(a.replica!=="a"||b.replica!=="b")throw Error("Independent replicas required");
  if(!/^[1-9][0-9]*$/.test(a.runId)||a.runId!==b.runId)throw Error("CI run identity mismatch");
  if(JSON.stringify(a.inputs)!==JSON.stringify(b.inputs))throw Error("Declared build inputs differ");
  // Hosted runner image revisions are observed environment metadata, not pinned inputs.
  // They are reported for both replicas; byte equality remains mandatory.
  if(typeof a.runnerImageVersion!=="string"||typeof b.runnerImageVersion!=="string"||!a.runnerImageVersion||!b.runnerImageVersion||a.runnerImageVersion==="unknown"||b.runnerImageVersion==="unknown")throw Error("Runner image revision evidence missing");
  if(!/^[0-9a-f]{40}$/.test(a.inputs.commit)||!/^[0-9a-f]{40}$/.test(a.inputs.tree))throw Error("Invalid source identity");
  return true;
}
function record(root){
  const commit=git("rev-parse","HEAD"),tree=git("rev-parse","HEAD^{tree}");
  if(commit!==process.env.EXPECTED_SHA||git("status","--porcelain","--untracked-files=no"))throw Error("Unexpected checkout");
  const inputs={commit,tree,lockfile:hash("bun.lock"),bun:command("bun","--version"),node:process.version,wrangler:JSON.parse(readFileSync("node_modules/wrangler/package.json","utf8")).version,vite:JSON.parse(readFileSync("node_modules/vite/package.json","utf8")).version,image:process.env.ImageOS??"unknown",arch:process.arch,platform:process.platform,sourceDateEpoch:process.env.SOURCE_DATE_EPOCH,timezone:process.env.TZ,locale:process.env.LC_ALL};
  const receipt={schema:"opencode-repro-build/v1",replica:process.env.REPLICA,runId:process.env.GITHUB_RUN_ID,runnerImageVersion:process.env.ImageVersion??"unknown",inputs,groups:manifest(root),archiveSha256:hash(join(root,"payload.tar.gz"))};
  writeFileSync(join(root,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify({replica:receipt.replica,inputs,runnerImageVersion:receipt.runnerImageVersion,archiveSha256:receipt.archiveSha256,groups:Object.fromEntries(groups.map(k=>[k,{files:receipt.groups[k].files,sha256:receipt.groups[k].sha256}]))}));
}
function compare(aDir,bDir){
  const a=JSON.parse(readFileSync(join(aDir,"receipt.json"),"utf8")),b=JSON.parse(readFileSync(join(bDir,"receipt.json"),"utf8"));
  compareInputs(a,b);
  for(const [r,d] of [[a,aDir],[b,bDir]])if(r.archiveSha256!==hash(join(d,"payload.tar.gz")))throw Error("Archive readback mismatch");
  const archiveEqual=readFileSync(join(aDir,"payload.tar.gz")).equals(readFileSync(join(bDir,"payload.tar.gz")));
  if(JSON.stringify(a.groups)!==JSON.stringify(manifest(aDir))||JSON.stringify(b.groups)!==JSON.stringify(manifest(bDir)))throw Error("Artifact readback mismatch");
  const differences=diffManifests(a.groups,b.groups);
  for(const d of differences.slice(0,40)){
    if(d.kind==="bytes"){
      const x=readFileSync(join(aDir,d.group,d.path)),y=readFileSync(join(bDir,d.group,d.path));
      let offset=0;while(offset<Math.min(x.length,y.length)&&x[offset]===y[offset])offset++;
      // report location and shape, not the potentially sensitive source bytes
      Object.assign(d,{offset,sizeA:x.length,sizeB:y.length});
      if(d.path.endsWith(".map")){
        try{const p=JSON.parse(x),q=JSON.parse(y);d.mapFields=Object.keys({...p,...q}).filter(k=>JSON.stringify(p[k])!==JSON.stringify(q[k]));d.sourcePathsA=p.sources?.slice(0,2);d.sourcePathsB=q.sources?.slice(0,2);}catch{}
      }
      if(/\.m?js$/.test(d.path)){
        const xTail=x.subarray(Math.max(0,x.length-400)).toString(),yTail=y.subarray(Math.max(0,y.length-400)).toString();
        d.debugIdA=xTail.match(/debugId[=: ]+([a-f0-9-]{36})/i)?.[1];d.debugIdB=yTail.match(/debugId[=: ]+([a-f0-9-]{36})/i)?.[1];
        d.mapRefA=xTail.match(/sourceMappingURL=([^\r\n]+)/)?.[1];d.mapRefB=yTail.match(/sourceMappingURL=([^\r\n]+)/)?.[1];
      }
    }
  }
  const result={schema:"opencode-repro-comparison/v1",commit:a.inputs.commit,tree:a.inputs.tree,runId:a.runId,replicas:[a.replica,b.replica],runnerImageVersions:[a.runnerImageVersion,b.runnerImageVersion],inputs:a.inputs,passed:differences.length===0&&archiveEqual,archiveEqual,archiveSha256:[a.archiveSha256,b.archiveSha256],differenceCount:differences.length,differences:differences.slice(0,40),groups:Object.fromEntries(groups.map(k=>[k,{a:a.groups[k].sha256,b:b.groups[k].sha256,files:a.groups[k].files}]))};
  const principal=a.groups.principal.manifest.filter(([p])=>p!=="README.md");
  if(principal.some(([p])=>!p.endsWith(".js")&&!p.endsWith(".mjs")))throw Error("Unexpected principal module type");
  const mcp=a.groups.mcp.manifest.find(([p])=>p==="worker.js");
  if(!mcp)throw Error("Missing MCP entry");
  result.executable={principalModules:principal.length,principalManifestSha256:createHash("sha256").update(JSON.stringify(principal)).digest("hex"),mcpEntrySha256:mcp[1]};
  console.log(JSON.stringify(result));writeFileSync("repro-comparison.json",JSON.stringify(result,null,2)+"\n");
  if(!result.passed)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [mode,a,b]=process.argv.slice(2);
  if(mode==="record"&&a)record(a);else if(mode==="compare"&&a&&b)compare(a,b);else throw Error("Usage: record DIR | compare A B");
}

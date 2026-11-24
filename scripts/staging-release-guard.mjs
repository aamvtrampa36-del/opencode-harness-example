// Verifies actual package bytes against independently supplied certificate hashes.
// Optional upload creates only an inactive version, never a deployment.
import {createHash} from "node:crypto";
import {readFileSync,realpathSync,statSync} from "node:fs";
import {resolve,join} from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {digestDirectory} from "./staging-release-receipt.mjs";
import {manifest} from "./staging-reproducibility.mjs";
const hash=p=>createHash("sha256").update(readFileSync(p)).digest("hex");
const sha40=/^[a-f0-9]{40}$/,sha64=/^[a-f0-9]{64}$/;
const workerConfig={principal:"principal-effective.json",mcp:"mcp-effective.json"};
const names={principal:"opencode-g1-staging",mcp:"opencode-staging-control-mcp"};
export function moduleManifest(root,kind){
  const r=digestDirectory(root).manifest;
  const files=r.filter(([p])=>p!=="README.md"&&!(kind==="mcp"&&p==="worker.js.map"));
  if(!files.length||files.some(([p])=>!p.endsWith(".js")&&!p.endsWith(".mjs")))throw Error("Unexpected upload module set");
  return files;
}
export function verifyNoBundle(packageRoot,outputRoot,kind){
  if(!(kind in names))throw Error("Unknown worker");
  const a=moduleManifest(packageRoot,kind),b=moduleManifest(outputRoot,kind);
  if(JSON.stringify(a)!==JSON.stringify(b))throw Error("No-bundle upload module set or bytes changed");
  if(!a.some(([p])=>p===(kind==="principal"?"index.js":"worker.js")))throw Error("Entry absent");
  return {kind,files:a.length,sha256:createHash("sha256").update(JSON.stringify(a)).digest("hex")};
}
export function verifyCertificate(c,r,actual,expected){
  if(!sha40.test(expected.commit)||!sha40.test(expected.tree)||!sha64.test(expected.archive)||!sha64.test(expected.certificate))throw Error("Exact externally approved certificate required");
  if(c?.schema!=="opencode-repro-comparison/v1"||!c.passed||!c.archiveEqual||c.differenceCount!==0||JSON.stringify(c.replicas)!=='["a","b"]'||!Array.isArray(c.archiveSha256)||c.archiveSha256.length!==2||!c.archiveSha256.every(h=>h===expected.archive))throw Error("No reproducibility PASS");
  if(c.commit!==expected.commit||c.tree!==expected.tree||r?.inputs?.commit!==expected.commit||r?.inputs?.tree!==expected.tree||r.runId!==c.runId||r.archiveSha256!==expected.archive)throw Error("Wrong package source or CI");
  for(const [key,v] of Object.entries(actual)){
    const x=c.groups?.[key],y=r.groups?.[key];
    if(!x||!y||!sha64.test(v.sha256)||x.a!==v.sha256||x.b!==v.sha256||x.files!==v.files||JSON.stringify(y)!==JSON.stringify(v))throw Error("Certified package mismatch: "+key);
  }
  return true;
}
function main(){
  const [mode,...a]=process.argv.slice(2);
  if(mode==="handoff"&&a.length===3){console.log(JSON.stringify(verifyNoBundle(...a)));return;}
  if(!["verify","upload"].includes(mode)||a.length!==7)throw Error("Usage: verify|upload ROOT CERTIFICATE COMMIT TREE ARCHIVE_SHA CERTIFICATE_SHA principal|mcp");
  const [root,cert,commit,tree,archive,certificate,kind]=a;
  if(!(kind in names))throw Error("Unknown worker");
  const expected={commit,tree,archive,certificate};
  const git=(...args)=>execFileSync("git",args,{encoding:"utf8"}).trim();
  if(git("rev-parse","HEAD")!==commit||git("rev-parse","HEAD^{tree}")!==tree||git("status","--porcelain","--untracked-files=no"))throw Error("Wrong or modified checkout");
  if(hash(cert)!==certificate||hash(join(root,"payload.tar.gz"))!==archive)throw Error("External artifact hash mismatch");
  const c=JSON.parse(readFileSync(cert,"utf8")),r=JSON.parse(readFileSync(join(root,"receipt.json"),"utf8"));
  const actual=manifest(root);verifyCertificate(c,r,actual,expected);
  const cfg=realpathSync(join(root,"configuration",workerConfig[kind])),config=JSON.parse(readFileSync(cfg,"utf8"));
  if(config.name!==names[kind]||config.no_bundle!==true||config.main!==(kind==="principal"?"../principal/index.js":"../mcp/worker.js")||(kind==="principal"&&config.assets?.directory!=="../assets"))throw Error("Wrong release target");
  console.log(JSON.stringify({schema:"opencode-release-guard/v1",kind,commit,tree,archive,certificate,verified:true,uploadRequested:mode==="upload",deploymentRequested:false}));
  if(mode==="upload"){
    // Explicit operator action only. Wrangler versions upload never promotes traffic.
    const p=spawnSync("bunx",["--no-install","wrangler","versions","upload","--no-bundle","--config",cfg,"--tag",commit,"--message","Certified archive "+archive],{stdio:"inherit",shell:false});
    if(p.error||p.status!==0)throw Error("Version upload failed");
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();

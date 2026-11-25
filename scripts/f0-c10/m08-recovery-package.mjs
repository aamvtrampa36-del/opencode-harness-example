import {readFileSync,writeFileSync,rmSync,readdirSync} from "node:fs";
import {join,relative,dirname} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import ts from "typescript";
const hash=x=>createHash("sha256").update(x).digest("hex");
const parse=p=>{const r=ts.parseConfigFileTextToJson(p,readFileSync(p,"utf8"));if(r.error)throw Error("M08_RECOVERY_CONFIG");return r.config;};
const slot=process.env.M08_PACKAGE_INVENTORY_SLOT;if(!["a","b"].includes(slot))throw Error("M08_RECOVERY_SLOT");
const out=join(tmpdir(),"m08-recovery-repro");rmSync(out,{recursive:true,force:true});
const files=root=>readdirSync(root,{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>join(x.parentPath??x.path,x.name)).sort();
const candidates=files("dist").filter(p=>p.endsWith("/wrangler.json")).filter(p=>parse(p).name==="opencode-g1-staging");
if(candidates.length!==1)throw Error("M08_RECOVERY_PRINCIPAL");
const entries=[[candidates[0],"opencode-g1-staging","principal"],["wrangler.mcp-staging.jsonc","opencode-staging-control-mcp","mcp"]];
const result={source:process.env.GITHUB_SHA,mode:"same-source-recovery",deployed:false,restored:false};
for(const [src,name,key] of entries){
 const c=parse(src);if(c.name!==name)throw Error("M08_RECOVERY_TARGET");
 const original=structuredClone(c);
 c.vars={...c.vars,OPENCODE_M08_RECOVERY_MODE:"true"};
 if(c.assets)c.assets.run_worker_first=true;
 // No main/define, class, migration, workflow, image, or binding changes.
 const normalized=structuredClone(c);normalized.vars=original.vars;if(normalized.assets)normalized.assets.run_worker_first=original.assets.run_worker_first;
 if(JSON.stringify(normalized)!==JSON.stringify(original))throw Error("M08_RECOVERY_SCHEMA");
 const bindingKeys=["durable_objects","migrations","workflows","containers","r2_buckets","services","ai","worker_loaders"];
 const bindings=Object.fromEntries(bindingKeys.map(k=>[k,original[k]??null]));
 const path=join(dirname(src),".m08-recovery-"+key+".json");const encoded=JSON.stringify(c);
 try{
  writeFileSync(path,encoded,{flag:"wx"});
  const dest=join(out,key);execFileSync("node_modules/.bin/wrangler",["deploy","--dry-run","--config",path,"--outdir",dest],{stdio:"inherit"});
  const rows=files(dest).filter(x=>relative(dest,x)!=="README.md").map(x=>[relative(dest,x),hash(readFileSync(x))]);
  if(!rows.length)throw Error("M08_RECOVERY_EMPTY");
  result[key]={configSha256:hash(encoded),activeConfigSha256:hash(readFileSync(src)),bindingsSha256:hash(JSON.stringify(bindings)),files:rows.length,sha256:hash(JSON.stringify(rows)),sameSchema:true};
 }finally{rmSync(path,{force:true});}
}
console.log("M08_RECOVERY_PACKAGE "+JSON.stringify(result));
writeFileSync(join(tmpdir(),"m08-recovery-"+slot+".json"),JSON.stringify(result));

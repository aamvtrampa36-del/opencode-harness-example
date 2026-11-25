import {readFileSync,writeFileSync,rmSync,mkdtempSync,readdirSync} from "node:fs";
import {join,relative} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import ts from "typescript";
const hash=x=>createHash("sha256").update(x).digest("hex");
const parse=p=>{const r=ts.parseConfigFileTextToJson(p,readFileSync(p,"utf8"));if(r.error)throw Error("M08_RECOVERY_CONFIG");return r.config;};
const slot=process.env.M08_PACKAGE_INVENTORY_SLOT;if(!["a","b"].includes(slot))throw Error("M08_RECOVERY_SLOT");
const out=join(tmpdir(),"m08-recovery-repro");rmSync(out,{recursive:true,force:true});
const entries=[["wrangler.g1.jsonc","opencode-g1-staging","principal"],["wrangler.mcp-staging.jsonc","opencode-staging-control-mcp","mcp"]];
const result={source:process.env.GITHUB_SHA,mode:"drained-emergency-freeze",deployed:false,restored:false};
for(const [src,name,key] of entries){
 const c=parse(src);if(c.name!==name)throw Error("M08_RECOVERY_TARGET");
 const original={durable_objects:c.durable_objects,migrations:c.migrations??[],workflows:c.workflows??[],containers:c.containers??[],r2_buckets:c.r2_buckets??[],services:c.services??[]};
 c.main="src/metralla-m08-recovery-stop.ts";c.vars={...c.vars,OPENCODE_SUPERVISOR_ENABLED:"false",MCP_ENABLED:"false"};
 // All requests hit the freeze, not the old asset app.
 if(c.assets)c.assets.run_worker_first=true;
 const preserved={durable_objects:c.durable_objects,migrations:c.migrations??[],workflows:c.workflows??[],containers:c.containers??[],r2_buckets:c.r2_buckets??[],services:c.services??[]};
 if(JSON.stringify(original)!==JSON.stringify(preserved))throw Error("M08_RECOVERY_BINDINGS");
 const path=".m08-recovery-"+key+".json";const encoded=JSON.stringify(c);
 try{
  writeFileSync(path,encoded,{flag:"wx"});
  const dest=join(out,key);execFileSync("node_modules/.bin/wrangler",["deploy","--dry-run","--config",path,"--outdir",dest],{stdio:"inherit"});
  const files=readdirSync(dest,{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>join(x.parentPath??x.path,x.name)).sort().filter(x=>relative(dest,x)!=="README.md");
  if(!files.length)throw Error("M08_RECOVERY_EMPTY");
  result[key]={configSha256:hash(encoded),bindingsSha256:hash(JSON.stringify(original)),files:files.length,sha256:hash(JSON.stringify(files.map(x=>[relative(dest,x),hash(readFileSync(x))])))};
 }finally{rmSync(path,{force:true});}
}
console.log("M08_RECOVERY_PACKAGE "+JSON.stringify(result));
writeFileSync(join(tmpdir(),"m08-recovery-"+slot+".json"),JSON.stringify(result));

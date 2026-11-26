
import {readdirSync,readFileSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from "node:fs";
import {join,relative} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const files=(root)=>readdirSync(root,{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>join(x.parentPath??x.path,x.name)).sort();
const digest=(b)=>createHash("sha256").update(b).digest("hex");
const inventory={};const tree=(root,label)=>{const a=files(root).map(p=>[relative(root,p),digest(readFileSync(p))]);if(label)inventory[label]=a;return {files:a.length,sha256:digest(JSON.stringify(a))};};
const configs=files("dist").filter(p=>p.endsWith("/wrangler.json")).map(p=>({p,c:JSON.parse(readFileSync(p,"utf8"))}));
const principal=configs.filter(x=>x.c.name==="opencode-g1-staging");
if(principal.length!==1)throw Error("PILOT_STAGING_CONFIG_NOT_EXACT");
const cfg=principal[0].c;
const names=cfg.durable_objects?.bindings?.map(x=>x.name).sort();
if(JSON.stringify(names)!==JSON.stringify(["DEV","OpenCodeAgent","SESSION_BK","SETTINGS"])||
  cfg.migrations?.at(-1)?.tag!=="v4"||cfg.ai?.binding!=="AI"||cfg.workflows?.[0]?.binding!=="SUPERVISOR_WORKFLOW")
  throw Error("PILOT_STAGING_BINDINGS_MISMATCH");
// M08 CI comparison runs twice from clean dist with the same output path.
const slot=process.env.M08_PACKAGE_INVENTORY_SLOT;
if(slot!==undefined&&!["a","b"].includes(slot))throw Error("M08_PACKAGE_SLOT_INVALID");
const out=slot?join(tmpdir(),"metralla-m08-repro"):mkdtempSync(join(tmpdir(),"pilot-staging-"));
if(slot){rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});}
const run=(config,name)=>{const dir=join(out,name);execFileSync("node_modules/.bin/wrangler",["deploy","--dry-run","--config",config,"--outdir",dir],{stdio:"inherit",env:{...process.env,WRANGLER_SEND_METRICS:"false"}});const raw=tree(dir,name);const rows=inventory[name];const readme=rows.filter(([path])=>path==="README.md");if(readme.length!==1)throw Error("M08_WRANGLER_README_MISSING");const deployable=rows.filter(([path])=>path!=="README.md");if(!deployable.length)throw Error("M08_EMPTY_PAYLOAD");return {...raw,generatedReadmeSha256:readme[0][1],deployable:{files:deployable.length,sha256:digest(JSON.stringify(deployable))}};};
const before={source:process.env.GITHUB_SHA,principalConfig:digest(readFileSync(principal[0].p)),mcpConfig:digest(readFileSync("wrangler.mcp-staging.jsonc")),assets:tree("dist/client","assets"),build:tree("dist","build"),bindings:names,migration:"v4"};
console.log("PILOT_STAGING_PACKAGE "+JSON.stringify({...before,principal:run(principal[0].p,"principal"),mcp:run("wrangler.mcp-staging.jsonc","mcp"),deployed:false}));

if(slot)writeFileSync(join(tmpdir(),"m08-inventory-"+slot+".json"),JSON.stringify(inventory));


import {readdirSync,readFileSync,mkdtempSync} from "node:fs";
import {join,relative} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const files=(root)=>readdirSync(root,{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>join(x.parentPath??x.path,x.name)).sort();
const digest=(b)=>createHash("sha256").update(b).digest("hex");
const tree=(root)=>{const a=files(root).map(p=>[relative(root,p),digest(readFileSync(p))]);return {files:a.length,sha256:digest(JSON.stringify(a))};};
const configs=files("dist").filter(p=>p.endsWith("/wrangler.json")).map(p=>({p,c:JSON.parse(readFileSync(p,"utf8"))}));
const principal=configs.filter(x=>x.c.name==="opencode-g1-staging");
if(principal.length!==1)throw Error("PILOT_STAGING_CONFIG_NOT_EXACT");
const cfg=principal[0].c;
const names=cfg.durable_objects?.bindings?.map(x=>x.name).sort();
if(JSON.stringify(names)!==JSON.stringify(["DEV","OpenCodeAgent","SESSION_BK","SETTINGS"])||
  cfg.migrations?.at(-1)?.tag!=="v4"||cfg.ai?.binding!=="AI"||cfg.workflows?.[0]?.binding!=="SUPERVISOR_WORKFLOW")
  throw Error("PILOT_STAGING_BINDINGS_MISMATCH");
const out=mkdtempSync(join(tmpdir(),"pilot-staging-"));
const run=(config,name)=>{const dir=join(out,name);execFileSync("node_modules/.bin/wrangler",["deploy","--dry-run","--config",config,"--outdir",dir],{stdio:"inherit",env:{...process.env,WRANGLER_SEND_METRICS:"false"}});return tree(dir);};
const before={source:process.env.GITHUB_SHA,principalConfig:digest(readFileSync(principal[0].p)),mcpConfig:digest(readFileSync("wrangler.mcp-staging.jsonc")),assets:tree("dist/client"),build:tree("dist"),bindings:names,migration:"v4"};
console.log("PILOT_STAGING_PACKAGE "+JSON.stringify({...before,principal:run(principal[0].p,"principal"),mcp:run("wrangler.mcp-staging.jsonc","mcp"),deployed:false}));

// Deterministic package generation; output files themselves are what CI certifies.
import {readFileSync,writeFileSync} from "node:fs";
import {resolve,relative,isAbsolute,join,sep} from "node:path";
import {pathToFileURL} from "node:url";
export function packageReadme(raw,worker,epoch){
  const prefix='This folder contains the built output assets for the worker "'+worker+'" generated at ';
  if(!raw.startsWith(prefix)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\.$/.test(raw.slice(prefix.length)))throw Error("Unexpected Wrangler README");
  if(!/^[0-9]+$/.test(String(epoch))||!Number.isSafeInteger(Number(epoch)))throw Error("Invalid source epoch");
  return 'Deterministic package for "'+worker+'"; source commit time '+new Date(Number(epoch)*1000).toISOString()+'.\n';
}
export function relocateSourceMap(m,checkout,commit){
  if(m.version!==3||!isAbsolute(m.sourceRoot)||!Array.isArray(m.sources)||!Array.isArray(m.sourcesContent)||m.sources.length!==m.sourcesContent.length||m.sourcesContent.some(s=>typeof s!=="string")||typeof m.mappings!=="string"||!Array.isArray(m.names)||!/^[0-9a-f]{40}$/.test(commit))throw Error("Unexpected source map");
  const sources=m.sources.map(s=>{
    if(typeof s!=="string")throw Error("Unexpected source path");
    const p=relative(checkout,resolve(m.sourceRoot,s));
    if(!p||p===".."||p.startsWith(".."+sep)||isAbsolute(p))throw Error("Source outside checkout");
    return p.split(sep).join("/");
  });
  return {...m,sourceRoot:"/opencode-source/"+commit+"/",sources};
}
export function principalReleaseConfig(raw){
  if(raw.name!=="opencode-g1-staging"||raw.main!=="index.js"||raw.no_bundle!==true||raw.assets?.directory!=="../client")throw Error("Unexpected generated principal config");
  // These four fields are Vite/Wrangler parser bookkeeping, not Worker settings.
  const {configPath,userConfigPath,topLevelName,definedEnvironments,...settings}=raw;
  return {...settings,main:"../principal/index.js",assets:{...settings.assets,directory:"../assets"}};
}
export function mcpReleaseConfig(raw){
  if(raw.name!=="opencode-staging-control-mcp"||raw.main!=="src/staging-control-mcp/worker.ts")throw Error("Unexpected MCP config");
  return {...raw,main:"../mcp/worker.js",no_bundle:true,rules:[{type:"ESModule",globs:["**/*.js","**/*.mjs"]}]};
}
function main(root){
  if(!root||!process.env.SOURCE_DATE_EPOCH||!process.env.EXPECTED_SHA)throw Error("Missing deterministic build inputs");
  for(const [dir,worker] of [["principal","opencode-g1-staging"],["mcp","opencode-staging-control-mcp"]]){
    const file=join(root,dir,"README.md");
    writeFileSync(file,packageReadme(readFileSync(file,"utf8"),worker,process.env.SOURCE_DATE_EPOCH));
  }
  const map=join(root,"mcp","worker.js.map");
  writeFileSync(map,JSON.stringify(relocateSourceMap(JSON.parse(readFileSync(map,"utf8")),process.cwd(),process.env.EXPECTED_SHA))+"\n");
  const cfg=join(root,"configuration","principal-effective.json");
  const principal=principalReleaseConfig(JSON.parse(readFileSync(cfg,"utf8")));
  writeFileSync(cfg,JSON.stringify(principal,null,2)+"\n");
  writeFileSync(join(root,"configuration","mcp-effective.json"),JSON.stringify(mcpReleaseConfig(JSON.parse(readFileSync(join(root,"configuration","wrangler.mcp-staging.jsonc"),"utf8"))),null,2)+"\n");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv[2]);

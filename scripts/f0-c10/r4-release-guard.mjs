/** Offline content/authorization verifier for explicit Staging version upload.
 * The approved manifest hash MUST be supplied by the deployment administrator,
 * independently of this checkout and of the generated CI receipt.
 * Never promotes traffic; version promotion is a separate Admin operation.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,readdirSync,lstatSync,writeFileSync,realpathSync} from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {parsePilotApproval} from "../../src/pilot-authorization.ts";
import {parseFreezeManifest} from "../../src/supervisor-reconciliation.ts";

const workers={principal:"opencode-g1-staging",mcp:"opencode-staging-control-mcp"};
const hash=b=>createHash("sha256").update(b).digest("hex");
const sha=(v,n=64)=>typeof v==="string"&&v.length===n&&/^[a-f0-9]+$/.test(v);
const uuid=v=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const canon=v=>JSON.stringify(sort(v));
const exact=(a,b)=>assert.equal(canon(a),canon(b));
function inventory(root,normalize){
 const m={};let bytes=0;
 function walk(dir){for(const n of readdirSync(dir).sort()){const p=path.join(dir,n),s=lstatSync(p);
  if(s.isDirectory())walk(p);else{assert(s.isFile()&&!s.isSymbolicLink());const rel=path.relative(root,p);
   bytes+=s.size;assert(bytes<=100*1024*1024&&Object.keys(m).length<2000);
   m[rel]=hash(normalize(rel,readFileSync(p)));
  }}}
 walk(root);assert(Object.keys(m).length>0);
 return {files:Object.keys(m).length,sha256:hash(canon(m))};
}
function normalizedMap(b,repo,tmp){
 const m=JSON.parse(b);
 exact(Object.keys(m).sort(),["mappings","names","sourceRoot","sources","sourcesContent","version"]);
 assert.equal(m.version,3);assert.equal(m.sourceRoot,path.join(tmp,"mcp"));
 m.sources=m.sources.map(s=>{assert.equal(typeof s,"string");assert(!path.isAbsolute(s));
  const rel=path.relative(repo,path.resolve(m.sourceRoot,s));assert(rel&&!path.isAbsolute(rel)&&rel!==".."&&!rel.startsWith("../"));
  return "<REPO>/"+rel;});
 m.sourceRoot="<PILOT_TEMP>/mcp";return Buffer.from(canon(m));
}
function normalizedReadme(b,worker){
 const prefix='This folder contains the built output assets for the worker "'+worker+'" generated at ',s=b.toString();
 assert(s.startsWith(prefix)&&s.endsWith("."));const t=s.slice(prefix.length,-1);
 assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t)&&new Date(t).toISOString()===t);
 return Buffer.from(prefix+"<BUILD_TIMESTAMP>.");
}
function configGuard(c,role){
 assert.equal(c.name,workers[role]);assert.equal(c.preview_urls,false);
 if(role==="principal"){
  assert.equal(c.no_bundle,true);assert.equal(c.main,"index.js");assert.equal(c.assets.directory,"../client");
  exact(c.durable_objects.bindings.map(x=>x.name).sort(),["DEV","OpenCodeAgent","SESSION_BK","SETTINGS"]);
  assert.equal(c.migrations.at(-1).tag,"v4");assert.equal(c.ai.binding,"AI");
  assert.equal(c.workflows[0].binding,"SUPERVISOR_WORKFLOW");
  assert.equal(c.vars.OPENCODE_SUPERVISOR_ENABLED,"true");
  assert(!("OPENCODE_PILOT_HYBRID_REQUEST_ID" in c.vars)&&!("OPENCODE_PILOT_AUTHORIZATION" in c.vars)&&!("OPENCODE_R4_RECONCILIATION" in c.vars));
 }else{
  assert.equal(c.main,"src/staging-control-mcp/worker.ts");
  exact(c.services,[{binding:"STAGING_HEALTH",service:workers.principal}]);
  exact(c.durable_objects.bindings,[{name:"STAGING_SUPERVISOR",class_name:"OpenCodeAgent",script_name:workers.principal}]);
 }
}
export function collect(role,source,repo,tmp){
 assert(role in workers&&sha(source,40));repo=realpathSync(repo);tmp=realpathSync(tmp);
 const dir=path.join(tmp,role),cfgPath=role==="principal"?path.join(repo,"dist/opencode_g1_staging/wrangler.json"):path.join(repo,"wrangler.mcp-staging.jsonc");
 const cfg=JSON.parse(readFileSync(cfgPath,"utf8"));configGuard(cfg,role);
 const normalize=(n,b)=>n==="README.md"?normalizedReadme(b,workers[role]):role==="mcp"&&n==="worker.js.map"?normalizedMap(b,repo,tmp):b;
 const bundle=inventory(dir,normalize),out={schema:"r4-release-inventory-v2",source,role,worker:workers[role],bundle,executable:hash(readFileSync(path.join(dir,role==="principal"?"index.js":"worker.js")))};
 if(role==="principal"){
  const cfgNormalize=(n,b)=>{if(n!=="wrangler.json")return b;const c=JSON.parse(b);
   for(const k of ["configPath","userConfigPath"]){assert.equal(c[k],path.join(repo,"wrangler.g1.jsonc"));c[k]="<REPO>/wrangler.g1.jsonc";}
   return Buffer.from(canon(c));};
  out.assets=inventory(path.join(repo,"dist/client"),(_n,b)=>b);
  out.stage=inventory(path.join(repo,"dist/opencode_g1_staging"),cfgNormalize);
 }else out.config=hash(readFileSync(cfgPath));
 return out;
}
export function verifyApproval(raw,pinned,receipt,observed,now=Date.now()){
 assert(sha(pinned)&&hash(raw)===pinned,"STOP_UNCERTIFIED_STAGING_RELEASE: approval hash");
 const a=JSON.parse(raw);
 assert.equal(a.schema,"r4-explicit-version-upload-v1");
 assert.equal(a.environment,"staging");assert.equal(a.operation,"upload-only");assert.equal(a.uploadAuthorized,true);
 assert.equal(a.source,receipt.source);assert(sha(a.source,40)&&/^\d{1,20}$/.test(a.ciRun));
 assert.equal(a.ciConclusion,"success");assert.equal(a.ciHead,a.source);
 assert(typeof a.approvalRef==="string"&&a.approvalRef.length>=8&&a.approvalRef.length<=160);
 assert(Number.isSafeInteger(a.notBefore)&&Number.isSafeInteger(a.expiresAt)&&a.notBefore<=now&&a.expiresAt>now&&a.expiresAt-now<=3600000);
 assert.equal(a.worker,workers[receipt.role]);assert.equal(a.role,receipt.role);
 assert(sha(a.accountId,32)&&a.accountId===observed.accountId,"account mismatch");
 exact(a.inventory,receipt);
 assert(uuid(a.rollbackDeployment)&&uuid(a.rollbackVersion));
 assert.equal(observed.id,a.rollbackDeployment);exact(observed.versions,[{version_id:a.rollbackVersion,percentage:100}]);
 assert.equal(a.promoteAuthorized,false);
 if(receipt.role==="principal"){
  if(a.maintenance!==undefined){
   assert(!("pilot" in a),"maintenance cannot authorize inference");
   const m=a.maintenance;
   assert(parseFreezeManifest(JSON.stringify(m),a.source,m?.requestId,now)&&m.approvalRef===a.approvalRef,
     "invalid maintenance authorization");
   return a;
  }
  const p=a.pilot;
  assert(p?.schema==="pilot-release-v2"&&p.environment==="staging"&&p.releaseSha===a.source&&p.ciRun===a.ciRun);
  assert(sha(p.requestId,16)&&sha(p.sourceCommit,40)&&sha(p.sourceTree,40)&&/^sha256:[a-f0-9]{64}$/.test(p.containerImageDigest));
  assert(Number.isSafeInteger(p.notBefore)&&p.notBefore<=now&&Number.isSafeInteger(p.expiresAt)&&p.expiresAt>=now+1200000&&p.expiresAt<=now+3600000);
  // Use the actual backend parser, not a second weaker economic schema.
  assert(parsePilotApproval(JSON.stringify(p),a.source,p.requestId,now),"invalid backend pilot authorization");
  assert(p.approvalRef===a.approvalRef&&p.residualRisk==="accepted-bounded-trial"&&sha(p.fingerprint));
  assert(Buffer.byteLength(JSON.stringify(p))<=8192);
 }else assert(!("pilot" in a)&&!("maintenance" in a));
 return a;
}
async function getCurrentDeployment(worker){
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
 assert(sha(account,32)&&typeof token==="string"&&token.length>0,"missing existing runner credential");
 const res=await fetch("https://api.cloudflare.com/client/v4/accounts/"+account+"/workers/scripts/"+worker+"/deployments",
   {headers:{Authorization:"Bearer "+token},redirect:"error",signal:AbortSignal.timeout(15000)});
 assert(res.ok,"rollback readback failed");const json=await res.json();assert.equal(json.success,true);
 const d=json.result.deployments[0];assert(d&&Array.isArray(d.versions));return {accountId:account,id:d.id,versions:d.versions.map(v=>({version_id:v.version_id,percentage:v.percentage}))};
}
function wrangler(args){execFileSync("node_modules/.bin/wrangler",args,{stdio:"inherit",timeout:120000,env:{...process.env,WRANGLER_SEND_METRICS:"false"}});}
async function main(){
 const [mode,role,source,tmp,approvalPath,pin]=process.argv.slice(2),repo=process.cwd();
 assert(mode==="inventory"||mode==="upload","explicit mode required");
 assert.equal(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),source);
 assert.equal(process.env.GITHUB_SHA,source);
 const receipt=collect(role,source,repo,tmp);
 if(mode==="inventory"){console.log("R4_RELEASE_INVENTORY "+JSON.stringify(receipt));return;}
 assert.equal(process.env.WORKERS_CI_COMMIT_SHA,source,"upload only in pinned existing executor");
 assert(approvalPath&&pin,"STOP_UNCERTIFIED_STAGING_RELEASE");
 const raw=readFileSync(approvalPath);assert(raw.length<=32768);
 const a=verifyApproval(raw,pin,receipt,await getCurrentDeployment(receipt.worker));
 // No automatic deployment, no container rollout, no triggers or new resources.
 // Derived config differs only in the pinned prebuilt entry or the two authorized plain-text variables.
 let cfgPath;const vars=[];
 if(role==="principal"){
  cfgPath=path.join(repo,"dist/opencode_g1_staging/wrangler.json");
  configGuard(JSON.parse(readFileSync(cfgPath,"utf8")),role);
  // CLI-only vars keep the verified directory and configuration bytes intact.
  if(a.maintenance)vars.push("--var","OPENCODE_PILOT_HYBRID_REQUEST_ID:"+a.maintenance.requestId,
    "--var","OPENCODE_R4_RECONCILIATION:"+JSON.stringify(a.maintenance));
  else vars.push("--var","OPENCODE_PILOT_HYBRID_REQUEST_ID:"+a.pilot.requestId,
    "--var","OPENCODE_PILOT_AUTHORIZATION:"+JSON.stringify(a.pilot));
 }else{
  const cfg=JSON.parse(readFileSync(path.join(repo,"wrangler.mcp-staging.jsonc"),"utf8"));
  configGuard(cfg,role);cfg.main="mcp/worker.js";cfg.no_bundle=true;
  cfgPath=path.join(tmp,"mcp-prebuilt.json");writeFileSync(cfgPath,JSON.stringify(cfg),{flag:"wx",mode:0o600});
 }
 // Recheck source and deployment immediately before effect. No retries.
 assert.equal(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),source);
 verifyApproval(raw,pin,collect(role,source,repo,tmp),await getCurrentDeployment(receipt.worker));
 wrangler(["versions","upload","--config",cfgPath,"--no-bundle",...vars,"--tag","r4-"+source.slice(0,16),
   "--message","R4 explicitly approved upload-only "+source]);
 console.log("R4_UPLOAD_COMMAND_EXIT_0 "+receipt.worker+" "+source+"; promotion remains external");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error("STOP_UNCERTIFIED_STAGING_RELEASE",e.message);process.exitCode=2;});

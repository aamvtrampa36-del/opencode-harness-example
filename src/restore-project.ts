/** Verified restore of a DO-backed archive into a fresh Linux project. */
export const RESTORE_PROJECT_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, rename, rm, lstat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
const ROOT = process.env.G4_RESTORE_TEST_ROOT || "/workspace/projects";
const [source, target] = process.argv.slice(1);
const SLUG = /^[a-z][a-z0-9-]{0,39}$/;
if (!SLUG.test(source || "") || !SLUG.test(target || "") || source === target) throw Error("Invalid or overlapping project slugs");
const outputDir = join(ROOT,target);
try { await lstat(outputDir); throw Error("Restore target already exists"); }
catch (e) { if (e.code !== "ENOENT") throw e; }
let compressedBytes=0; const chunks=[];
for await (const chunk of process.stdin) {
  compressedBytes+=chunk.byteLength;
  if(compressedBytes > 2*1024*1024) throw Error("Archive exceeds backup limit");
  chunks.push(chunk);
}
const compressed=Buffer.concat(chunks);
if(compressed[0]!==31||compressed[1]!==139) throw Error("Invalid gzip backup");
const archive=gunzipSync(compressed,{maxOutputLength:64*1024*1024});
const field=(b,s,e)=>b.subarray(s,e).toString("utf8").replace(/\0.*$/,"");
function octal(b,s,e){const v=field(b,s,e).trim();if(!/^[0-7]*$/.test(v))throw Error("Invalid tar size");return v?parseInt(v,8):0}
function checkedName(name){
  name=name.replace(/\/$/,"");
  if(name.startsWith("/")||name.includes("\\")||name.includes("\0"))throw Error("Unsafe archive path");
  const parts=name.split("/");
  if(parts[0]!==source||parts.some(x=>!x||x==="."||x===".."))throw Error("Path outside source project");
  return parts.slice(1).join("/");
}
let offset=0,longName=null,paxPath=null,expanded=0;
const entries=[];
while(offset+512<=archive.length){
  const header=archive.subarray(offset,offset+512);
  if(header.every(x=>x===0)) break;
  const size=octal(header,124,136);
  const blockEnd=offset+512+Math.ceil(size/512)*512;
  if(!Number.isSafeInteger(size)||blockEnd>archive.length)throw Error("Truncated tar entry");
  const type=String.fromCharCode(header[156]||48),body=archive.subarray(offset+512,offset+512+size);
  const prefix=field(header,345,500),plainName=field(header,0,100);
  const name=longName||paxPath||(prefix?prefix+"/"+plainName:plainName);
  offset=blockEnd;
  if(type==="L"){longName=body.toString("utf8").replace(/\0.*$/,"");continue}
  if(type==="x"){
    const raw=body.toString("utf8");
    const line=raw.split("\n").find(x=>/^\d+ path=/.test(x));
    paxPath=line?line.replace(/^\d+ path=/,""):null;
    if(raw.includes("GNU.sparse")||raw.includes("linkpath="))throw Error("Unsupported tar metadata");
    continue;
  }
  if(type==="g")throw Error("Global tar headers unsupported");
  const relative=checkedName(name);
  longName=null;paxPath=null;
  if(type!=="0"&&type!=="5")throw Error("Links and special files refused");
  if(type==="0"&&!relative)throw Error("Regular file at root");
  expanded+=size;
  if(expanded>48*1024*1024||entries.length>3000)throw Error("Project too large");
  entries.push({relative,type,data:body});
}
if(!entries.length||longName||paxPath)throw Error("Invalid backup contents");
// A restored Container starts with an empty filesystem; recreate the project root first.
await mkdir(ROOT,{recursive:true});
const temporary=await mkdtemp(join(ROOT,".restore-"+target+"-")),root=join(temporary,target);
try {
  await mkdir(root);
  for(const entry of entries){
    if(!entry.relative)continue;
    const dst=resolve(root,entry.relative);
    if(!dst.startsWith(root+sep))throw Error("Path escape");
    if(entry.type==="5")await mkdir(dst,{recursive:true});
    else {
      await mkdir(resolve(dst,".."),{recursive:true});
      await writeFile(dst,entry.data,{flag:"wx",mode:0o644});
    }
  }
  const files=entries.filter(e=>e.type==="0").sort((a,b)=>a.relative.localeCompare(b.relative));
  const before=createHash("sha256"),after=createHash("sha256");
  for(const f of files){
    before.update(f.relative+"\0");before.update(createHash("sha256").update(f.data).digest());
    const bytes=await readFile(resolve(root,f.relative));
    after.update(f.relative+"\0");after.update(createHash("sha256").update(bytes).digest());
  }
  const expected=before.digest("hex"),actual=after.digest("hex");
  if(actual!==expected)throw Error("Restored files fail SHA-256");
  try {await lstat(outputDir);throw Error("Restore target already exists");}
  catch(e){if(e.code!=="ENOENT")throw e;}
  if(process.env.G4_TEST_FAIL_BEFORE_COMMIT==="1")throw Error("G4 simulated interrupted restore");
  await rename(root,outputDir);
  process.stdout.write(JSON.stringify({source,target,files:files.length,sha256:actual,bytes:expanded}));
} finally {
  await rm(temporary,{recursive:true,force:true});
}
`;

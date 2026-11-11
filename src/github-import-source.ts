/**
 * Import a trusted-identity GitHub tarball, without passing credentials to Linux.
 * Archive content is still untrusted: reject traversal, links and special files.
 * The destination is published only after all files pass a readback digest.
 */
export const GITHUB_IMPORT_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, rename, rm, lstat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
const ROOT = process.env.IMPORT_TEST_ROOT || "/workspace/projects";
const [target] = process.argv.slice(1);
if (!/^[a-z][a-z0-9-]{0,39}$/.test(target || "")) throw Error("Invalid project");
const output = join(ROOT, target);
try { await lstat(output); throw Error("Destination already exists"); }
catch (e) { if (e.code !== "ENOENT") throw e; }
const chunks=[]; let compressed=0;
for await (const chunk of process.stdin) {
  compressed += chunk.byteLength;
  if (compressed > 16*1024*1024) throw Error("Compressed archive exceeds safe memory capacity");
  chunks.push(chunk);
}
const data=Buffer.concat(chunks);
if (data[0]!==31 || data[1]!==139) throw Error("Invalid gzip archive");
const archive=gunzipSync(data,{maxOutputLength:96*1024*1024});
const field=(b,s,e)=>b.subarray(s,e).toString("utf8").replace(/\0.*$/,"");
const octal=(b,s,e)=>{const x=field(b,s,e).trim();if(!/^[0-7]*$/.test(x))throw Error("Invalid tar number");return x?parseInt(x,8):0};
function pax(bytes) {
  const out={}; let i=0;
  while(i<bytes.length) {
    const space=bytes.indexOf(32,i);
    if(space<0)throw Error("Invalid PAX record");
    const len=Number(bytes.subarray(i,space).toString("ascii"));
    if(!Number.isSafeInteger(len)||len<=space-i+2||i+len>bytes.length||bytes[i+len-1]!==10)throw Error("Invalid PAX length");
    const line=bytes.subarray(space+1,i+len-1).toString("utf8"), eq=line.indexOf("=");
    if(eq<1)throw Error("Invalid PAX key");
    const key=line.slice(0,eq), value=line.slice(eq+1);
    if(!["path","comment","mtime","atime","ctime"].includes(key)||value.includes("\0"))throw Error("Unsupported PAX metadata");
    out[key]=value; i+=len;
  }
  return out;
}
let offset=0, root=null, longName=null, paxName=null, expanded=0;
const entries=[];
while(offset+512<=archive.length) {
  const header=archive.subarray(offset,offset+512);
  if(header.every(x=>x===0))break;
  const stored=octal(header,148,156);
  let checksum=0;
  for(let j=0;j<512;j++)checksum+=(j>=148&&j<156)?32:header[j];
  if(checksum!==stored)throw Error("Invalid tar checksum");
  const size=octal(header,124,136), mode=octal(header,100,108);
  const end=offset+512+Math.ceil(size/512)*512;
  if(!Number.isSafeInteger(size)||end>archive.length)throw Error("Truncated tar entry");
  const type=String.fromCharCode(header[156]||48), body=archive.subarray(offset+512,offset+512+size);
  const prefix=field(header,345,500), plain=field(header,0,100);
  const name=longName||paxName||(prefix?prefix+"/"+plain:plain);
  offset=end;
  if(type==="L"){longName=body.toString("utf8").replace(/\0.*$/,"");continue}
  if(type==="x"||type==="g"){
    const parsed=pax(body);
    if(type==="g"&&parsed.path)throw Error("Global archive path refused");
    if(type==="x")paxName=parsed.path||null;
    continue;
  }
  longName=null;paxName=null;
  if(type!=="0"&&type!=="5")throw Error("Archive links and special files refused");
  const clean=name.replace(/\/$/,"");
  if(clean.startsWith("/")||clean.includes("\\")||clean.includes("\0"))throw Error("Unsafe archive path");
  const parts=clean.split("/");
  if(parts.some(x=>!x||x==="."||x===".."))throw Error("Unsafe archive path");
  root ||= parts[0];
  if(parts[0]!==root)throw Error("Archive has multiple roots");
  const relative=parts.slice(1).join("/");
  if(type==="0"&&!relative)throw Error("File at archive root");
  expanded+=size;
  if(expanded>80*1024*1024 || entries.length>=15000)throw Error("Archive exceeds safe extraction capacity");
  entries.push({relative,type,data:body,mode});
}
if(!root||!entries.length||longName||paxName)throw Error("Incomplete archive");
await mkdir(ROOT,{recursive:true});
const temporary=await mkdtemp(join(ROOT,".import-"+target+"-")), staged=join(temporary,target);
try {
  await mkdir(staged);
  for(const entry of entries){
    if(!entry.relative)continue;
    const dst=resolve(staged,entry.relative);
    if(!dst.startsWith(staged+sep))throw Error("Path escape");
    if(entry.type==="5")await mkdir(dst,{recursive:true});
    else {
      await mkdir(resolve(dst,".."),{recursive:true});
      await writeFile(dst,entry.data,{flag:"wx",mode:(entry.mode&0o111)?0o755:0o644});
    }
  }
  const files=entries.filter(e=>e.type==="0").sort((a,b)=>a.relative.localeCompare(b.relative));
  const before=createHash("sha256"),after=createHash("sha256");
  for(const f of files){
    before.update(f.relative+"\0");before.update(createHash("sha256").update(f.data).digest());
    const bytes=await readFile(resolve(staged,f.relative));
    after.update(f.relative+"\0");after.update(createHash("sha256").update(bytes).digest());
  }
  const expected=before.digest("hex"), actual=after.digest("hex");
  if(expected!==actual)throw Error("Import readback hash mismatch");
  try {await lstat(output);throw Error("Destination already exists");}
  catch(e){if(e.code!=="ENOENT")throw e;}
  await rename(staged,output);
  process.stdout.write(JSON.stringify({target,files:files.length,sha256:actual,bytes:expanded}));
} finally { await rm(temporary,{recursive:true,force:true}); }
`;

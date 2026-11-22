#!/usr/bin/env python3
"""F0-OOM-02/T04: pure offline artifact verifier. Never contacts Cloudflare."""
import argparse
from collections import Counter
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import zipfile

SOURCE = "19bba24d81be5b0673acbf2a56b500aed4fa0b66"
RUN = "45038446357"
EXPECTED = {
 "main": ("707afab14232ea867eed4de187069f2514bbc8c4ceacce50a6a538a619d84a59",
          "opencode-g1-staging", 543, {"SHA256SUMS","manifest.json","payload.tar.gz","prebuilt-report.json","prebuilt-main.tar.gz"}),
 "mcp": ("4c268d686cb0bdb60ef790da20525e287627fcc1df128b511a1974e2cf41563d",
         "opencode-staging-control-mcp", 4, {"SHA256SUMS","manifest.json","payload.tar.gz"}),
}
MCP_SHA = "4b9323d8df60605132521bb0075045e7d75445f0dc898a8ec358ade5ce836a50"

def require(condition, message):
 if not condition: raise RuntimeError(message)

def sha(data): return sha256(data).hexdigest()

def safe(path):
 p = PurePosixPath(path)
 require(path and not path.startswith("/") and "\\" not in path and
         ".." not in p.parts and "." not in p.parts, "UNSAFE_ARCHIVE_PATH")
 return p

def extract_verified(raw, dest, inventory):
 dest.mkdir(parents=True, exist_ok=False)
 actual={}
 with tarfile.open(fileobj=BytesIO(raw), mode="r:gz") as tar:
  for item in tar:
   name=item.name.rstrip("/")
   rel=safe(name)
   require(item.isfile() or item.isdir(), "UNSAFE_ARCHIVE_MEMBER")
   target=dest.joinpath(*rel.parts)
   if item.isdir(): target.mkdir(parents=True, exist_ok=True); continue
   require(name not in actual, "DUPLICATE_ARCHIVE_MEMBER")
   target.parent.mkdir(parents=True, exist_ok=True)
   with tar.extractfile(item) as source:
    data=source.read()
   target.write_bytes(data)
   actual[name]={"path":name,"bytes":len(data),"sha256":sha(data)}
 if inventory is not None:
  want={i["path"]:i for i in inventory}
  require(len(want)==len(inventory) and actual==want,"INVENTORY_OR_BYTE_HASH_MISMATCH")
 return actual

def jsonc(path):
 return json.loads(re.sub(r"^\s*//.*$", "", path.read_text(), flags=re.M))

def unpack(kind, zip_path, root):
 zip_sha, worker, count, files=EXPECTED[kind]
 require(sha(zip_path.read_bytes())==zip_sha,kind+":ZIP_SHA256_MISMATCH")
 with zipfile.ZipFile(zip_path) as z:
  require(set(z.namelist())==files and len(z.namelist())==len(files),kind+":ZIP_FILESET_CHANGED")
  for info in z.infolist():
   safe(info.filename)
   require(((info.external_attr >> 16)&0o170000)!=0o120000,kind+":ZIP_SYMLINK")
  data={n:z.read(n) for n in z.namelist()}
 sums={}
 for line in data["SHA256SUMS"].decode().splitlines():
  match=re.fullmatch(r"([a-f0-9]{64})  ([a-zA-Z0-9_.-]+)",line)
  require(match is not None,kind+":BAD_SHA256SUMS")
  hash_value,name=match.groups()
  require(name in data and name not in sums and sha(data[name])==hash_value,
          kind+":SHA256SUMS_MISMATCH")
  sums[name]=hash_value
 require(set(sums)==files-{"SHA256SUMS"},kind+":INCOMPLETE_SHA256SUMS")
 manifest=json.loads(data["manifest.json"])
 require(manifest["sourceSha"]==SOURCE and str(manifest["workflowRunId"])==RUN and
         manifest["workerName"]==worker and len(manifest["inventory"])==count and
         manifest.get("directlyDeployable") is False,kind+":PROVENANCE_MISMATCH")
 if kind=="main":
  require(manifest["contentArchiveSha256"]==sums["payload.tar.gz"] and
          manifest["wranglerVersion"]=="4.158.0" and manifest["bunVersion"]=="1.4.4" and
          manifest["migrationTag"]=="v4" and manifest["omittedFiles"]==[],
          "MAIN_BUILD_METADATA_MISMATCH")
 target=root/kind
 original=extract_verified(data["payload.tar.gz"],target,manifest["inventory"])
 config_name="wrangler.g1.jsonc" if kind=="main" else "wrangler.mcp-staging.jsonc"
 original_config=target/config_name
 require(sha(original_config.read_bytes())==manifest["configSha256"],kind+":CONFIG_SHA_MISMATCH")
 config=jsonc(original_config)
 require(config["name"]==worker,kind+":WRONG_WORKER")
 receipt={"worker":worker,"zipSha256":zip_sha,"payloadSha256":sums["payload.tar.gz"],
          "sourceSha":SOURCE,"filesVerified":len(original)}
 if kind=="main":
  require(config["main"]=="src/entrypoint.ts" and config["migrations"][-1]["tag"]=="v4",
          "MAIN_SOURCE_CONFIG_MISMATCH")
  require((target/"dist/client/index.html").is_file(),"MAIN_ASSETS_MISSING")
  generated=target/"dist/opencode_g1_staging/wrangler.json"
  old_bytes=generated.read_bytes()
  g=json.loads(old_bytes)
  require(g["name"]==worker and g["main"]=="index.js" and g["no_bundle"] is True and
          g["assets"]["directory"]=="../client","MAIN_GENERATED_CONFIG_MISMATCH")
  proof=json.loads(data["prebuilt-report.json"])
  require(proof["sourceSha"]==SOURCE and proof["moduleCount"]==228 and
          proof["moduleByteIdentical"] is True and
          proof["cloudflareVersionUploaded"] is False and
          proof["changesLimitedToGeneratedConfigMetadata"] is True and
          sha(old_bytes)==proof["relocation"]["oldConfigSha256"],"MAIN_PREBUILT_PROOF_MISMATCH")
  prebuilt=extract_verified(data["prebuilt-main.tar.gz"],root/"prebuilt-files",None)
  source_js={p.removeprefix("dist/opencode_g1_staging/"):v["sha256"]
             for p,v in original.items() if p.startswith("dist/opencode_g1_staging/") and p.endswith(".js")}
  prebuilt_js={p.removeprefix("prebuilt-main/"):v["sha256"]
               for p,v in prebuilt.items() if p.startswith("prebuilt-main/") and p.endswith(".js")}
  require(len(source_js)==228 and source_js==prebuilt_js,"MAIN_PREBUILT_MODULES_CHANGED")
  for key in ("configPath","userConfigPath"):
   require(isinstance(g.get(key),str) and g[key].endswith("/wrangler.g1.jsonc"),
           "MAIN_RELOCATION_NOT_METADATA_ONLY")
   g[key]=str(original_config.resolve())
  generated.write_text(json.dumps(g)+"\n")
  receipt["unchangedJSModules"]=228
  receipt["relocatedConfigSha256"]=sha(generated.read_bytes())
 else:
  require(config["main"]=="src/staging-control-mcp/worker.ts" and
          any(s.get("binding")=="STAGING_HEALTH" and s.get("service")=="opencode-g1-staging" for s in config["services"]) and
          any(d.get("name")=="STAGING_SUPERVISOR" and d.get("script_name")=="opencode-g1-staging" and d.get("class_name")=="OpenCodeAgent" for d in config["durable_objects"]["bindings"]),
          "MCP_BINDINGS_OR_ENTRYPOINT_MISMATCH")
  module=target/".f0-oom02/mcp-dry-run/worker.js"
  require(sha(module.read_bytes())==MCP_SHA and
          b"SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED" in module.read_bytes(),
          "MCP_BYTE_HASH_OR_GUARD_MISMATCH")
  derived=dict(config)
  derived.update(main=".f0-oom02/mcp-dry-run/worker.js",
                 no_bundle=True,find_additional_modules=False)
  derived_file=target/"wrangler.prebuilt-mcp.json"
  derived_file.write_text(json.dumps(derived,indent=2)+"\n")
  receipt["unchangedMcpJsSha256"]=MCP_SHA
  receipt["derivedConfigSha256"]=sha(derived_file.read_bytes())
 return receipt

if __name__=="__main__":
 p=argparse.ArgumentParser()
 p.add_argument("--main-zip",type=Path,required=True)
 p.add_argument("--mcp-zip",type=Path,required=True)
 p.add_argument("--output",type=Path,required=True)
 args=p.parse_args()
 require(not args.output.exists(),"REFUSE_TO_OVERWRITE_PREPARED_OUTPUT")
 args.output.mkdir(parents=True)
 results={kind:unpack(kind,input_file,args.output)
          for kind,input_file in (("main",args.main_zip),("mcp",args.mcp_zip))}
 results["status"]="INTEGRITY_VERIFIED_NO_UPLOAD"
 (args.output/"transfer-receipt.json").write_text(json.dumps(results,indent=2)+"\n")
 print(json.dumps(results,indent=2))

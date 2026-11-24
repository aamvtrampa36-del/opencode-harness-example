#!/usr/bin/env python3
"""R4 offline release verifier. Never deploys or creates a pilot grant."""
import argparse, hashlib, io, json, pathlib, re, tarfile, zipfile, sys, datetime
SOURCE="42574cb3f5ee0cbfab2ce54176145c089edc41df"
CI="45326449041"
PACKAGE_RUN="45329083188"
WORKFLOW="f89b7b8c8b113b39be0ee8aa614223ad1bc93736"
EXPECTED={"source":SOURCE,"principalConfig":"482d0de2134f6ca9ca31a1197fc2f4835fc844b070b7a2f93caf27560f010e5f","mcpConfig":"31907fc438748600c198eaef9d85d204838f63e47a0134bc0dfe8f1559878e54","assets":{"files":308,"sha256":"be169d6ee98822f733d89029136f925d59cef10ff6932c1988e5fb1e97e51fe7"},"build":{"files":768,"sha256":"293ed81d578c6ff8b0ed6ce574e8ba806a0a9da7692a93923902f52d7243c806"},"bindings":["DEV","OpenCodeAgent","SESSION_BK","SETTINGS"],"migration":"v4","deployed":False}
LIMIT=100*1024*1024
ZIP_NAMES={"SHA256SUMS","inventory.json","payload.tar.gz","provenance.json","receipt.json"}
WORKERS={"principal":"opencode-g1-staging","mcp":"opencode-staging-control-mcp"}
def require(ok,message):
    if not ok: raise ValueError(message)
def digest(b): return hashlib.sha256(b).hexdigest()
def canonical(x): return json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
def parse_json(b):
    def pairs(p):
        d={}
        for k,v in p:
            require(k not in d,"duplicate JSON key")
            d[k]=v
        return d
    return json.loads(b,object_pairs_hook=pairs)
def safe_path(s):
    p=pathlib.PurePosixPath(s)
    require(s==p.as_posix() and not p.is_absolute() and ".." not in p.parts and "\\" not in s and "\x00" not in s,"unsafe path")
    return s
def tree(files,prefix):
    items=[[p[len(prefix):],digest(b)] for p,b in sorted(files.items()) if p.startswith(prefix)]
    return {"files":len(items),"sha256":digest(json.dumps(items,ensure_ascii=False,separators=(",",":")).encode())}
def load(path,expected_sha):
    raw=pathlib.Path(path).read_bytes()
    require(len(raw)<=LIMIT and digest(raw)==expected_sha,"outer ZIP SHA-256 mismatch")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        require(len(z.infolist())==len(ZIP_NAMES) and set(z.namelist())==ZIP_NAMES,"ZIP membership mismatch")
        require(sum(i.file_size for i in z.infolist())<=LIMIT,"ZIP size bound")
        inner={n:z.read(n) for n in ZIP_NAMES}
    sums={}
    for line in inner["SHA256SUMS"].decode().splitlines():
        h,n=line.split("  ",1)
        require(n in ZIP_NAMES-{"SHA256SUMS"} and n not in sums,"unexpected checksum entry")
        sums[n]=h
    require(set(sums)==ZIP_NAMES-{"SHA256SUMS"} and all(digest(inner[n])==h for n,h in sums.items()),"inner checksum mismatch")
    inv=parse_json(inner["inventory.json"])
    prov=parse_json(inner["provenance.json"])
    receipt=parse_json(inner["receipt.json"])
    require(prov["source"]==SOURCE and prov["workflow_run"]==PACKAGE_RUN and prov["workflow_sha"]==WORKFLOW and prov["status"]=="DIAGNOSTIC_NOT_DEPLOYABLE","provenance mismatch")
    require(all(receipt[k]==v for k,v in EXPECTED.items()),"source/build receipt mismatch")
    files={}; total=0
    with tarfile.open(fileobj=io.BytesIO(inner["payload.tar.gz"]),mode="r:gz") as t:
        for m in t:
            safe_path(m.name)
            require(m.name=="payload" or m.name.startswith("payload/"),"wrong tar root")
            if m.isdir(): continue
            require(m.isfile() and not m.issparse(),"nonregular tar member")
            n=m.name[len("payload/"):]
            total+=m.size
            require(n not in files and total<=LIMIT and len(files)<2000,"duplicate or oversized tar")
            files[n]=t.extractfile(m).read()
    require(inv=={n:{"sha256":digest(b),"size":len(b)} for n,b in files.items()},"file inventory mismatch")
    for k,prefix in [("assets","dist/client/"),("build","dist/"),("principal","principal/"),("mcp","mcp/")]:
        require(tree(files,prefix)==receipt[k],"tree digest mismatch: "+k)
    cfg=[n for n,b in files.items() if n.startswith("dist/") and n.endswith("/wrangler.json") and parse_json(b).get("name")==WORKERS["principal"]]
    require(len(cfg)==1 and digest(files[cfg[0]])==EXPECTED["principalConfig"],"principal config mismatch")
    require(digest(files["wrangler.mcp-staging.jsonc"])==EXPECTED["mcpConfig"],"MCP config mismatch")
    return files,prov,receipt
def normalize(name,b,prov):
    if name in ("principal/README.md","mcp/README.md"):
        worker=WORKERS[name.split("/")[0]]
        prefix='This folder contains the built output assets for the worker "'+worker+'" generated at '
        text=b.decode("utf-8")
        require(text.startswith(prefix) and text.endswith("."),"unexpected README")
        stamp=text[len(prefix):-1]
        require(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z",stamp) is not None,"unexpected README timestamp")
        datetime.datetime.fromisoformat(stamp.replace("Z","+00:00"))
        return (prefix+"<BUILD_TIMESTAMP>.").encode()
    if name=="mcp/worker.js.map":
        m=parse_json(b)
        require(set(m)=={"version","sources","sourceRoot","sourcesContent","mappings","names"} and m["version"]==3,"unexpected source map structure")
        root=m["sourceRoot"]
        require(re.fullmatch(re.escape(prov["tmpdir"])+r"/pilot-staging-[A-Za-z0-9]{6}/mcp",root) is not None,"unexpected sourceRoot")
        # Only a generated temporary path may vary. Other fields compare in full.
        m["sourceRoot"]="<PILOT_TEMP>/mcp"
        return canonical(m)
    return b
def compare(a,b,pa,pb):
    require(set(a)==set(b),"file membership differs")
    differences=[]; normalized={}
    for n in sorted(a):
        if a[n]!=b[n]:
            require(n in ("principal/README.md","mcp/README.md","mcp/worker.js.map"),"unexpected byte difference: "+n)
            require(normalize(n,a[n],pa)==normalize(n,b[n],pb),"unexpected metadata difference: "+n)
            differences.append(n)
        normalized[n]=digest(normalize(n,a[n],pa))
    return differences,digest(canonical(normalized))
def self_test():
    p={"tmpdir":"/tmp/tmp.abc"}
    def rejects(f):
        try: f()
        except (ValueError,KeyError,TypeError): return
        raise RuntimeError("negative test unexpectedly accepted")
    n="principal/README.md"; a=b'This folder contains the built output assets for the worker "opencode-g1-staging" generated at 2026-11-24T04:50:22.315Z.'
    b=a.replace(b"22.315",b"18.721")
    require(compare({n:a},{n:b},p,p)[0]==[n],"README normalization")
    rejects(lambda:compare({"principal/worker.js":b"a"},{"principal/worker.js":b"b"},p,p))
    rejects(lambda:compare({n:a},{n:b+" bad".encode()},p,p))
    rejects(lambda:safe_path("../bad"))
    rejects(lambda:parse_json(b'{"x":1,"x":2}'))
    m={"version":3,"sources":["src"],"sourceRoot":"/tmp/tmp.abc/pilot-staging-ABC123/mcp","sourcesContent":["x"],"mappings":"AAA","names":[]}
    q=dict(m,sourceRoot="/tmp/tmp.abc/pilot-staging-DEF123/mcp")
    require(compare({"mcp/worker.js.map":canonical(m)},{"mcp/worker.js.map":canonical(q)},p,p)[0]==["mcp/worker.js.map"],"sourceRoot normalization")
    rejects(lambda:compare({"mcp/worker.js.map":canonical(m)},{"mcp/worker.js.map":canonical(dict(q,mappings="BBB"))},p,p))
    rejects(lambda:compare({"mcp/worker.js.map":canonical(m)},{"mcp/worker.js.map":canonical(dict(q,sourceRoot="/bad"))},p,p))
    rejects(lambda:compare({"a":b"x"},{"b":b"x"},p,p))
    print("R4_SELFTEST 9 PASS")
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--self-test",action="store_true")
    p.add_argument("--a");p.add_argument("--b");p.add_argument("--sha-a");p.add_argument("--sha-b")
    args=p.parse_args()
    if args.self_test: self_test()
    if not args.a:
        require(args.self_test,"no artifacts")
        return 0
    a,pa,ra=load(args.a,args.sha_a);b,pb,rb=load(args.b,args.sha_b)
    diffs,h=compare(a,b,pa,pb)
    out={"schema":"r4-preflight-v1","source":SOURCE,"sourceCI":CI,"packageRun":PACKAGE_RUN,"workflowSha":WORKFLOW,"archiveDigests":{"a":args.sha_a,"b":args.sha_b},"files":len(a),"differences":diffs,"normalizedInventorySha256":h,"rawBundleReceipts":{"a":ra,"b":rb},"packageIntegrity":"PASS","reproducibility":"PASS_METADATA_ONLY","releaseDecision":"STOP","reasons":["deployment executor byte handoff not certified","container image identity and compatibility not certified","exclusive lane and no ambiguous effects not certified","fresh economic and authorization v2 review required","offline-only scope"],"providerDispatchAuthorized":False,"completePass":False}
    print(json.dumps(out,sort_keys=True))
    return 2
if __name__=="__main__":
    try: sys.exit(main())
    except Exception as e:
        print(json.dumps({"releaseDecision":"STOP","packageIntegrity":"FAIL","error":str(e),"providerDispatchAuthorized":False,"completePass":False}))
        sys.exit(1)

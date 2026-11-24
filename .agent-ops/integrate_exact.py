#!/usr/bin/env python3
"""Exact-snapshot main integrator. Run trusted ops code, not candidate code, with write access."""
import argparse, hashlib, json, os, pathlib, re, subprocess, sys, tempfile, time
OWNER="aamvtrampa36-del"
PROJECTS={"cdf-cloud-engine","CDF-WorkBench-","opencode-harness-example"}
OPS="ops/task-checkpoints-v1"
REQ=".agent-ops/main-integration-request.json"
SCRIPT=".agent-ops/integrate_exact.py"
WORKFLOW=".github/workflows/agent-main-integration.yml"
HEX=re.compile(r"^[0-9a-f]{40}$")
DENY=re.compile(r"\b(?:NO[\s_-]*(?:MERGE|FUSIONAR|FUSION|FUSIÓN|DEPLOY)|NO[ _-]*PUBLICAR|STOP_LIVE|OFFLINE STOP|CI ONLY|SIN FUSIONAR|DO NOT MERGE|EXPERIMENT(?:O|AL)?|POC)\b",re.I)
def require(ok, reason):
    if not ok: raise RuntimeError(reason)
def sha(s): return isinstance(s,str) and bool(HEX.fullmatch(s))
def cmd(args,cwd=None,check=True,timeout=60):
    p=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if check and p.returncode: raise RuntimeError(args[0]+" failed (exit "+str(p.returncode)+")")
    return p
def git(*a,cwd=None,check=True,timeout=60): return cmd(["git","-c","core.hooksPath=/dev/null",*a],cwd,check,timeout)
def out(p): return p.stdout.decode("utf8","strict").strip()
def gh(path): return json.loads(cmd(["gh","api",path],timeout=25).stdout)
def ancestor(a,b,cwd=None): return git("merge-base","--is-ancestor",a,b,cwd=cwd,check=False).returncode==0
def emit(x): print(json.dumps(x,separators=(",",":"),ensure_ascii=True),flush=True)
def output(k,v):
    with open(os.environ["GITHUB_OUTPUT"],"a") as f: f.write(k+"="+str(v)+"\n")
def scope():
    repo=os.environ["GITHUB_REPOSITORY"]
    require(repo in {OWNER+"/"+p for p in PROJECTS} and os.environ.get("GITHUB_REF")=="refs/heads/"+OPS,"scope denied")
    return repo
def validate_req(r,repo):
    require(isinstance(r,dict) and set(r)<= {"schema","enabled","pr","base","head","tree","request_id","acceptance","deployment","dependencies"},"unknown request fields")
    require(r.get("schema")=="agent-main-integration/v1" and type(r.get("enabled")) is bool,"invalid schema")
    if not r["enabled"]: return False
    require(set(r)=={"schema","enabled","pr","base","head","tree","request_id","acceptance","deployment","dependencies"},"missing request fields")
    require(type(r["pr"]) is int and 0<r["pr"]<10000000 and all(sha(r[k]) for k in ("base","head","tree")),"invalid refs")
    require(r["request_id"]==hashlib.sha256((repo+":"+str(r["pr"])+":"+r["base"]+":"+r["head"]+":"+r["tree"]).encode()).hexdigest(),"invalid operation identity")
    a=r["acceptance"]; d=r["deployment"]
    require(isinstance(a,dict) and set(a)=={"reviewed","reference","lane","scope"} and a["reviewed"] is True and a["scope"]=="exact-head-base-tree" and a["lane"] in {"cloud-tech","workbench-editorial","opencode-tech","owner-approved-integrator"},"missing trusted handoff")
    require(isinstance(a["reference"],str) and re.fullmatch(r"https://github\.com/"+re.escape(repo)+r"/(?:pull|issues)/[1-9][0-9]*(?:#(?:issuecomment|pullrequestreview)-[0-9]+)?",a["reference"]),"invalid review reference")
    require(isinstance(d,dict) and set(d)=={"mode","reference","observed_at"} and d["mode"] in {"NO_DEPLOY","EXPLICIT_RELEASE"} and isinstance(d["reference"],str) and 1<=len(d["reference"])<=240 and type(d["observed_at"]) is int,"deployment clearance required")
    require(isinstance(r["dependencies"],list) and len(r["dependencies"])<=16 and all(type(x) is int and 0<x<10000000 and x!=r["pr"] for x in r["dependencies"]),"invalid dependencies")
    return True
def read_req(repo):
    r=json.loads(pathlib.Path(REQ).read_text())
    return r,validate_req(r,repo)
def pr_ok(p,r,repo):
    require(p.get("number")==r["pr"] and p.get("state")=="open" and not p.get("draft") and not p.get("merged"),"PR not open and ready")
    require(p["base"]["ref"]=="main" and p["base"]["repo"]["full_name"]==repo and p["head"]["repo"]["full_name"]==repo and p["head"]["sha"]==r["head"],"PR identity or head changed")
    require(not DENY.search((p.get("title") or "")+" "+(p.get("body") or "")+" "+" ".join(x.get("name","") for x in p.get("labels",[]))),"restriction or experiment")
    require(not p.get("requested_reviewers") and not p.get("requested_teams"),"pending review")
def changes(base,tree):
    raw=git("diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z",base,tree,"--").stdout
    paths=[x.decode("utf8","strict") for x in raw.split(b"\0") if x]
    require(0<len(paths)<=80,"empty or oversized candidate")
    for p in paths:
        require(len(p)<240 and not any(ord(c)<32 for c in p) and not p.startswith((".github/",".agent-ops/","deploy/")) and not re.search(r"(^|/)(AGENTS\.md|SKILL\.md|\.gitmodules|\.gitattributes|\.gitconfig|\.gitignore|wrangler[^/]*|Dockerfile[^/]*|package(-lock)?\.json|bun\.lockb?|uv\.lock|pyproject\.toml|\.npmrc|\.env[^/]*|CODEOWNERS)$",p,re.I),"sensitive policy/build/dependency path")
    # Scope narrower than blanket authorization: non-regular files or mode changes need manual review.
    raw=git("diff","--raw","--no-renames","-z",base,tree,"--").stdout.split(b"\0")
    for v in raw:
        if v.startswith(b":"):
            parts=v.split()
            require(parts[0] in (b":100644",b":000000") and parts[1] in (b"100644",b"000000"),"nonregular or executable change")
    return paths
def deployment_gate(repo,r,paths):
    d=r["deployment"]; now=int(time.time())
    require(0<=now-d["observed_at"]<=7200,"deployment assessment expired")
    if d["mode"]=="EXPLICIT_RELEASE":
        # This is a separately recorded owner authorization, not inferred from merge permission.
        require(d["reference"].startswith("owner-explicit-release:"),"missing separate release authorization")
        return
    require(repo==OWNER+"/cdf-cloud-engine","known main-triggered deploy; separate release clearance required")
    require(d["reference"]=="cloudflare-live-no-deploy:8f152306-cca8-44c4-ad7b-1b1330738554","unrecognized deployment assessment")
    # Strict conservative allowlist: docs/README and tests that do not trigger known bridge builds.
    require(all(p=="README.md" or p.startswith(("docs/","tests/")) for p in paths),"no-deploy path scope not proven")
def refs(repo,r):
    root="repos/"+repo
    main=gh(root+"/git/ref/heads/main")["object"]["sha"]
    require(sha(main),"main unavailable")
    p=gh(root+"/pulls/"+str(r["pr"]))
    return main,p
def tree_for(r):
    require(ancestor(r["base"],r["base"]) and not ancestor(r["head"],r["base"]),"candidate already contained or unavailable")
    m=git("merge-tree","--write-tree",r["base"],r["head"],check=False)
    require(m.returncode==0,"combined tree conflict")
    t=out(m).splitlines()[0]
    require(t==r["tree"],"combined tree changed")
    require(git("diff","--check",r["base"],t,"--",check=False).returncode==0,"static diff check failed")
    return t
def check_live(repo,r):
    main,p=refs(repo,r)
    require(main==r["base"],"main changed")
    pr_ok(p,r,repo)
    root="repos/"+repo
    for dep in r["dependencies"]:
        q=gh(root+"/pulls/"+str(dep))
        require(q.get("merged") and q.get("base",{}).get("ref")=="main" and sha(q.get("merge_commit_sha")) and ancestor(q["merge_commit_sha"],main),"dependency not integrated")
    # Reject changes to control files after dispatch; exact source branch, not main.
    for path in (REQ,SCRIPT,WORKFLOW):
        blob=out(git("rev-parse","HEAD:"+path))
        remote=gh(root+"/contents/"+path+"?ref=ops%2Ftask-checkpoints-v1")
        require(remote["sha"]==blob,"operational input changed")
    t=tree_for(r)
    paths=changes(r["base"],t)
    deployment_gate(repo,r,paths)
    return t
def commit_for(r,t):
    git("config","user.name","CDF integration coordinator")
    git("config","user.email","integration@users.noreply.github.com")
    return out(git("commit-tree",t,"-p",r["base"],"-p",r["head"],"-m","Integrate PR #"+str(r["pr"])+" ["+r["request_id"]+"]"))
def cas_push(cwd,remote,ref,base,candidate):
    require(ref in ("refs/heads/main","refs/heads/integration"),"ref denied")
    require(sha(base) and sha(candidate) and ancestor(base,candidate,cwd),"non-fast-forward denied")
    # Exact lease is only a compare-and-swap; ancestry above forbids history rewrite.
    return git("push","--porcelain","--force-with-lease="+ref+":"+base,remote,candidate+":"+ref,cwd=cwd,check=False,timeout=60)
def integrated(repo,r,main):
    if main==r["base"]: return None
    # Only exact result at current tip or GitHub's recorded merge commit reachable from main.
    p=gh("repos/"+repo+"/pulls/"+str(r["pr"]))
    c=p.get("merge_commit_sha") if p.get("merged") else main
    if not sha(c) or not ancestor(c,main): return None
    z=gh("repos/"+repo+"/git/commits/"+c)
    if [x["sha"] for x in z["parents"]]==[r["base"],r["head"]] and z["tree"]["sha"]==r["tree"]: return c
    return None
def prepare():
    repo=scope();r,enabled=read_req(repo)
    output("enabled","false")
    if not enabled: emit({"status":"IDLE","main_write":False});return
    main,_=refs(repo,r)
    prior=integrated(repo,r,main)
    if prior: emit({"status":"ALREADY_INTEGRATED","sha":prior,"operation_id":r["request_id"]});return
    t=check_live(repo,r)
    for k in ("base","head","tree","request_id"): output(k,r[k])
    output("enabled","true")
    emit({"status":"PREPARED","tree":t,"pr":r["pr"],"operation_id":r["request_id"]})
def checkout_candidate():
    repo=scope();r,enabled=read_req(repo);require(enabled,"disabled")
    t=tree_for(r)
    require(t==os.environ["EXPECTED_TREE"] and r["base"]==os.environ["EXPECTED_BASE"] and r["head"]==os.environ["EXPECTED_HEAD"],"validation identity mismatch")
    c=commit_for(r,t);git("checkout","--detach",c)
    require(out(git("rev-parse","HEAD^{tree}"))==t,"wrong test tree")
    emit({"status":"VALIDATION_TREE","tree":t})
def apply():
    repo=scope();r,enabled=read_req(repo);require(enabled,"disabled")
    require(os.environ.get("VALIDATION_RESULT")=="success" and all(r[k]==os.environ.get("EXPECTED_"+k.upper()) for k in ("base","head","tree","request_id")),"validation not bound to request")
    main,_=refs(repo,r);prior=integrated(repo,r,main)
    if prior: emit({"status":"ALREADY_INTEGRATED","sha":prior,"operation_id":r["request_id"]});return
    t=check_live(repo,r);c=commit_for(r,t)
    require(ancestor(r["head"],c),"candidate missing head")
    cmd(["gh","auth","setup-git"],timeout=20)
    check_live(repo,r)
    try: p=cas_push(None,"origin","refs/heads/main",r["base"],c);exit_code=p.returncode
    except subprocess.TimeoutExpired: exit_code=None
    # Never retry a failed or ambiguous push; reconcile from remote.
    actual,pr=refs(repo,r)
    require(actual==c,"push rejected, uncertain or external writer moved main; reconcile before retry")
    z=gh("repos/"+repo+"/git/commits/"+c)
    require([x["sha"] for x in z["parents"]]==[r["base"],r["head"]] and z["tree"]["sha"]==t,"remote result mismatch")
    # PR metadata can lag; distinguish integrated commit from GitHub marking the PR merged.
    result={"status":"INTEGRATED_VERIFIED","pr":r["pr"],"sha":c,"base":r["base"],"head":r["head"],"tree":t,"operation_id":r["request_id"],"push_exit":exit_code,"pr_merged":bool(pr.get("merged")),"pr_head_changed":pr["head"]["sha"]!=r["head"],"deployment":"NOT_VERIFIED","run_id":int(os.environ["GITHUB_RUN_ID"])}
    emit(result)
    pathlib.Path("main-integration-receipt.json").write_text(json.dumps(result,indent=2)+"\n")
    # Durable receipt, independent from queue; next scan recomputes from actual main.
    root="repos/"+repo+"/contents/.agent-ops/main-integration-receipt.json"
    old=cmd(["gh","api",root+"?ref=ops%2Ftask-checkpoints-v1"],check=False,timeout=25)
    import base64
    body={"branch":OPS,"message":"Persist verified main integration receipt [skip ci]","content":base64.b64encode(pathlib.Path("main-integration-receipt.json").read_bytes()).decode()}
    if old.returncode==0: body["sha"]=json.loads(old.stdout)["sha"]
    else: require(b"404" in old.stderr,"receipt lookup failed")
    q=subprocess.run(["gh","api","--method","PUT",root,"--input","-"],input=json.dumps(body),text=True,capture_output=True,timeout=25)
    require(q.returncode==0,"main integrated; receipt publication failed; reconcile, never repeat push")
def selftest():
    with tempfile.TemporaryDirectory() as tmp:
        p=pathlib.Path(tmp);r=p/"remote.git";w=p/"work";w.mkdir()
        git("init","--bare",str(r));git("init","-b","main",cwd=w)
        git("config","user.name","fixture",cwd=w);git("config","user.email","fixture@example.invalid",cwd=w)
        def commit(name,content):
            (w/name).write_text(content);git("add",name,cwd=w);git("commit","-qm",name,cwd=w);return out(git("rev-parse","HEAD",cwd=w))
        b=commit("a","base\n");git("push",str(r),b+":refs/heads/integration",cwd=w)
        a=commit("a","approved\n");git("checkout","--detach",b,cwd=w);x=commit("b","other writer\n")
        require(cas_push(w,str(r),"refs/heads/integration",b,a).returncode==0,"initial CAS")
        require(cas_push(w,str(r),"refs/heads/integration",b,x).returncode!=0,"stale CAS allowed")
        require(out(git("ls-remote",str(r),"refs/heads/integration",cwd=w)).split()[0]==a,"remote changed")
        require(cas_push(w,str(r),"refs/heads/integration",b,a).returncode==0 or out(git("ls-remote",str(r),"refs/heads/integration",cwd=w)).split()[0]==a,"idempotence")
        try: cas_push(w,str(r),"refs/heads/integration",a,x);raise AssertionError("nonfastforward accepted")
        except RuntimeError: pass
        try: cas_push(w,str(r),"refs/heads/other",b,a);raise AssertionError("wrong ref accepted")
        except RuntimeError: pass
        require(validate_req({"schema":"agent-main-integration/v1","enabled":False},OWNER+"/cdf-cloud-engine")==False,"idle policy")
        for bad in ({"schema":"agent-main-integration/v1","enabled":True},{"schema":"agent-main-integration/v1","enabled":False,"other":True}):
            try: validate_req(bad,OWNER+"/cdf-cloud-engine");raise AssertionError("invalid request accepted")
            except RuntimeError: pass
        emit({"selftest":"PASS","real_bare_remote":True,"external_stale_write_rejected":True,"nonfastforward_rejected":True,"scope_rejected":True,"idle_no_write":True})
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("mode",choices=["selftest","prepare","checkout","apply"]);a=p.parse_args()
    try: {"selftest":selftest,"prepare":prepare,"checkout":checkout_candidate,"apply":apply}[a.mode]()
    except Exception as e: emit({"status":"BLOCKED","reason":str(e)[:200]});sys.exit(1)

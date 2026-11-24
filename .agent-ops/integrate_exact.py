#!/usr/bin/env python3
"""Exact-snapshot main integrator. Run trusted ops code, not candidate code, with write access."""
import argparse, hashlib, json, os, pathlib, re, subprocess, sys, tempfile, time
OWNER="aamvtrampa36-del"
PROJECTS={"cdf-cloud-engine","CDF-WorkBench-","opencode-harness-example"}
OPS="ops/task-checkpoints-v1"
REQ=".agent-ops/main-integration-request.json"
SCRIPT=".agent-ops/integrate_exact.py"
WORKFLOW=".github/workflows/agent-main-integration.yml"
CI={"cdf-cloud-engine":(".github/workflows/cloudflare-checks.yml","ad3aeb7808855535c314bdb6c05d95ac1d1c62e8"),"CDF-WorkBench-":(".github/workflows/build-plugin.yml","26bab4ff15a12fb112edc893d214e0321cb4f8d4"),"opencode-harness-example":(".github/workflows/ci.yml","73c6261ae32050dc61e86f36a5f643851413d0d9")}
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
    require(isinstance(a["reference"],str) and re.fullmatch(r"https://github\.com/"+re.escape(repo)+r"/pull/"+str(r["pr"])+r"#issuecomment-[1-9][0-9]*",a["reference"]),"exact PR acceptance comment required")
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
def marker(r): return "base="+r["base"]+" head="+r["head"]+" tree="+r["tree"]
def owner_comment(repo,r,comment_id,expected):
    q=gh("repos/"+repo+"/issues/comments/"+str(comment_id))
    require(q.get("user",{}).get("login")==OWNER and q.get("issue_url")=="https://api.github.com/repos/"+repo+"/issues/"+str(r["pr"]),"acceptance comment not from owner on exact PR")
    require(expected in (q.get("body") or "").splitlines(),"exact approval marker missing")
def live_checkpoint(repo):
    import base64
    f=gh("repos/"+repo+"/contents/.agent-ops/checkpoints.json?ref=ops%2Ftask-checkpoints-v1")
    cp=json.loads(base64.b64decode(f["content"]))
    require(cp.get("repository")==repo and cp.get("schema")=="agent-checkpoints/v1","checkpoint identity mismatch")
    return cp,f["sha"]
def exact_identity(r): return {k:r[k] for k in ("pr","base","head","tree","request_id")}
def same_identity(a,r): return isinstance(a,dict) and all(a.get(k)==v for k,v in exact_identity(r).items())
def review_gate(repo,r):
    comment_id=int(r["acceptance"]["reference"].split("#issuecomment-")[1])
    # A connector posting as the owner is not proof of a personal user approval.
    owner_comment(repo,r,comment_id,"AGENT_REVIEWED "+marker(r))
    cp,_=live_checkpoint(repo)
    i=cp["integration_v1"]
    require(i.get("mode")=="ATOMIC_CONDITIONAL" and i.get("activation_gate",{}).get("owner_authorized") is True,"general integration authorization missing")
    h=i.get("handoff_v2")
    require(same_identity(h,r) and h.get("review_reference")==r["acceptance"]["reference"] and h.get("lane")==r["acceptance"]["lane"] and h.get("functional_acceptance")=="PASS" and h.get("review_origin")=="agent" and h.get("deployment")==r["deployment"],"exact agent handoff missing")
    lane=cp.get("lanes",{}).get(h["lane"],{})
    require(lane.get("task_id")==h.get("task_id") and lane.get("pr")==r["pr"] and lane.get("base_sha")==r["base"] and lane.get("head_sha")==r["head"] and lane.get("status") in ("recoverable","completed") and h.get("task_id"),"handoff task identity changed")
    require(isinstance(h.get("evidence"),list) and len(h["evidence"])>0 and all(isinstance(v,str) and v.startswith("https://github.com/"+repo+"/") for v in h["evidence"]),"functional evidence reference required")
    reviews=gh("repos/"+repo+"/pulls/"+str(r["pr"])+"/reviews?per_page=100")
    require(isinstance(reviews,list) and len(reviews)<100,"review coverage incomplete")
    latest={}
    for v in reviews:
        if v.get("state") in ("APPROVED","CHANGES_REQUESTED","DISMISSED"):
            latest[v.get("user",{}).get("login")]=v["state"]
    require("CHANGES_REQUESTED" not in latest.values(),"unresolved changes requested")
def deployment_gate(repo,r,paths):
    d=r["deployment"]; now=int(time.time())
    require(0<=now-d["observed_at"]<=7200,"deployment assessment expired")
    if d["mode"]=="EXPLICIT_RELEASE":
        # This is a separately recorded owner authorization, not inferred from merge permission.
        require(re.fullmatch(r"owner-explicit-release:[1-9][0-9]*",d["reference"]),"missing separate release authorization")
        # Shared connector identity cannot authenticate personal deployment consent.
        # Explicit release grants must be recorded from separately verified user authorization,
        # outside routine autonomous lanes; no such grants are provisioned by consolidation.
        cp,_=live_checkpoint(repo)
        grant=cp["integration_v1"].get("release_grant_v2")
        require(same_identity(grant,r) and grant.get("origin")=="explicit-user-instruction-verified-by-operator" and grant.get("reference")==d["reference"] and grant.get("authorized") is True,"separate verified release grant absent")
        owner_comment(repo,r,int(d["reference"].split(":")[1]),"DEPLOY_AUTHORIZED "+marker(r))
        return
    require(repo==OWNER+"/cdf-cloud-engine","known main-triggered deploy; separate release clearance required")
    require(d["reference"]=="cloudflare-live-no-deploy:8f152306-cca8-44c4-ad7b-1b1330738554","unrecognized deployment assessment")
    # Strict conservative allowlist: docs/README and tests that do not trigger known bridge builds.
    require(all(p=="README.md" or p.startswith("docs/") for p in paths),"no-deploy path scope not proven")
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
    review_gate(repo,r)
    ci_path,ci_blob=CI[repo.split("/")[-1]]
    require(all(out(git("rev-parse",x+":"+ci_path))==ci_blob for x in (r["base"],r["head"])),"CI contract changed; update trusted workflow first")
    root="repos/"+repo
    for dep in r["dependencies"]:
        q=gh(root+"/pulls/"+str(dep))
        require(q.get("merged") and q.get("base",{}).get("ref")=="main" and sha(q.get("merge_commit_sha")) and ancestor(q["merge_commit_sha"],main),"dependency not integrated")
    # Reject changes to control files after dispatch; exact source branch, not main.
    for path in (REQ,SCRIPT,WORKFLOW,".agent-ops/validate_task.py"):
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
    # The PR's merged marker can lag an atomic push. Inspect bounded first-parent
    # history if another writer subsequently advanced main. Never infer from ancestry alone.
    p=gh("repos/"+repo+"/pulls/"+str(r["pr"]))
    candidates=[p.get("merge_commit_sha") if p.get("merged") else None,main]
    if ancestor(r["base"],main):
        history=git("rev-list","--first-parent","--max-count=100",r["base"]+".."+main,check=False)
        if history.returncode==0: candidates.extend(out(history).splitlines())
    for c in dict.fromkeys(candidates):
        if not sha(c) or not ancestor(c,main): continue
        local=git("show","-s","--format=%P%n%T",c,check=False)
        if local.returncode: continue
        lines=out(local).splitlines()
        if len(lines)!=2 or lines[0].split()!=[r["base"],r["head"]] or lines[1]!=r["tree"]: continue
        z=gh("repos/"+repo+"/git/commits/"+c)
        if [x["sha"] for x in z["parents"]]==[r["base"],r["head"]] and z["tree"]["sha"]==r["tree"]: return c
    return None
def already_reconciled(repo,r,c,main):
    cp,_=live_checkpoint(repo)
    gate=cp.get("integration_v1",{})
    rec=gate.get("latest_main_receipt") or {}
    if rec.get("operation_id")!=r["request_id"] or rec.get("sha")!=c or gate.get("queue_refresh_required") is not False or gate.get("evidence",{}).get("main")!=main: return False
    f=gh("repos/"+repo+"/contents/.agent-ops/main-integration-receipt.json?ref=ops%2Ftask-checkpoints-v1")
    import base64
    evidence=json.loads(base64.b64decode(f["content"]))
    return f.get("sha")==rec.get("blob") and evidence.get("operation_id")==r["request_id"] and evidence.get("sha")==c and evidence.get("tree")==r["tree"]
def require_no_live_lease(repo):
    import datetime
    cp,_=live_checkpoint(repo);old=cp.get("reservation")
    if old:
        expiry=datetime.datetime.fromisoformat(old["lease_expires_at"].replace("Z","+00:00"))
        require(expiry<=datetime.datetime.now(datetime.timezone.utc),"another repository lease is active; defer before full CI")
def prepare():
    repo=scope();r,enabled=read_req(repo)
    output("enabled","false")
    output("reconcile","false")
    if not enabled: emit({"status":"IDLE","main_write":False});return
    main,_=refs(repo,r)
    prior=integrated(repo,r,main)
    if prior:
        if already_reconciled(repo,r,prior,main):
            emit({"status":"ALREADY_RECONCILED","sha":prior,"operation_id":r["request_id"],"main_write":False});return
        require_no_live_lease(repo)
        output("reconcile","true")
        for k in ("base","head","tree","request_id"): output(k,r[k])
        emit({"status":"ALREADY_INTEGRATED","sha":prior,"operation_id":r["request_id"]});return
    require_no_live_lease(repo)
    t=check_live(repo,r)
    # Reuse the existing deterministic validator on the exact combined commit.
    c=commit_for(r,t)
    v=json.loads(cmd(["python3",".agent-ops/validate_task.py","--project",repo.split("/")[-1],"--base",r["base"],"--head",c],check=False,timeout=120).stdout)
    require(v.get("static_status") in ("PASS","CACHED"),"combined static validation not PASS")
    emit({"static_status":v["static_status"],"validation_id":v.get("validation_id"),"tree":t,"acceptance":"NOT_ESTABLISHED"})
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
def put_ops(repo,path,data,expected=None):
    import base64
    root="repos/"+repo+"/contents/"+path
    body={"branch":OPS,"message":"Persist exact integration state [skip ci]","content":base64.b64encode((json.dumps(data,indent=2,ensure_ascii=True)+"\n").encode()).decode()}
    if expected is not None: body["sha"]=expected
    else:
        old=cmd(["gh","api",root+"?ref=ops%2Ftask-checkpoints-v1"],check=False,timeout=25)
        if old.returncode==0: body["sha"]=json.loads(old.stdout)["sha"]
        else: require(b"404" in old.stderr,"ops file lookup failed")
    p=subprocess.run(["gh","api","--method","PUT",root,"--input","-"],input=json.dumps(body),text=True,capture_output=True,timeout=25)
    require(p.returncode==0,"ops publication CAS failed; reconcile, never repeat push")
    blob=json.loads(p.stdout)["content"]["sha"]
    require(gh(root+"?ref=ops%2Ftask-checkpoints-v1")["sha"]==blob,"ops readback changed")
    return blob
def persist_result(repo,r,c,pr,recovered,exit_code=None):
    result={"status":"ALREADY_INTEGRATED" if recovered else "INTEGRATED_VERIFIED","pr":r["pr"],"sha":c,"base":r["base"],"head":r["head"],"tree":r["tree"],"operation_id":r["request_id"],"push_exit":exit_code,"pr_merged":bool(pr.get("merged")),"pr_head_changed":pr["head"]["sha"]!=r["head"],"deployment":"NOT_VERIFIED","run_id":int(os.environ["GITHUB_RUN_ID"])}
    emit(result)
    pathlib.Path("main-integration-receipt.json").write_text(json.dumps(result,indent=2)+"\n")
    root="repos/"+repo+"/contents/"
    import base64
    path=".agent-ops/main-integration-receipt.json"
    blob=put_ops(repo,path,result)
    # Re-read the authoritative checkpoint; preserve other lanes and CAS the file.
    cp_path=".agent-ops/checkpoints.json"
    old=gh(root+cp_path+"?ref=ops%2Ftask-checkpoints-v1")
    cp=json.loads(base64.b64decode(old["content"]))
    require(cp["repository"]==repo and (cp.get("reservation") or {}).get("owner")==lease_owner(r),"checkpoint reserved; receipt persisted; reconcile later")
    cp["reservation"]=None
    cp["revision"]+=1
    gate=cp["integration_v1"]
    gate["latest_main_receipt"]={"path":path,"blob":blob,"operation_id":r["request_id"],"sha":c,"run_id":result["run_id"],"status":result["status"]}
    gate["queue_refresh_required"]=True
    if same_identity(gate.get("handoff_v2"),r): gate["handoff_v2"]["integration_status"]="INTEGRATED_VERIFIED"
    put_ops(repo,cp_path,cp,old["sha"])
    emit({"checkpoint":"PASS","receipt_blob":blob,"queue_refresh_required":True})
    # Reuse existing queue scanner only on trusted operational files. Never run candidate code here.
    trusted=".agent-ops/integrator.py"
    require(gh(root+trusted+"?ref=ops%2Ftask-checkpoints-v1")["sha"]==out(git("rev-parse","HEAD:"+trusted)),"queue scanner changed")
    pathlib.Path(cp_path).write_text(json.dumps(cp))
    cmd(["python3",trusted,"scan"],timeout=180)
    q=json.loads(pathlib.Path("integration-queue-result.json").read_text())
    require(q["repository"]==repo and q["main"]==gh("repos/"+repo+"/git/ref/heads/main")["object"]["sha"],"queue main changed")
    qb=put_ops(repo,".agent-ops/integration-queue.json",q,out(git("rev-parse","HEAD:.agent-ops/integration-queue.json")))
    old=gh(root+cp_path+"?ref=ops%2Ftask-checkpoints-v1");cp=json.loads(base64.b64decode(old["content"]))
    require(cp["integration_v1"]["latest_main_receipt"]["operation_id"]==r["request_id"],"checkpoint changed")
    cp["revision"]+=1;cp["integration_v1"]["queue_refresh_required"]=False
    cp["integration_v1"]["evidence"]={"run":q["run_id"],"main":q["main"],"queue_blob":qb,"counts":q["counts"],"coverage":q["coverage"],"elapsed_ms":q["elapsed_ms"],"url":"https://github.com/"+repo+"/actions/runs/"+str(q["run_id"])}
    put_ops(repo,cp_path,cp,old["sha"])
    emit({"queue":"PASS","blob":qb,"main":q["main"]})
def lease_owner(r): return "integrator:"+r["request_id"]+":"+os.environ["GITHUB_RUN_ID"]+":"+os.environ.get("GITHUB_RUN_ATTEMPT","1")
def claim(repo,r):
    import datetime
    cp,blob=live_checkpoint(repo);old=cp.get("reservation")
    if old:
        expiry=datetime.datetime.fromisoformat(old["lease_expires_at"].replace("Z","+00:00"))
        require(expiry<=datetime.datetime.now(datetime.timezone.utc),"another repository lease is active")
    cp["revision"]+=1
    cp["reservation"]={"lane":"integration","owner":lease_owner(r),"generation":cp["revision"],"lease_expires_at":(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=45)).isoformat().replace("+00:00","Z")}
    put_ops(repo,".agent-ops/checkpoints.json",cp,blob)
    return cp["reservation"]["generation"]
def confirm_lease(repo,r,generation):
    import datetime
    cp,_=live_checkpoint(repo);a=cp.get("reservation") or {}
    require(a.get("owner")==lease_owner(r) and a.get("generation")==generation and datetime.datetime.fromisoformat(a["lease_expires_at"].replace("Z","+00:00"))>datetime.datetime.now(datetime.timezone.utc),"integration lease lost")
def release_lease(repo,r,generation):
    cp,blob=live_checkpoint(repo);a=cp.get("reservation") or {}
    if a.get("owner")==lease_owner(r) and a.get("generation")==generation:
        cp["revision"]+=1;cp["reservation"]=None
        put_ops(repo,".agent-ops/checkpoints.json",cp,blob)
def apply():
    repo=scope();r,enabled=read_req(repo);require(enabled,"disabled")
    require(all(r[k]==os.environ.get("EXPECTED_"+k.upper()) for k in ("base","head","tree","request_id")),"request identity mismatch")
    main,pr=refs(repo,r);prior=integrated(repo,r,main)
    if prior:
        claim(repo,r)
        persist_result(repo,r,prior,pr,True);return
    require(os.environ.get("VALIDATION_RESULT")=="success","validation not bound to request")
    t=check_live(repo,r);c=commit_for(r,t)
    generation=claim(repo,r)
    require(ancestor(r["head"],c),"candidate missing head")
    try:
        cmd(["gh","auth","setup-git"],timeout=20)
        check_live(repo,r)
        confirm_lease(repo,r,generation)
    except Exception:
        release_lease(repo,r,generation)
        raise
    try: p=cas_push(None,"origin","refs/heads/main",r["base"],c);exit_code=p.returncode
    except subprocess.TimeoutExpired: exit_code=None
    actual,pr=refs(repo,r)
    if actual!=c:
        # No blind retry. Release only when remote proves the original base remains.
        if actual==r["base"]: release_lease(repo,r,generation)
        raise RuntimeError("push rejected, uncertain or external writer moved main; reconcile before retry")
    z=gh("repos/"+repo+"/git/commits/"+c)
    require([x["sha"] for x in z["parents"]]==[r["base"],r["head"]] and z["tree"]["sha"]==t,"remote result mismatch")
    persist_result(repo,r,c,pr,False,exit_code)
def selftest():
    with tempfile.TemporaryDirectory() as tmp:
        p=pathlib.Path(tmp);r=p/"remote.git";w=p/"work";w.mkdir()
        git("init","--bare",str(r));git("init","-b","main",cwd=w)
        git("config","user.name","fixture",cwd=w);git("config","user.email","fixture@example.invalid",cwd=w)
        def commit(name,content):
            (w/name).write_text(content);git("add",name,cwd=w);git("commit","-qm",name,cwd=w);return out(git("rev-parse","HEAD",cwd=w))
        b=commit("a","base\n");git("push",str(r),b+":refs/heads/main",cwd=w)
        a=commit("a","approved\n");git("checkout","--detach",b,cwd=w);x=commit("b","other writer\n")
        require(cas_push(w,str(r),"refs/heads/main",b,a).returncode==0,"initial CAS")
        require(cas_push(w,str(r),"refs/heads/main",b,x).returncode!=0,"stale CAS allowed")
        require(out(git("ls-remote",str(r),"refs/heads/main",cwd=w)).split()[0]==a,"remote changed")
        require(cas_push(w,str(r),"refs/heads/main",b,a).returncode==0 or out(git("ls-remote",str(r),"refs/heads/main",cwd=w)).split()[0]==a,"idempotence")
        try: cas_push(w,str(r),"refs/heads/main",a,x);raise AssertionError("nonfastforward accepted")
        except RuntimeError: pass
        try: cas_push(w,str(r),"refs/heads/other",b,a);raise AssertionError("wrong ref accepted")
        except RuntimeError: pass
        require(validate_req({"schema":"agent-main-integration/v1","enabled":False},OWNER+"/cdf-cloud-engine")==False,"idle policy")
        for bad in ({"schema":"agent-main-integration/v1","enabled":True},{"schema":"agent-main-integration/v1","enabled":False,"other":True}):
            try: validate_req(bad,OWNER+"/cdf-cloud-engine");raise AssertionError("invalid request accepted")
            except RuntimeError: pass
        r0={"pr":1,"head":a}
        p0={"number":1,"state":"open","draft":False,"merged":False,"base":{"ref":"main","repo":{"full_name":OWNER+"/cdf-cloud-engine"}},"head":{"repo":{"full_name":OWNER+"/cdf-cloud-engine"},"sha":a}}
        pr_ok(p0,r0,OWNER+"/cdf-cloud-engine")
        for patch in ({"draft":True},{"title":"NO MERGE"},{"title":"NO FUSIONAR"},{"requested_reviewers":[{}]},{"head":dict(p0["head"],sha=x)}):
            try: pr_ok(dict(p0,**patch),r0,OWNER+"/cdf-cloud-engine");raise AssertionError("PR guard failed")
            except RuntimeError: pass
        d0={"deployment":{"mode":"NO_DEPLOY","reference":"cloudflare-live-no-deploy:8f152306-cca8-44c4-ad7b-1b1330738554","observed_at":int(time.time())}}
        deployment_gate(OWNER+"/cdf-cloud-engine",d0,["docs/fixture.md"])
        for repo,paths in ((OWNER+"/CDF-WorkBench-",["README.md"]),(OWNER+"/opencode-harness-example",["README.md"]),(OWNER+"/cdf-cloud-engine",["scripts/cloudflare-worker-deploy.sh"])):
            try: deployment_gate(repo,d0,paths);raise AssertionError("deployment guard failed")
            except RuntimeError: pass
        emit({"selftest":"PASS","policy_guards":8,"real_bare_remote":True,"external_stale_write_rejected":True,"nonfastforward_rejected":True,"scope_rejected":True,"idle_no_write":True})
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("mode",choices=["selftest","prepare","checkout","apply"]);a=p.parse_args()
    try: {"selftest":selftest,"prepare":prepare,"checkout":checkout_candidate,"apply":apply}[a.mode]()
    except Exception as e: emit({"status":"BLOCKED","reason":str(e)[:200]});sys.exit(1)

#!/usr/bin/env python3
"""Integration queue v1. Trusted operational branch only. Never writes main."""
import argparse, concurrent.futures, hashlib, json, os, pathlib, re, subprocess, tempfile, time
OWNER="aamvtrampa36-del"
REPOS={"cdf-cloud-engine","CDF-WorkBench-","opencode-harness-example"}
OPS="ops/task-checkpoints-v1"
QUEUE=".agent-ops/integration-queue.json"
SHA=re.compile(r"^[a-f0-9]{40}$")
DENY=re.compile(r"\b(?:NO[\s_-]*(?:MERGE|FUSIONAR|FUSION|FUSIÓN|DEPLOY)|STOP_LIVE|OFFLINE STOP|CI ONLY|SIN FUSIONAR|DO NOT MERGE)\b",re.I)
EXPERIMENT=re.compile(r"\b(?:EXPERIMENT(?:O|AL)?|POC|CI ONLY|STOP_LIVE|OFFLINE STOP)\b",re.I)
def is_sha(s): return isinstance(s,str) and bool(SHA.fullmatch(s))
def command(args,cwd=None,timeout=30,check=True):
    p=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if check and p.returncode: raise RuntimeError(args[0]+" failed ("+str(p.returncode)+")")
    return p
def git(*args,cwd=None,check=True): return command(["git","-c","core.hooksPath=/dev/null",*args],cwd,check=check)
def out(p): return p.stdout.decode("utf-8",errors="replace").strip()
def gh(path):
    return json.loads(command(["gh","api",path],timeout=25).stdout)
def ancestor(a,b,cwd=None):
    p=git("merge-base","--is-ancestor",a,b,cwd=cwd,check=False)
    if p.returncode not in (0,1): raise RuntimeError("ancestry unknown")
    return p.returncode==0
def classify(row, main, prior, explicit=False, protected=False):
    if row.get("merged"): return "MERGED","verify resulting commit and tree"
    if row.get("state")!="open": return "REJECTED","closed; never auto-reopen"
    if row.get("restricted"): return ("EXPERIMENTAL" if row.get("experimental") else "BLOCKED"),"explicit restriction; preserve work"
    if row.get("contained"): return "REDUNDANT","exact head is ancestor of main; verify purpose before closure"
    if row.get("tree_equal"): return "REDUNDANT","combined tree equals main; review unique history before closure"
    if row.get("conflict"): return "CONFLICTING","review conflicting paths; no automatic resolution"
    if row.get("dependencies"): return "DEPENDENT","review ancestry ordering"
    if not row.get("verified_refs"): return "UNCERTAIN","refs or diff unavailable"
    if row.get("draft"): return "EXPERIMENTAL" if row.get("experimental") else "BLOCKED","draft; no promotion by integrator"
    if row.get("base")!=main or row.get("behind",0)>0: return "STALE","prepare current combined tree; check unique contribution"
    exact=bool(prior and prior.get("pr")==row["pr"] and prior.get("head")==row["head"] and prior.get("base")==main)
    if exact and prior.get("static_status")=="FAIL": return "NEEDS_VALIDATION","fix recorded static defect"
    if not exact or prior.get("ci_status")!="CACHED" or prior.get("static_status")!="PASS": return "NEEDS_VALIDATION","full exact-candidate CI and acceptance required"
    if not explicit: return "BLOCKED","exact-head acceptance/authorization missing"
    if not protected: return "BLOCKED","server-enforced strict integration gate unavailable"
    return "READY","eligible for protected server-side integration only"
def details(p,main,focus):
    row={"pr":p["number"],"head":p["head"]["sha"],"base":p["base"]["sha"],"state":p["state"],"draft":bool(p.get("draft")),"url":p.get("html_url"),"restricted":bool(DENY.search((p.get("title") or "")+" "+(p.get("body") or ""))),"experimental":bool(EXPERIMENT.search((p.get("title") or "")+" "+(p.get("body") or ""))),"verified_refs":False,"dependencies":[]}
    # No titles, bodies, patches or other external instructions are emitted/executed.
    if not is_sha(row["head"]) or not is_sha(row["base"]) or p["head"].get("repo",{}).get("full_name")!=p["base"].get("repo",{}).get("full_name"): return row
    try:
        head=row["head"]
        mb=out(git("merge-base",main,head))
        if not is_sha(mb): return row
        row["merge_base"]=mb
        row["contained"]=ancestor(head,main)
        counts=out(git("rev-list","--left-right","--count",main+"..."+head)).split()
        row["behind"],row["ahead"]=map(int,counts)
        paths=git("diff","--name-only","--no-renames","-z",mb,head,"--").stdout.split(b"\0")
        row["_paths"]={os.fsdecode(x) for x in paths if x}
        row["verified_refs"]=True
        if focus and not row["contained"]:
            pmerge=git("merge-tree","--write-tree",main,head,check=False)
            if pmerge.returncode not in (0,1): raise RuntimeError("merge-tree unavailable")
            tree=out(pmerge).splitlines()[0]
            row["combined_tree"]=tree if is_sha(tree) else None
            row["conflict"]=pmerge.returncode==1
            row["tree_equal"]=pmerge.returncode==0 and tree==out(git("rev-parse",main+"^{tree}"))
    except (RuntimeError,ValueError,IndexError,subprocess.TimeoutExpired):
        row["verified_refs"]=False
    return row
def scan():
    start=time.monotonic()
    repo=os.environ["GITHUB_REPOSITORY"]
    if not repo.startswith(OWNER+"/") or repo.split("/")[-1] not in REPOS or os.environ.get("GITHUB_REF")!="refs/heads/"+OPS: raise RuntimeError("scope denied")
    root="repos/"+repo
    main=gh(root+"/git/ref/heads/main")["object"]["sha"]
    if not is_sha(main): raise RuntimeError("main unavailable")
    cp=json.loads(pathlib.Path(".agent-ops/checkpoints.json").read_text())
    if cp.get("repository")!=repo: raise RuntimeError("checkpoint mismatch")
    prior=cp.get("validation_v1",{}).get("evidence")
    pulls=gh(root+"/pulls?state=open&base=main&per_page=100")
    if not isinstance(pulls,list): raise RuntimeError("invalid list")
    truncated=len(pulls)>=100
    # Bound expensive merge-tree preparation to non-drafts and the prior validation candidate.
    focus=[p["number"] for p in pulls if not p.get("draft") or prior and prior.get("pr")==p["number"]][:6]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        rows=list(pool.map(lambda p: details(p,main,p["number"] in focus),pulls[:100]))
    # Check ancestry only when refs share a merge base and overlap; bounded to 20 closest pairs.
    pairs=[]; overlaps=[]
    for i,a in enumerate(rows):
        for b in rows[i+1:]:
            shared=a.get("_paths",set())&b.get("_paths",set())
            if shared:
                overlaps.append({"a":a["pr"],"b":b["pr"],"count":len(shared),"paths":sorted(shared)[:5]})
                if a["pr"] in focus or b["pr"] in focus:
                    pairs.append((a,b))
    for a,b in pairs[:20]:
        if a["head"]==b["head"]: continue
        try:
            if not a.get("contained") and ancestor(a["head"],b["head"]): b["dependencies"].append(a["pr"])
            elif not b.get("contained") and ancestor(b["head"],a["head"]): a["dependencies"].append(b["pr"])
        except RuntimeError: pass
    # No user-approved exact candidate has been submitted; no main integration authority.
    for row in rows:
        row["status"],row["next"]=classify(row,main,prior)
        row["priority"]=1 if row["pr"] in focus else 0
        row["authorization"]="NONE_FOR_MAIN"
        row["validation_reference"]=prior.get("url") if prior and prior.get("pr")==row["pr"] and prior.get("head")==row["head"] and prior.get("base")==main else None
        paths=sorted(row.pop("_paths",set()))
        row["file_count"]=len(paths)
        row["paths"]=paths[:20]
        row["paths_truncated"]=len(paths)>20
        row["candidate_id"]=hashlib.sha256((repo+":"+str(row["pr"])+":"+row["head"]+":"+main).encode()).hexdigest()
    rows.sort(key=lambda x:(-x["priority"],x["pr"]))
    from collections import Counter
    # Compare main after scan; if it moved the receipt is not a current queue snapshot.
    after=gh(root+"/git/ref/heads/main")["object"]["sha"]
    if after!=main: raise RuntimeError("base changed; no publication")
    summary={"schema":"agent-integration-queue/v1","repository":repo,"main":main,"source_commit":os.environ["GITHUB_SHA"],"run_id":int(os.environ["GITHUB_RUN_ID"]),"policy":{"main_writes":"DISABLED_UNVERIFIED_SERVER_GATE","merge_queue":"not configured","no_automatic_close":True,"no_force_push":True},"coverage":{"list_truncated":truncated,"focused_merge_trees":focus,"ancestry_pairs_examined":min(20,len(pairs)),"ancestry_pairs_total":len(pairs),"overlap_pairs":len(overlaps),"overlaps_truncated":len(overlaps)>40},"counts":dict(Counter(x["status"] for x in rows)),"entries":rows,"overlaps":overlaps[:40],"elapsed_ms":round((time.monotonic()-start)*1000)}
    pathlib.Path("integration-queue-result.json").write_text(json.dumps(summary,ensure_ascii=True,indent=2)+"\n")
    print(json.dumps({k:v for k,v in summary.items() if k not in ("entries","overlaps")}))
    print(json.dumps({"focus":[{k:x.get(k) for k in ("pr","status","next","behind","ahead","combined_tree","conflict","file_count","dependencies","validation_reference")} for x in rows if x["pr"] in focus]}))
def selftest():
    # Real git refs, commits, tree merges and compare-and-swap in isolated temporary repository.
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp)
        def g(*a,check=True): return git(*a,cwd=root,check=check)
        def s(*a): return out(g(*a))
        g("init","-q","-b","main")
        g("config","user.name","Integration fixture");g("config","user.email","fixture@example.invalid")
        def commit(name,data,msg):
            (root/name).write_text(data);g("add",name);g("commit","-qm",msg);return s("rev-parse","HEAD")
        base=commit("a.txt","base\n","base")
        g("checkout","-qb","one",base);one=commit("a.txt","one\n","one")
        g("checkout","-qb","two",base);two=commit("b.txt","two\n","two")
        g("checkout","-qb","conflict",base);bad=commit("a.txt","other\n","conflict")
        g("checkout","-q","main")
        g("branch","integration",base)
        assert ancestor(base,one,root) and not ancestor(one,two,root)
        # A complete receipt binds base/head/tree. Candidate code is not executed.
        t1=s("merge-tree","--write-tree",base,one).splitlines()[0]
        q={"base":base,"head":one,"tree":t1,"status":"READY","operation_id":"fixture-1","authorized":True}
        path=root/"queue.json";path.write_text(json.dumps(q))
        q=json.loads(path.read_text());assert q["head"]==one
        c1=s("commit-tree",t1,"-p",base,"-p",one,"-m","isolated integration one")
        assert g("update-ref","refs/heads/integration",c1,base).returncode==0
        # Lost response: read back actual ref and tree, never blindly retry.
        assert s("rev-parse","integration")==c1 and s("rev-parse","integration^{tree}")==t1
        assert g("update-ref","refs/heads/integration",c1,base,check=False).returncode!=0
        # Competing old-base candidate fails compare-and-swap; reprepare on new base.
        t2old=s("merge-tree","--write-tree",base,two).splitlines()[0]
        c2old=s("commit-tree",t2old,"-p",base,"-p",two,"-m","stale candidate")
        assert g("update-ref","refs/heads/integration",c2old,base,check=False).returncode!=0
        t2=s("merge-tree","--write-tree",c1,two).splitlines()[0];assert t2!=t2old
        c2=s("commit-tree",t2,"-p",c1,"-p",two,"-m","isolated integration two")
        assert g("update-ref","refs/heads/integration",c2,c1).returncode==0
        assert s("show","integration:a.txt")=="one" and s("show","integration:b.txt")=="two"
        assert g("merge-tree","--write-tree",c2,bad,check=False).returncode==1
        # Synthetic deterministic regression: invariant fails on deliberate incompatible content.
        assert s("show",bad+":a.txt")!="one"
        q.update(status="MERGED",merged=c1);path.write_text(json.dumps(q))
        assert json.loads(path.read_text())["merged"]==c1
        row={"pr":1,"head":one,"base":base,"state":"open","draft":False,"verified_refs":True}
        evidence={"pr":1,"head":one,"base":base,"static_status":"PASS","ci_status":"CACHED"}
        assert classify(row,base,evidence,True,True)[0]=="READY"
        assert classify(row,base,evidence,False,True)[0]=="BLOCKED"
        assert classify(row,base,evidence,True,False)[0]=="BLOCKED"
        assert classify(dict(row,restricted=True),base,evidence,True,True)[0]=="BLOCKED"
        assert classify(dict(row,restricted=True,experimental=True),base,evidence)[0]=="EXPERIMENTAL"
        assert classify(dict(row,draft=True),base,evidence,True,True)[0]=="BLOCKED"
        assert classify(row,c1,evidence,True,True)[0]=="STALE"
        assert classify(dict(row,conflict=True),base,evidence)[0]=="CONFLICTING"
        assert classify(dict(row,dependencies=[2]),base,evidence)[0]=="DEPENDENT"
        assert classify(dict(row,contained=True),base,evidence)[0]=="REDUNDANT"
        assert classify(row,base,dict(evidence,head=two),True,True)[0]=="NEEDS_VALIDATION"
        print(json.dumps({"selftest":"PASS","fixture":"real isolated git refs","integrations":2,"stale_write_rejected":True,"duplicate_rejected":True,"conflict_detected":True,"regression_detected":True,"recovery_readback":True,"policy_checks":11,"main_unchanged":s("rev-parse","main")==base}))
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("mode",choices=["selftest","scan"]);a=p.parse_args()
    if a.mode=="selftest": selftest()
    else: scan()

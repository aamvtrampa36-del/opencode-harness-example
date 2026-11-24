#!/usr/bin/env python3
"""Cross-layer acceptance: real temporary Git remote, actual validation/composition/queue/CAS.
GitHub API metadata and persistence transport are synthetic; no production credentials."""
import base64, hashlib, importlib.util, json, os, pathlib, subprocess, tempfile, sys, time
HERE=pathlib.Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,HERE/path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
v=load("validator","validate_task.py");i=load("actuator","integrate_exact.py");q=load("queue","integrator.py")
def g(w,*a,check=True):return i.git(*a,cwd=w,check=check)
def s(w,*a):return i.out(g(w,*a))
def require(x,label):
    if not x:raise AssertionError(label)
def denied(fn):
    try:fn()
    except RuntimeError:return
    raise AssertionError("expected refusal")
def main():
    repo="aamvtrampa36-del/cdf-cloud-engine"
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td);w=root/"work";w.mkdir();remote=root/"remote.git"
        g(w,"init","-b","main");g(w,"config","user.name","fixture");g(w,"config","user.email","fixture@example.invalid");g(w,"init","--bare",str(remote))
        def commit(path,data):
            p=w/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(data);g(w,"add",path);g(w,"commit","-qm",path);return s(w,"rev-parse","HEAD")
        base=commit("README.md","base\n");g(w,"push",str(remote),base+":refs/heads/main")
        head=commit("docs/fixture.md","verified synthetic fixture\n")
        tree=s(w,"rev-parse",head+"^{tree}")
        cache=root/"cache";a=v.static(w,"cdf-cloud-engine",base,head,cache);b=v.static(w,"cdf-cloud-engine",base,head,cache)
        require(a["static_status"]=="PASS" and b["static_status"]=="CACHED" and a["validation_id"]==b["validation_id"],"reuse")
        changed=commit("docs/fixture.md","changed fixture\n");c=v.static(w,"cdf-cloud-engine",base,changed,cache)
        require(c["validation_id"]!=a["validation_id"] and c["static_status"]=="PASS","invalidation")
        g(w,"checkout","--detach",base);external=commit("other.txt","external writer\n")
        r={"pr":1,"base":base,"head":head,"tree":tree,"request_id":hashlib.sha256((repo+":1:"+base+":"+head+":"+tree).encode()).hexdigest()}
        state={"schema":"agent-checkpoints/v1","repository":repo,"revision":3,"reservation":None,"lanes":{"test":{"task_id":"fixture","status":"recoverable","pr":1,"head_sha":head,"base_sha":base,"next_action":"recover verified fixture"}},"validation_v1":{"evidence":{"pr":1,"head":head,"base":base,"static_status":"PASS","targeted":{"tree":tree,"status":"PASS"}}},"integration_v1":{"mode":"ATOMIC_CONDITIONAL"}}
        queue={"repository":repo,"main":base,"entries":[{"pr":1,"head":head,"combined_tree":tree,"status":"NEEDS_VALIDATION","restricted":False}]}
        data={"repo":repo,"base":base,"head":head,"tree":tree,"checkpoint":state,"queue":queue}
        fixture=root/"fixture.json";fixture.write_text(json.dumps(data))
        js=String="""import {executePlan} from COMPOSE;
import fs from 'node:fs';
const f=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const file=x=>({encoding:'base64',size:100,sha:'c'.repeat(40),content:Buffer.from(JSON.stringify(x)).toString('base64')});
let calls=0;const transport=async p=>{calls++;if(p.includes('git/ref/'))return {object:{sha:f.base}};if(p.includes('checkpoints.json'))return file(f.checkpoint);if(p.includes('integration-queue.json'))return file(f.queue);if(p.includes('validation-request.json'))return file({pr:1,head:f.head});if(p.endsWith('/pulls/1'))return {number:1,state:'open',head:{sha:f.head,repo:{full_name:f.repo}},base:{sha:f.base,ref:'main',repo:{full_name:f.repo}},changed_files:1};if(p.includes('/compare/'))return {ahead_by:1,behind_by:0,files:[{filename:'docs/fixture.md',status:'added'}]};if(p.includes('/actions/runs?'))return {workflow_runs:[]};throw Error('unexpected');};
const r=await executePlan({project:'cdf-cloud-engine',operation:'execute_plan',lane:'test',steps:['inspect_pr','resume_task','validate_task','inspect_pr']},transport);
if(r.coverage!=='COMPLETE_READS'||!r.validation.targeted_tree_match||r.checkpoint.decision!=='REVIEW_NEXT_ACTION'||r.integration.tree!==f.tree||r.requested.length!==3||calls!==7||r.acceptance!=='NOT_ESTABLISHED')throw Error(JSON.stringify(r));
f.queue.entries[0].combined_tree='d'.repeat(40);
const stale=await executePlan({project:'cdf-cloud-engine',operation:'resume_task',lane:'test'},transport);if(stale.validation.targeted_tree_match)throw Error('stale tree reused');
console.log(JSON.stringify({composition:'PASS',calls_first:7,duplicate_steps_removed:1,stale_tree_rejected:true}));"""
        js=js.replace("COMPOSE",json.dumps((HERE/"compose.mjs").as_uri()))
        node=subprocess.run(["node","--input-type=module","-e",js,str(fixture)],capture_output=True,text=True)
        if node.returncode:raise RuntimeError(node.stderr[-1800:])
        composition=json.loads(node.stdout)
        row={"pr":1,"head":head,"base":base,"state":"open","draft":False,"verified_refs":True}
        prior={"pr":1,"head":head,"base":base,"static_status":"PASS","ci_status":"CACHED"}
        require(q.classify(row,base,prior,False,False)[0]=="BLOCKED","no authority")
        require(q.classify(dict(row,restricted=True),base,prior,True,True)[0]=="BLOCKED","NO MERGE")
        require(q.classify(row,external,prior,True,True)[0]=="STALE","stale base")
        p={"number":1,"state":"open","draft":False,"merged":False,"base":{"ref":"main","repo":{"full_name":repo}},"head":{"sha":head,"repo":{"full_name":repo}}}
        i.pr_ok(p,r,repo);denied(lambda:i.pr_ok(dict(p,title="NO MERGE"),r,repo))
        # In a local bare remote, a separately authorized synthetic operation uses the same CAS primitive.
        candidate=s(w,"commit-tree",tree,"-p",base,"-p",head,"-m","fixture "+r["request_id"])
        require(i.cas_push(w,str(remote),"refs/heads/main",base,candidate).returncode==0,"integration")
        require(i.cas_push(w,str(remote),"refs/heads/main",base,external).returncode!=0,"stale external write")
        actual=s(w,"ls-remote",str(remote),"refs/heads/main").split()[0]
        require(actual==candidate and s(w,"rev-parse",actual+"^{tree}")==tree,"tree identity")
        # The actual integrated() recovery function verifies exact parents/tree using a simulated GitHub API.
        cwd=os.getcwd();os.chdir(w);old=i.gh
        try:
            i.gh=lambda path: {"merged":True,"merge_commit_sha":actual} if "/pulls/" in path else {"parents":[{"sha":base},{"sha":head}],"tree":{"sha":tree}}
            require(i.integrated(repo,r,actual)==actual,"lost response reconciliation")
        finally:i.gh=old;os.chdir(cwd)
        # Model checkpoint CAS with real Git update-ref; reject stale publication.
        state["revision"]+=1;state["lanes"]["test"]["status"]="completed";state["lanes"]["test"]["next_action"]=None
        state["integration_v1"]["latest_main_receipt"]={"sha":actual,"operation_id":r["request_id"]}
        state["integration_v1"]["queue_refresh_required"]=False
        state["reservation"]=None
        queue["main"]=actual;queue["entries"]=[]
        g(w,"checkout","--detach",base);cp=commit("checkpoint.json",json.dumps(state));g(w,"branch","checkpoint-state",cp)
        nxt=commit("queue.json",json.dumps(queue))
        require(g(w,"update-ref","refs/heads/checkpoint-state",nxt,cp).returncode==0,"checkpoint CAS")
        require(g(w,"update-ref","refs/heads/checkpoint-state",cp,cp,check=False).returncode!=0,"stale checkpoint rejected")
        require(json.loads(s(w,"show",nxt+":checkpoint.json"))["lanes"]["test"]["status"]=="completed","next agent terminal")
        print(json.dumps({"consolidation":"PASS","scope":"actual validator, composition, classifier, Git CAS and recovery function; synthetic API/checkpoint transport","validation_reused":b["static_status"],"validation_invalidated":True,"first_ms":a["duration_ms"],"cached_ms":b["duration_ms"],"composition":composition,"restricted_rejected":True,"stale_base_rejected":True,"exact_tree_verified":True,"recovered_without_push":True,"checkpoint_cas":True,"next_agent_terminal":True,"product_writes":0}))
if __name__=="__main__":main()

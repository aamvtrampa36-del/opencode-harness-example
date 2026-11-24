#!/usr/bin/env python3
"""R4 readiness snapshot + staging-only selection; never uploads or activates."""
import argparse, datetime as dt, hashlib, importlib.util, json, math, pathlib, re, sys
spec=importlib.util.spec_from_file_location("r4_preflight",pathlib.Path(__file__).with_name("r4-preflight.py"))
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
BASE="f0-c10/integracion-final-20261123"
PIN="e98e57a3bc0c860440a4a116e57644b990ed5105764567b0cb1158a929b575"
UUID=r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
def ts(x): return dt.datetime.fromisoformat(x.replace("Z","+00:00"))
def expected_bindings(c):
    b=[]
    for n in c.get("vars",{}): b.append([n,"plain_text"])
    if c.get("ai"): b.append([c["ai"]["binding"],"ai"])
    for x in c.get("worker_loaders",[]): b.append([x["binding"],"worker_loader"])
    for x in c.get("r2_buckets",[]): b.append([x["binding"],"r2_bucket",x["bucket_name"]])
    for x in c.get("workflows",[]): b.append([x["binding"],"workflow",x["class_name"],x["name"]])
    for x in c.get("services",[]): b.append([x["binding"],"service",x["service"]])
    for x in c.get("durable_objects",{}).get("bindings",[]):
        b.append([x["name"],"durable_object_namespace",x["class_name"]]+([x["script_name"]] if "script_name" in x else []))
    return sorted(b)
def evaluate(o,a,b,pa,pb,now):
    diffs,h=v.compare(a,b,pa,pb)
    v.require(h==PIN,"normalized inventory pin mismatch")
    cp="dist/opencode_g1_staging/wrangler.json"
    cm="wrangler.mcp-staging.jsonc"
    principal=v.parse_json(a[cp]);mcp=v.parse_json(a[cm])
    v.require(principal["name"]==v.WORKERS["principal"] and principal["no_bundle"] is True and principal["main"]=="index.js" and principal["assets"]["directory"]=="../client","unexpected principal deploy config")
    v.require(mcp["name"]==v.WORKERS["mcp"] and mcp["main"]=="src/staging-control-mcp/worker.ts","unexpected MCP config")
    selected={n:x for n,x in a.items() if n.startswith(("dist/opencode_g1_staging/","dist/client/","principal/","mcp/")) or n==cm}
    v.require("principal/index.js" in selected and "mcp/worker.js" in selected and cp in selected and cm in selected,"missing stage input")
    v.require(not any(n.startswith("dist/opencode_harness_example/") for n in selected),"production files selected")
    stage_inventory={n:{"sha256":v.digest(x),"size":len(x)} for n,x in selected.items()}
    stage_digest=v.digest(v.canonical(stage_inventory))
    c=o["candidate"];ci=c["ci"]
    identity=(c["head"]==v.SOURCE and c["branch"]==BASE and c["pr"]==163 and c["draft"] is True and c["merged"] is False and ci["id"]==v.CI and ci["head"]==v.SOURCE and ci["status"]=="completed" and ci["conclusion"]=="success")
    fresh=dt.timedelta(0)<=now-ts(o["observedAt"])<=dt.timedelta(minutes=15)
    worker_rows={w["name"]:w for w in o["workers"]}
    worker_names=set(worker_rows)==set(v.WORKERS.values()) and len(o["workers"])==2
    rollback=worker_names and all(len(w["versions"])==1 and w["versions"][0]["percentage"]==100 and re.fullmatch(UUID,w["deployment"]) and re.fullmatch(UUID,w["versions"][0]["version_id"]) for w in worker_rows.values())
    bindings=worker_names and all(sorted(worker_rows[cfg["name"]]["bindings"])==expected_bindings(cfg) and worker_rows[cfg["name"]]["date"]==cfg["compatibility_date"] and sorted(worker_rows[cfg["name"]]["flags"])==sorted(cfg["compatibility_flags"]) for cfg in (principal,mcp))
    ct=o["container"]
    idle=ct["active"]==0 and ct["starting"]==0 and ct["activeInstancesListed"]==0 and ct["hasNext"] is False
    e=o["billing"]
    base=math.ceil(e["priorCycleDO"])
    total=base+e["sharedLagAllowance"]+e["pilotAllowance"]
    billing=(e["covered"] is True and e["basis"]=="previous-cycle-proxy" and e["currentCycleRecords"]==0 and 0<= (now-ts(e["anchor"])).total_seconds()<=72*3600 and 0<= (now-ts(e["observedThrough"])).total_seconds()<=72*3600 and e["sharedLagAllowance"]>=30000 and e["pilotAllowance"]>=2000 and e["includedDO"]==400000 and 0<=base<=total<e["includedDO"] and e["billedDO"]==0)
    def state(x): return "PASS" if x else "STOP"
    gates={"candidateCI":state(identity),"artifactIntegrity":"PASS","reproducibility":"PASS_METADATA_ONLY","stageOnlySelection":"PASS","freshReadSnapshot":state(fresh),"rollbackReadback":state(rollback and fresh),"bindingMetadataParity":state(bindings and fresh),"containerIdleSnapshot":"PASS_POINT_IN_TIME" if idle and fresh else "STOP","containerImageCompatibility":"STOP_NOT_CERTIFIED","billingScenario":"CONDITIONAL_PROXY_ONLY" if billing else "STOP","currentPricingAndSharedActivity":"STOP_REVALIDATE","pilotBranchAbsent":state(c["pilotBranchHttp"]==404 and fresh),"requestNeverConsumedAndExclusiveLease":"STOP_NOT_CERTIFIED","executorByteHandoff":"STOP_NOT_CERTIFIED","authorizationV2":"STOP_NOT_INSTALLED","liveScope":"STOP_OFFLINE_ONLY"}
    return {"schema":"r4-operational-preflight-v1","source":v.SOURCE,"sourceCI":v.CI,"packageRun":v.PACKAGE_RUN,"observedAt":o["observedAt"],"gates":gates,"stageOnly":{"files":len(selected),"bytes":sum(len(x) for x in selected.values()),"inventorySha256":stage_digest,"excludedProductionFiles":sum(n.startswith("dist/opencode_harness_example/") for n in a),"targets":[{"worker":principal["name"],"config":cp,"main":"principal/index.js","assets":"dist/client"},{"worker":mcp["name"],"config":cm,"main":"mcp/worker.js","assets":None,"note":"config is original source config; using prebuilt MCP requires verified executor/metadata mapping"}]},"billing":{"basis":e["basis"],"proxyTotalGBs":total,"estimatedSlackGBs":e["includedDO"]-total,"currentCycleRecords":e["currentCycleRecords"],"invoiceGuarantee":False},"rollback":{n:w["versions"][0]["version_id"] for n,w in worker_rows.items() if len(w["versions"])==1},"normalizedInventorySha256":h,"differingMetadata":diffs,"deploymentAuthorized":False,"providerDispatchAuthorized":False,"completePass":False,"decision":"STOP"},selected
def main():
    p=argparse.ArgumentParser();p.add_argument("--a",required=True);p.add_argument("--b",required=True);p.add_argument("--sha-a",required=True);p.add_argument("--sha-b",required=True);p.add_argument("--observations",required=True);p.add_argument("--self-test",action="store_true");p.add_argument("--stage-dir")
    x=p.parse_args()
    a,pa,_=v.load(x.a,x.sha_a);b,pb,_=v.load(x.b,x.sha_b);o=v.parse_json(pathlib.Path(x.observations).read_bytes())
    v.require(o["schema"]=="r4-read-observations-v1","observation schema")
    now=dt.datetime.now(dt.timezone.utc)
    r,selected=evaluate(o,a,b,pa,pb,now)
    if x.self_test:
        import copy
        frozen=ts(o["observedAt"])
        expected,_=evaluate(o,a,b,pa,pb,frozen)
        v.require(expected["gates"]["candidateCI"]=="PASS" and expected["gates"]["bindingMetadataParity"]=="PASS" and expected["gates"]["rollbackReadback"]=="PASS","positive snapshot")
        for key,change in [
            ("candidateCI",lambda t:t["candidate"].update(head="0"*40)),
            ("bindingMetadataParity",lambda t:t["workers"][0]["bindings"].pop()),
            ("rollbackReadback",lambda t:t["workers"][0]["versions"][0].update(percentage=50)),
            ("containerIdleSnapshot",lambda t:t["container"].update(active=1)),
            ("billingScenario",lambda t:t["billing"].update(priorCycleDO=400000)),
            ("billingScenario",lambda t:t["billing"].update(currentCycleRecords=1)),
            ("pilotBranchAbsent",lambda t:t["candidate"].update(pilotBranchHttp=200))]:
            t=copy.deepcopy(o);change(t);result,_=evaluate(t,a,b,pa,pb,frozen);v.require(result["gates"][key]=="STOP","negative gate accepted: "+key)
        stale,_=evaluate(o,a,b,pa,pb,frozen+dt.timedelta(hours=73));v.require(stale["gates"]["freshReadSnapshot"]=="STOP" and stale["gates"]["billingScenario"]=="STOP","stale evidence accepted")
        t=copy.deepcopy(o);t.update(liveScopeAuthorized=True,exclusiveLane=True,requestNeverConsumed=True,authorizationV2Installed=True);result,_=evaluate(t,a,b,pa,pb,frozen);v.require(result["decision"]=="STOP" and not result["providerDispatchAuthorized"],"input booleans bypassed scope")
        print("R4_OPERATIONAL_SELFTEST 10 PASS",file=sys.stderr)
    if x.stage_dir:
        root=pathlib.Path(x.stage_dir)
        root.mkdir(parents=True,exist_ok=False)
        for n,data in selected.items():
            v.safe_path(n);out=root/n;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
    print(json.dumps(r,sort_keys=True))
    return 2
if __name__=="__main__":
    try: sys.exit(main())
    except Exception as e:
        print(json.dumps({"decision":"STOP","error":str(e),"deploymentAuthorized":False,"providerDispatchAuthorized":False,"completePass":False}))
        sys.exit(1)

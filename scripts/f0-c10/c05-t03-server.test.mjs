import { readFileSync } from "node:fs";
import { test } from "node:test";
export function runT03Checks(source) {
  const assert = (ok, label) => { if (!ok) throw Error(label); };
  const block = (a,b) => { const i=source.indexOf(a),j=source.indexOf(b,i+1);
    assert(i>=0&&j>i,"missing "+a); return source.slice(i,j); };
  const ordered = (text, ...items) => { let at=-1; for(const item of items){
    const next=text.indexOf(item,at+1); assert(next>at,"order "+item); at=next; } };
  const fn = block("function assertCertifiedReadOnlyImport(", "/** A playable OpenCode");
  const body = fn.slice(fn.indexOf("{")+1, fn.lastIndexOf("}"));
  const verify = new Function("task","receipt",body);
  const task = {mode:"read_only",branch:"",project:"supervised-0000000000000001",repository:"owner/repo",
    baseCommit:"a".repeat(40),sourceCommit:"a".repeat(40),sourceTree:"b".repeat(40)};
  const good = {project:task.project,repository:task.repository,commit:task.baseCommit,tree:task.sourceTree,files:3,sha256:"c".repeat(64)};
  verify(task,good);
  let negatives=0;
  for(const bad of [undefined,{...good,tree:"d".repeat(40)},{...good,commit:"d".repeat(40)},
    {...good,project:"other"},{...good,repository:"other/repo"},{...good,files:0},{...good,sha256:"bad"}]){
    let rejected=false;try{verify(task,bad)}catch(e){rejected=e.message==="SUPERVISOR_READ_ONLY_SOURCE_UNCERTIFIED";}
    assert(rejected,"forged receipt accepted"); negatives++;
  }
  let branchRejected=false;try{verify({...task,branch:"forbidden"},good)}catch(e){branchRejected=true;}
  assert(branchRejected,"branch accepted");negatives++;
  const start=block("async startSupervisedTask(", "private supervisorTaskReceipt");
  ordered(start,"reserveSupervisorAdmission(","this.dispatchSupervisorStart(");
  ordered(start,"if (task.mode !== \"read_only\") return resume()","this.ctx.waitUntil","admissionOnly: true");
  const prep=block("private async prepareSupervisedReadOnlySource(", "private async advanceReadOnlyTask(");
  ordered(prep,"resolveReadOnlySource(","supervisorVerifyReadOnlySource(","supervisorBeginReadOnlyEffect(storage, grant, \"project_reserve\")","reserveIsolatedProject(","supervisorConfirmReadOnlyEffect(","supervisorBeginReadOnlyEffect(storage, grant, \"container_import\")","prepareRepository(","assertCertifiedReadOnlyImport(job, receipt)","supervisorConfirmReadOnlyEffect(","requireReadOnlySourceReceipt(job)");
  assert(!prep.includes("ensureSupervisorBranch"),"read_only branch mutation");
  const advance=block("private async advanceReadOnlyTask(", "private async advanceSupervisedTask(");
  ordered(advance,"prepareSupervisedReadOnlySource(","supervisorBeginReadOnlyEffect(storage, grant, \"session_create\")","harness.create(","supervisorConfirmReadOnlyEffect(","supervisorBeginReadOnlyEffect(storage, grant, \"scope_bind\")","supervisorGrantStillOwned(tx, grant)","bindReadOnlyScope(","supervisorConfirmReadOnlyEffect(","requireReadOnlyTaskScope(job, job.session!)","supervisorBeginReadOnlyEffect(storage, grant, \"configure_agent\")","setAgent(","supervisorModel(","supervisorBeginReadOnlyEffect(storage, grant, \"configure_model\")","setModel(","SUPERVISOR_READ_ONLY_PROVIDER_DISPATCH_NOT_AUTHORIZED");
  assert(!advance.includes(".submit("),"live dispatch reachable");
  assert(!source.includes("readOnlySourceReceiptKey"),"duplicate journal");
  assert(source.includes("reserveSupervisorAdmission(this.ctx.storage, job, undefined, start.mode"),"pins missing");
  assert(source.includes("SUPERVISOR_READ_ONLY_REVIEW_FORBIDDEN"),"review not denied");
  assert(source.includes("SUPERVISOR_READ_ONLY_DELEGATION_UNAVAILABLE"),"delegation not fenced");
  assert(source.includes("deferSupervisorStart(decision, {"),"T08 not wired");
  assert(source.includes("await this.requireReadOnlyTaskScope(job, job.session!)"),"T04 scope not required");
  assert(source.includes("enforceReadOnlyRoute(authority.scope, authority.expected, { kind: \"linux\", project, operation })"),"Linux action not independently guarded");
  assert(source.includes("dev.prepareRepository(project, scope.repository, sourceCommit, sourceTree)"),"unpinned tool import");
  assert(source.includes("status: \"cancel_requested\",\n              cancelAmbiguous: true"),"cancel intent missing");
  return {receiptPositive:1,receiptNegative:negatives,sourceOrderAndGuards:"PASS"};
}

export async function runT03ImportCases(source) {
  const assert=(ok,label)=>{if(!ok)throw Error(label);};
  const between=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)+1));
  const v=between("function assertCertifiedReadOnlyImport(", "/** A playable OpenCode");
  const verify=new Function("task","receipt",v.slice(v.indexOf("{")+1,v.lastIndexOf("}")));
  const m=between("private async prepareSupervisedReadOnlySource(", "private async advanceReadOnlyTask(");
  const body=m.slice(m.indexOf("{")+1,m.lastIndexOf("}"));
  const make=new Function("inspectSupervisorReadOnlyAdmission","supervisorVerifyReadOnlySource","supervisorBeginReadOnlyEffect","supervisorConfirmReadOnlyEffect","projectContainerName","assertCertifiedReadOnlyImport","return async function(job,start,grant){"+body+"}");
  const start={sourceCommit:"a".repeat(40),sourceTree:"b".repeat(40)};
  const original={id:"0000000000000001",fingerprint:"fp",mode:"read_only",branch:"",project:"supervised-0000000000000001",repository:"owner/repo",status:"preparing",...start};
  const good={project:original.project,repository:original.repository,commit:start.sourceCommit,tree:start.sourceTree,files:3,sha256:"c".repeat(64)};
  let passes=0;
  for(const scenario of ["valid","wrong-resolver","wrong-tree","cancel-during-import","generation-during-import","lost-reply","cached","pending","forged-request-pin","wrong-registry"]){
    let job={...original},owned=true,pending;
    const receipts=[],events=[];
    let sourceVerifiedAt;
    if(scenario==="cached"){job.baseCommit=start.sourceCommit;sourceVerifiedAt=1;receipts.push({effect:"project_reserve"},{effect:"container_import",...good});}
    if(scenario==="pending")pending="container_import";
    const inspect=async()=>({pins:{commit:start.sourceCommit,tree:start.sourceTree},fingerprint:"fp",sourceVerifiedAt,pending,receipts:[...receipts]});
    const pin=async(_s,_g,r)=>{assert(r.repo===job.repository&&r.commit===start.sourceCommit&&r.tree===start.sourceTree,"wrong pin");events.push("pin");sourceVerifiedAt=1;return job={...job,baseCommit:r.commit};};
    const begin=async(_s,_g,e)=>{assert(owned&&job.status==="preparing"&&!pending,"fence");events.push("begin:"+e);pending=e;return job;};
    const confirm=async(_s,_g,r)=>{assert(owned&&pending===r.effect&&r.project===job.project&&r.repository===job.repository,"receipt fence");
      if(r.effect==="container_import")verify(job,r);
      events.push("confirm:"+r.effect);receipts.push(r);pending=undefined;return job;};
    const host={ctx:{storage:{}},githubRunner:{resolveReadOnlySource:async()=>{events.push("resolve");return {repo:job.repository,commit:start.sourceCommit,tree:scenario==="wrong-resolver"?"d".repeat(40):start.sourceTree};}},
      requireReadOnlySourceReceipt:async()=>{verify(job,receipts.find(r=>r.effect==="container_import"));},
      env:{DEV:{getByName:n=>n==="personal"?{reserveIsolatedProject:async()=>{events.push("reserve-project");return {project:job.project,repository:scenario==="wrong-registry"?"other/repo":job.repository};}}:{prepareRepository:async()=>{events.push("import");
        if(scenario==="cancel-during-import"){job={...job,status:"cancel_requested"};owned=false;}
        if(scenario==="generation-during-import")owned=false;
        if(scenario==="lost-reply")throw Error("lost");
        return scenario==="wrong-tree"?{...good,tree:"d".repeat(40)}:good;}}}}};
    let failed=false;try{await make(inspect,pin,begin,confirm,x=>x,verify).call(host,job,scenario==="forged-request-pin"?{...start,sourceTree:"d".repeat(40)}:start,{id:job.id});}catch{failed=true;}
    if(scenario==="valid")assert(!failed&&events.join(",")==="resolve,pin,begin:project_reserve,reserve-project,confirm:project_reserve,begin:container_import,import,confirm:container_import","valid order");
    else if(scenario==="cached")assert(!failed&&events.length===0,"cache replay");
    else {assert(failed&&!events.includes("confirm:container_import"),"unexpected import proof "+scenario);
      if(["wrong-tree","cancel-during-import","generation-during-import","lost-reply"].includes(scenario))assert(pending==="container_import","ambiguous effect released");
      if(scenario==="cancel-during-import")assert(job.status==="cancel_requested","cancel overwritten");}
    passes++;
  }
  return {mockedActualImportMethodCases:passes};
}

test("C05 T03 certified receipt and source order (offline)", () => {
  const result=runT03Checks(readFileSync(new URL("../../src/server.ts",import.meta.url),"utf8"));
  console.log(result);
});

test("C05 T03 actual import method with fake RPCs and storage", async () => {
  console.log(await runT03ImportCases(readFileSync(new URL("../../src/server.ts",import.meta.url),"utf8")));
});

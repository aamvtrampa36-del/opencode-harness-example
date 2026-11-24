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
  const prep=block("private async prepareSupervisedReadOnlySource(", "private async advanceSupervisedTask(");
  ordered(prep,"resolveReadOnlySource(","updatePreparingSupervisorTask(","supervisorBeginExternalEffect(","reserveIsolatedProject(","prepareRepository(","assertCertifiedReadOnlyImport(job, receipt)","supervisorGrantStillOwned(tx, grant)","tx.put(readOnlySourceReceiptKey","supervisorConfirmExternalEffect(");
  assert(!prep.includes("ensureSupervisorBranch"),"read_only branch mutation");
  const advance=block("private async advanceSupervisedTask(", "private assertStagingRemote");
  ordered(advance,"if (job.mode === \"read_only\")","prepareSupervisedReadOnlySource(","else if (!job.baseCommit)","ensureSupervisorBranch(","harness.create(","requireReadOnlySourceReceipt(job)","supervisorModel(","handle.setAgent(","handle.setModel(","supervisorBeginExternalEffect(this.ctx.storage, grant, \"submit\")",".submit(");
  assert(advance.split("supervisorGrantStillOwned(tx, grant)").length>=5,"missing fence in status writes");
  assert(source.includes("SUPERVISOR_READ_ONLY_REVIEW_FORBIDDEN"),"review not denied");
  assert(source.includes("SUPERVISOR_READ_ONLY_DELEGATION_UNAVAILABLE"),"delegation not fenced");
  assert(source.includes("dev.prepareRepository(project, scope.repository, sourceCommit, sourceTree)"),"unpinned tool import");
  assert(source.includes("status: \"cancel_requested\",\n              cancelAmbiguous: true"),"cancel intent missing");
  return {receiptPositive:1,receiptNegative:negatives,sourceOrderAndGuards:"PASS"};
}

export async function runT03ImportCases(source) {
  const assert=(ok,label)=>{if(!ok)throw Error(label);};
  const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const between=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)+1));
  const v=between("function assertCertifiedReadOnlyImport(", "/** A playable OpenCode");
  const verify=new Function("task","receipt",v.slice(v.indexOf("{")+1,v.lastIndexOf("}")));
  const m=between("private async prepareSupervisedReadOnlySource(", "private async advanceSupervisedTask(");
  const body=m.slice(m.indexOf("{")+1,m.lastIndexOf("}")).replace(/\.get<(?:ReadOnlySourceReceipt|SupervisorTask)>/g,".get");
  const make=new Function("supervisorBeginExternalEffect","supervisorConfirmExternalEffect","projectContainerName","assertCertifiedReadOnlyImport","readOnlySourceReceiptKey","supervisorTaskKey","supervisorGrantStillOwned","return async function(job,start,grant){"+body+"}");
  const start={sourceCommit:"a".repeat(40),sourceTree:"b".repeat(40)};
  const original={id:"0000000000000001",mode:"read_only",branch:"",project:"supervised-0000000000000001",repository:"owner/repo",status:"preparing",...start};
  const good={project:original.project,repository:original.repository,commit:start.sourceCommit,tree:start.sourceTree,files:3,sha256:"c".repeat(64)};
  const key=id=>"task:"+id, receiptKey=id=>"receipt:"+id;
  let passes=0;
  for(const scenario of ["valid","wrong-resolver","wrong-tree","cancel-during-import","generation-during-import","lost-reply","cached","missing-proof-after-session","forged-request-pin"]){
    let job=clone(original), receipt, owned=true, phase="reserved";
    const events=[];
    if(scenario==="cached"){job.baseCommit=start.sourceCommit;receipt=good;}
    if(scenario==="missing-proof-after-session"){job.baseCommit=start.sourceCommit;job.session="sesX";}
    const storage={get:async k=>clone(k===key(job.id)?job:receipt),put:async(k,v)=>{if(k===key(job.id))job=clone(v);else {events.push("store-proof");receipt=clone(v);}},transaction:async fn=>fn(storage)};
    const begin=async(_s,_g,e)=>{assert(owned&&job.status==="preparing"&&phase==="reserved"&&e==="source_import","bad fence");events.push("begin");phase="effect_unknown";};
    const confirm=async(_s,_g,e,r)=>{assert(owned&&phase==="effect_unknown"&&e==="source_import"&&r.confirmed&&receipt,"confirm before proof");events.push("confirm");phase="reserved";};
    const host={ctx:{storage},updatePreparingSupervisorTask:async(_g,fn)=>{assert(owned&&job.status==="preparing","pin fence");job=fn(clone(job));events.push("pin");return clone(job);},
      githubRunner:{resolveReadOnlySource:async()=>{events.push("resolve");return {repo:job.repository,commit:start.sourceCommit,tree:scenario==="wrong-resolver"?"d".repeat(40):start.sourceTree};}},
      env:{DEV:{getByName:n=>n==="personal"?{reserveIsolatedProject:async()=>{events.push("reserve-project");}}:{prepareRepository:async()=>{events.push("import");
        if(scenario==="cancel-during-import")job.status="cancel_requested";
        if(scenario==="generation-during-import")owned=false;
        if(scenario==="lost-reply")throw Error("lost");
        return scenario==="wrong-tree"?{...good,tree:"d".repeat(40)}:good;}}}}};
    const fn=make(begin,confirm,x=>x,verify,receiptKey,key,async()=>owned);
    let failed=false;try{await fn.call(host,clone(job),scenario==="forged-request-pin"?{...start,sourceTree:"d".repeat(40)}:start,{id:job.id});}catch{failed=true;}
    if(scenario==="valid"){assert(!failed&&events.join(",")==="resolve,pin,begin,reserve-project,import,store-proof,confirm"&&phase==="reserved","valid order");}
    else if(scenario==="cached"){assert(!failed&&events.length===0,"cache replay");}
    else {assert(failed&&!events.includes("confirm")&&!receipt,"negative proof/confirm "+scenario);
      if(["wrong-tree","cancel-during-import","generation-during-import","lost-reply"].includes(scenario))assert(phase==="effect_unknown","ambiguous effect released");
      else assert(!events.includes("begin"),"effect before validation");
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

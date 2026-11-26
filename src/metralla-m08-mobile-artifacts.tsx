import {useState} from "react";
import {artifactClientViews} from "./metralla-m06-artifact-client";
import {VerifiedTaskArtifacts} from "./metralla-m06-artifact-ui";
const mobilePrefix="/api/supervisor/v1/mobile/tasks/";
const taskId=/^[a-f0-9]{16}$/;
const sessionId=/^ses[A-Za-z0-9_]{1,64}$/;
const readHeaders={"X-OpenCode-Artifact-Read":"v1"};
type Loaded={id:string;session:string;content:{type:"text";text:string}[]};
async function boundedManifest(response:Response):Promise<Record<string,unknown>>{
  if(response.status!==200||response.redirected||!response.body)throw Error("No se pudo consultar la tarea.");
  const reader=response.body.getReader(),buffer=new Uint8Array(16000);let used=0;
  try{
    for(;;){const part=await reader.read();if(part.done)break;
      if(part.value.length>buffer.length-used)throw Error("Manifiesto demasiado grande.");
      buffer.set(part.value,used);used+=part.value.length;}
    const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,used)));
    if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Manifiesto inválido.");
    return value;
  }catch(e){void reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
}
/** No artifact from model output can select a different task in this panel. */
export function OwnerTaskArtifacts(){
  const [id,setId]=useState(""),[loaded,setLoaded]=useState<Loaded|null>(null),[status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  async function load(){
    const chosen=id.trim().toLowerCase();
    if(!taskId.test(chosen))return;
    setBusy(true);setLoaded(null);setStatus("");
    try{
      const r=await fetch(mobilePrefix+chosen+"/artifacts",{method:"GET",headers:readHeaders,
        credentials:"same-origin",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000)});
      if(r.status===503)throw Error("El acceso móvil a artefactos aún no está habilitado.");
      if(r.status===401||r.status===403)throw Error("Se requiere la identidad autenticada del propietario.");
      const value=await boundedManifest(r);
      const evidence=value.evidence as {sessionId?:unknown;projectId?:unknown}|undefined;
      const session=evidence?.sessionId;
      if(value.requestId!==chosen||typeof session!=="string"||!sessionId.test(session)||
         evidence?.projectId!=="supervised-"+chosen||value.nextAfter!==null||
         !Array.isArray(value.artifacts)||value.artifacts.length>8||
         !Array.isArray(value.errors)||value.errors.length!==0)throw Error("La identidad del manifiesto no coincide.");
      const content=[{type:"text" as const,text:JSON.stringify(value)}];
      const views=artifactClientViews(content);
      if(views.length!==value.artifacts.length||views.some(v=>v.requestId!==chosen))throw Error("Manifiesto inválido.");
      setLoaded({id:chosen,session,content});setStatus(views.length?"":"No hay archivos vigentes para esta tarea.");
    }catch(e){setStatus(e instanceof Error?e.message:"No se pudo consultar la tarea.");}finally{setBusy(false);}
  }
  return <section className="col-span-full rounded-lg border border-kumo-line p-2 text-xs space-y-2">
    <p className="font-medium">Artefactos de tarea (Staging)</p>
    <label className="block">ID de la tarea
      <input aria-label="ID de tarea supervisada" value={id} disabled={busy} maxLength={16}
        onChange={e=>{setId(e.target.value);setLoaded(null);setStatus("");}}
        className="block w-full rounded border border-kumo-line bg-kumo-base px-2 py-2" />
    </label>
    <button type="button" className="min-h-10 underline disabled:opacity-50" disabled={busy||!taskId.test(id.trim().toLowerCase())}
      onClick={()=>void load()}>{busy?"Consultando…":"Consultar archivos de esta tarea"}</button>
    {status?<p role="status">{status}</p>:null}
    {loaded?<VerifiedTaskArtifacts key={loaded.id+":"+loaded.session} content={loaded.content}
      authorizedFetch={(path,init)=>{
        const match=/^\/api\/supervisor\/v1\/tasks\/([a-f0-9]{16})\/artifacts\/([a-f0-9]{32})\?expires=([1-9][0-9]{0,15})$/.exec(path);
        if(!match||match[1]!==loaded.id)throw Error("ARTIFACT_NOT_FOUND");
        return fetch(mobilePrefix+loaded.id+"/sessions/"+loaded.session+"/artifacts/"+match[2]+"?expires="+match[3],
          {...init,method:"GET",headers:readHeaders,credentials:"same-origin",redirect:"error",cache:"no-store"});
      }}/>:null}
  </section>;
}

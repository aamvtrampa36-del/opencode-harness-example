import type { PilotClaim } from "./pilot-authorization";
import type { SupervisorTask } from "./supervisor-control";
import type { StartGrant } from "./supervisor-admission";

const hex=(x:unknown,n:number)=>typeof x==="string"&&x.length===n&&/^[a-f0-9]+$/.test(x);
const uuid=(x:unknown)=>typeof x==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
export async function pilotDigest(value:unknown):Promise<string>{
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),x=>x.toString(16).padStart(2,"0")).join("");
}
export type PilotPreparationInput={
  requestId:string;project:string;session:string;repository:string;
  releaseSha:string;sourceCommit:string;sourceTree:string;imageDigest:string;
  fingerprint:string;approvalDigest:string;supervisorOwner:string;supervisorObject:string;
  grantDigest:string;generation:number;createdAt:number;workUntil:number;closeUntil:number;
};
export type PilotPreparationReceipt={
  schema:"pilot-preparation-v1";input:PilotPreparationInput;containerObject:string;
  containerOwner:string;bootLabel:string;bootId:string;imageDigest:string;
  nodeVersion:string;os:"debian-trixie";sourceDigest:string;sourceFiles:number;
  preparedAt:number;digest:string;
};
export function pilotImageDigest(image:unknown):string|null{
  if(typeof image!=="string")return null;
  const m=/^(?:[A-Za-z0-9_./:-]+@)?sha256:([a-f0-9]{64})$/.exec(image);
  return m?"sha256:"+m[1]:null;
}
export function pilotRuntimeMatches(info:unknown,bootLabel:string,imageDigest:string):boolean{
  const i=info as {image?:unknown;labels?:Record<string,unknown>}|null;
  return !!i&&uuid(bootLabel)&&pilotImageDigest(i.image)===imageDigest&&i.labels?.pilotboot===bootLabel;
}
export function validPreparationInput(i:PilotPreparationInput):boolean{
  return !!i&&hex(i.requestId,16)&&i.project==="supervised-"+i.requestId&&i.session==="ses_r2_"+i.requestId&&
    i.repository==="aamvtrampa36-del/opencode-harness-example"&&hex(i.releaseSha,40)&&hex(i.sourceCommit,40)&&
    hex(i.sourceTree,40)&&typeof i.imageDigest==="string"&&/^sha256:[a-f0-9]{64}$/.test(i.imageDigest)&&
    hex(i.fingerprint,64)&&hex(i.approvalDigest,64)&&uuid(i.supervisorOwner)&&hex(i.supervisorObject,64)&&
    hex(i.grantDigest,64)&&Number.isSafeInteger(i.generation)&&i.generation>0&&
    Number.isSafeInteger(i.createdAt)&&i.createdAt>=0&&i.workUntil===i.createdAt+900000&&i.closeUntil===i.workUntil+300000;
}
export async function preparationInput(claim:PilotClaim,task:SupervisorTask,grant:StartGrant):Promise<PilotPreparationInput>{
  const a=claim.approval;
  if(claim.startedAt!==task.createdAt||claim.instance!==task.pilotInstance||task.id!==a.requestId||
     task.fingerprint!==a.fingerprint||task.id!==grant.id||task.baseCommit!==a.sourceCommit||
     task.session!=="ses_r2_"+task.id)throw Error("PILOT_PREPARATION_SCOPE");
  const i:PilotPreparationInput={requestId:task.id,project:task.project,session:task.session,repository:task.repository,
    releaseSha:a.releaseSha,sourceCommit:a.sourceCommit,sourceTree:a.sourceTree,imageDigest:a.containerImageDigest,
    fingerprint:task.fingerprint,approvalDigest:await pilotDigest(a),supervisorOwner:claim.instance,
    supervisorObject:claim.objectId,grantDigest:await pilotDigest([grant.id,grant.token,grant.generation]),
    generation:grant.generation,createdAt:task.createdAt,workUntil:task.createdAt+900000,closeUntil:task.createdAt+1200000};
  if(!validPreparationInput(i))throw Error("PILOT_PREPARATION_INPUT_INVALID");
  return i;
}
function receiptBody(r:Omit<PilotPreparationReceipt,"digest">){
  return [r.schema,r.input,r.containerObject,r.containerOwner,r.bootLabel,r.bootId,r.imageDigest,
    r.nodeVersion,r.os,r.sourceDigest,r.sourceFiles,r.preparedAt];
}
export async function makePreparationReceipt(r:Omit<PilotPreparationReceipt,"digest">):Promise<PilotPreparationReceipt>{
  return {...r,digest:await pilotDigest(receiptBody(r))};
}
export async function preparationReceiptValid(r:PilotPreparationReceipt|undefined,i:PilotPreparationInput,now=Date.now()):Promise<boolean>{
  return !!r&&validPreparationInput(i)&&r.schema==="pilot-preparation-v1"&&
    JSON.stringify(r.input)===JSON.stringify(i)&&hex(r.containerObject,64)&&uuid(r.containerOwner)&&uuid(r.bootLabel)&&
    uuid(r.bootId)&&r.imageDigest===i.imageDigest&&/^24\.\d+\.\d+$/.test(r.nodeVersion)&&r.os==="debian-trixie"&&
    hex(r.sourceDigest,64)&&Number.isSafeInteger(r.sourceFiles)&&r.sourceFiles>0&&r.sourceFiles<=15000&&
    Number.isSafeInteger(r.preparedAt)&&r.preparedAt>=i.createdAt&&r.preparedAt<=now&&now<i.workUntil&&
    hex(r.digest,64)&&r.digest===await pilotDigest(receiptBody(r));
}
export async function durablePreparationValid(task:SupervisorTask,claim:PilotClaim|undefined,grant:StartGrant,now=Date.now()):Promise<boolean>{
  if(!claim||!task.pilotPreparation)return false;
  try{return await preparationReceiptValid(task.pilotPreparation,await preparationInput(claim,task,grant),now);}
  catch{return false;}
}

/** Durable start intent is one-use. A lost response or a new DO process is not
 * permission to recreate or recover a certified pilot VM. */
export function pilotBootDisposition(prior:{owner:string;label:string}|undefined,owner:string,running:boolean):
  "new"|"existing"|"stop"{
  if(!prior)return running?"stop":"new";
  return prior.owner===owner&&uuid(prior.label)&&running?"existing":"stop";
}

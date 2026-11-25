import {reconciliationDigest,type ConsumedVerifier} from "./supervisor-reconciliation";
import {physicalCloseVerified,type CloseObservation,type IdleCloseRecord} from "./metralla-m03-close";

type Role="effect"|"closure"|"authorization";
const roles:Role[]=["effect","closure","authorization"];
const hex=(x:unknown,n:number):x is string=>typeof x==="string"&&x.length===n&&/^[a-f0-9]+$/.test(x);
const bytes=(s:string)=>Uint8Array.from(s.match(/../g)!,v=>parseInt(v,16));
export async function evidenceMessage(release:string,role:Role,body:unknown){
  if(!hex(release,40)||!roles.includes(role))throw Error("EVIDENCE_SCOPE_INVALID");
  return new TextEncoder().encode("metralla:m08:v1:"+release+":"+role+":"+await reconciliationDigest(body));
}
/** Only deployment-admin configured, independent public keys are trust roots.
 * This verifier authenticates evidence, not its external collection. */
export async function signedConsumedVerifier(raw:unknown,release:string,signatures:unknown):Promise<ConsumedVerifier>{
  if(typeof raw!=="string"||raw.length>2048||!hex(release,40))throw Error("EVIDENCE_ROOT_UNCONFIGURED");
  const keys=JSON.parse(raw) as Record<Role,string>;
  const sig=signatures as Record<Role,string>;
  if(!keys||!sig||Object.keys(keys).sort().join(",")!=="authorization,closure,effect"||
    Object.keys(sig).sort().join(",")!=="authorization,closure,effect"||
    roles.some(r=>!hex(keys[r],64)||!hex(sig[r],128))||new Set(roles.map(r=>keys[r])).size!==3)
    throw Error("EVIDENCE_ROOT_INVALID");
  const imported=await Promise.all(roles.map(r=>crypto.subtle.importKey("raw",bytes(keys[r]),{name:"Ed25519"},false,["verify"])));
  return async(role,body)=>{try{return await crypto.subtle.verify("Ed25519",imported[roles.indexOf(role)],bytes(sig[role]),await evidenceMessage(release,role,body));}catch{return false;}};
}
export type NormalCloseEvidence={schema:"m08-normal-close-v1";requestId:string;generation:number;taskDigest:string;closeDigest:string;observedAt:number;observation:CloseObservation};
export async function verifyNormalClose(rawKey:unknown,release:string,signature:unknown,e:NormalCloseEvidence,record:IdleCloseRecord,now=Date.now()){
  if(!hex(rawKey,64)||!hex(signature,128)||!e||e.schema!=="m08-normal-close-v1"||!hex(e.requestId,16)||
    !Number.isSafeInteger(e.generation)||e.generation<1||!hex(e.taskDigest,64)||!hex(e.closeDigest,64)||
    !Number.isSafeInteger(e.observedAt)||e.observedAt>now||now-e.observedAt>60000||
    e.closeDigest!==await reconciliationDigest(record)||!physicalCloseVerified(record,e.observation))
    throw Error("NORMAL_CLOSE_EVIDENCE_INVALID");
  const key=await crypto.subtle.importKey("raw",bytes(rawKey),{name:"Ed25519"},false,["verify"]);
  if(!await crypto.subtle.verify("Ed25519",key,bytes(signature),await evidenceMessage(release,"closure",e)))
    throw Error("NORMAL_CLOSE_SIGNATURE_INVALID");
}

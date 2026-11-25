/** M08 owner-only browser artifact bridge. It does NOT replace the supervisor bearer.
 * All trust pins are server configuration, never model/client input. Missing pins deny access. */
import { abortable, pilotFetchNoRedirect, readBoundedJson } from "./pilot-http";
import { parseArtifactQuery } from "./metralla-m06-artifact-http";
import { artifactErrorResponse } from "./task-output-artifacts";

export type MobileOwnerEnv = {
  OPENCODE_MOBILE_ACCESS_ORIGIN?: string;
  OPENCODE_MOBILE_ACCESS_ISSUER?: string;
  OPENCODE_MOBILE_ACCESS_AUDIENCE?: string;
  OPENCODE_MOBILE_OWNER_SUB_SHA256?: string;
};
const prefix="/api/supervisor/v1/mobile/tasks/";
const tokenPart=/^[A-Za-z0-9_-]+$/;
const hex64=/^[a-f0-9]{64}$/;
const enc=new TextEncoder();
function decode(x:string):Uint8Array<ArrayBuffer>{
  if(!tokenPart.test(x)||x.length%4===1)throw Error("MOBILE_TOKEN_FORMAT");
  return Uint8Array.from(atob(x.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(x.length/4)*4,"=")),c=>c.charCodeAt(0));
}
function object(x:unknown):Record<string,unknown>{
  if(!x||typeof x!=="object"||Array.isArray(x))throw Error("MOBILE_TOKEN_FORMAT");
  return x as Record<string,unknown>;
}
function part(x:string){return object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(decode(x))));}
function exactOrigin(x:unknown):x is string {
  if(typeof x!=="string")return false;
  try{const u=new URL(x);return u.protocol==="https:"&&u.origin===x&&!u.username&&!u.password;}catch{return false;}
}
export function mobileOwnerConfigured(env:MobileOwnerEnv):boolean{
  return exactOrigin(env.OPENCODE_MOBILE_ACCESS_ORIGIN)&&
    exactOrigin(env.OPENCODE_MOBILE_ACCESS_ISSUER)&&
    new URL(env.OPENCODE_MOBILE_ACCESS_ISSUER).hostname.endsWith(".cloudflareaccess.com")&&
    typeof env.OPENCODE_MOBILE_ACCESS_AUDIENCE==="string"&&hex64.test(env.OPENCODE_MOBILE_ACCESS_AUDIENCE)&&
    typeof env.OPENCODE_MOBILE_OWNER_SUB_SHA256==="string"&&hex64.test(env.OPENCODE_MOBILE_OWNER_SUB_SHA256);
}
async function pinnedAccessAuthorized(request:Request,env:MobileOwnerEnv,kind:"human"|"service",http:typeof fetch,now:number):Promise<boolean>{
  try {
    if(!mobileOwnerConfigured(env)||new URL(request.url).origin!==env.OPENCODE_MOBILE_ACCESS_ORIGIN)return false;
    // Access injects a signed application token; a spoofed email header, a
    // cookie alone or a service token is insufficient. No bearer in browser.
    const raw=request.headers.get("Cf-Access-Jwt-Assertion");
    if(!raw||raw.length>8192)return false;
    const parts=raw.split(".");if(parts.length!==3)return false;
    const [h,p,s]=parts,header=part(h),claims=part(p);
    if(header.alg!=="RS256"||typeof header.kid!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)||
       header.jku!==undefined||header.x5u!==undefined||
       claims.iss!==env.OPENCODE_MOBILE_ACCESS_ISSUER||claims.type!=="app"||
       !Array.isArray(claims.aud)||claims.aud.length!==1||claims.aud[0]!==env.OPENCODE_MOBILE_ACCESS_AUDIENCE||
       false)return false;
    let subject:string;
    if(kind==="human"){
      if(typeof claims.sub!=="string"||!claims.sub||claims.sub.length>256||
         typeof claims.email!=="string"||!claims.email.includes("@")||claims.email.length>320||
         claims.common_name!==undefined)return false;
      subject=claims.sub;
    }else{
      if(typeof claims.common_name!=="string"||!claims.common_name||claims.common_name.length>256||
         (claims.email!==undefined&&claims.email!=="")||
         (claims.sub!==undefined&&claims.sub!==""))return false;
      subject="service:"+claims.common_name;
    }
    const seconds=Math.floor(now/1000);
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(claims.exp)||Number(claims.exp)<=seconds||
       !Number.isSafeInteger(claims.iat)||Number(claims.iat)>seconds+60||Number(claims.exp)<=Number(claims.iat)||
       (claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||Number(claims.nbf)>seconds)))return false;
    const subjectHash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(subject))),b=>b.toString(16).padStart(2,"0")).join("");
    if(subjectHash!==env.OPENCODE_MOBILE_OWNER_SUB_SHA256)return false;
    // Only the pinned Access issuer is contacted, never JWT-supplied URLs.
    // The browser's cookies, JWT and other credentials are not forwarded.
    const signal=AbortSignal.timeout(5000);
    const response=await abortable(pilotFetchNoRedirect(http,env.OPENCODE_MOBILE_ACCESS_ISSUER+"/cdn-cgi/access/certs",
      {method:"GET",headers:{Accept:"application/json"},signal}),signal);
    if(response.status!==200){void response.body?.cancel().catch(()=>{});return false;}
    const jwks=object(await readBoundedJson(response,65536,signal));
    if(!Array.isArray(jwks.keys)||jwks.keys.length>16)return false;
    const keys=jwks.keys.map(object).filter(k=>k.kid===header.kid);
    if(keys.length!==1)return false;
    const key=keys[0];
    if(key.kty!=="RSA"||(key.alg!==undefined&&key.alg!=="RS256")||
       (key.use!==undefined&&key.use!=="sig")||typeof key.n!=="string"||decode(key.n).length<256||
       typeof key.e!=="string")return false;
    const publicKey=await crypto.subtle.importKey("jwk",key as JsonWebKey,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5",publicKey,decode(s),enc.encode(h+"."+p));
  }catch{return false;}
}
export async function mobileOwnerAuthorized(request:Request,env:MobileOwnerEnv,http:typeof fetch=fetch,now=Date.now()):Promise<boolean>{
  if(request.method!=="GET"||request.headers.get("X-OpenCode-Artifact-Read")!=="v1")return false;
  const origin=request.headers.get("Origin"),site=request.headers.get("Sec-Fetch-Site");
  if((origin&&origin!==env.OPENCODE_MOBILE_ACCESS_ORIGIN)||(site&&site!=="same-origin"))return false;
  return pinnedAccessAuthorized(request,env,"human",http,now);
}
export type RemoteOwnerEnv={
  OPENCODE_REMOTE_ACCESS_ORIGIN?:string;
  OPENCODE_REMOTE_ACCESS_ISSUER?:string;
  OPENCODE_REMOTE_ACCESS_AUDIENCE?:string;
  OPENCODE_REMOTE_OWNER_SHA256?:string;
  OPENCODE_REMOTE_PRINCIPAL_KIND?:string;
};
/** No trust in tool args, forwarded identity headers or unsigned JWT claims. */
export async function remoteOwnerPrincipal(request:Request,env:RemoteOwnerEnv,http:typeof fetch=fetch,now=Date.now()):Promise<string|undefined>{
  const kind=env.OPENCODE_REMOTE_PRINCIPAL_KIND;
  if(kind!=="human"&&kind!=="service")return;
  if(new URL(request.url).pathname!=="/mcp"||!["GET","POST","DELETE"].includes(request.method))return;
  const pins:MobileOwnerEnv={OPENCODE_MOBILE_ACCESS_ORIGIN:env.OPENCODE_REMOTE_ACCESS_ORIGIN,
    OPENCODE_MOBILE_ACCESS_ISSUER:env.OPENCODE_REMOTE_ACCESS_ISSUER,
    OPENCODE_MOBILE_ACCESS_AUDIENCE:env.OPENCODE_REMOTE_ACCESS_AUDIENCE,
    OPENCODE_MOBILE_OWNER_SUB_SHA256:env.OPENCODE_REMOTE_OWNER_SHA256};
  if(await pinnedAccessAuthorized(request,pins,kind,http,now))return env.OPENCODE_REMOTE_OWNER_SHA256;
}
type MobileReads={
  manifest:(id:string)=>Promise<unknown>;
  download:(id:string,session:string,artifactId:string,expiresAt:number,range:string|null)=>Promise<Response>;
};
/** Explicit owner selection; only read-only DO methods, never a generic proxy. */
export async function handleMobileArtifactRead(request:Request,env:MobileOwnerEnv,reads:MobileReads,
  authorize:(r:Request,e:MobileOwnerEnv)=>Promise<boolean>=mobileOwnerAuthorized):Promise<Response>{
  if(!mobileOwnerConfigured(env))return artifactErrorResponse("MOBILE_ARTIFACTS_NOT_CONFIGURED",503);
  if(request.method!=="GET")return artifactErrorResponse("METHOD_NOT_ALLOWED",405);
  if(!await authorize(request,env))return artifactErrorResponse("MOBILE_ARTIFACT_AUTH_REQUIRED",401);
  const url=new URL(request.url);
  const suffix=url.pathname.startsWith(prefix)?url.pathname.slice(prefix.length):"";
  const manifest=/^([a-f0-9]{16})\/artifacts$/.exec(suffix);
  const download=/^([a-f0-9]{16})\/sessions\/(ses[A-Za-z0-9_]{1,64})\/artifacts\/([a-f0-9]{32})$/.exec(suffix);
  try{
    if(manifest&&!url.search){
      return Response.json(await reads.manifest(manifest[1]),{headers:{"Cache-Control":"no-store, private",
        "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Cross-Origin-Resource-Policy":"same-origin"}});
    }
    if(download){
      const q=parseArtifactQuery(url.search,true);
      return await reads.download(download[1],download[2],download[3],q.expiresAt!,request.headers.get("Range"));
    }
  }catch{return artifactErrorResponse("ARTIFACT_UNAVAILABLE",404);}
  return artifactErrorResponse("ARTIFACT_UNAVAILABLE",404);
}

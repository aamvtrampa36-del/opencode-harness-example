import {test,expect} from "bun:test";
import {mobileOwnerAuthorized,handleMobileArtifactRead,type MobileOwnerEnv} from "./metralla-m08-mobile-auth";
const now=1700000000000,subject="fixture-owner-sub",origin="https://fixture.invalid",issuer="https://fixture.cloudflareaccess.com";
const b64=(x:Uint8Array)=>Buffer.from(x).toString("base64url");
const json=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString("base64url");
const enc=new TextEncoder();
async function setup(){
 const pair=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
 const jwk={...await crypto.subtle.exportKey("jwk",pair.publicKey),kid:"fixture",alg:"RS256",use:"sig"};
 const hash=Buffer.from(await crypto.subtle.digest("SHA-256",enc.encode(subject))).toString("hex");
 const env:MobileOwnerEnv={OPENCODE_MOBILE_ACCESS_ORIGIN:origin,OPENCODE_MOBILE_ACCESS_ISSUER:issuer,
   OPENCODE_MOBILE_ACCESS_AUDIENCE:"a".repeat(64),OPENCODE_MOBILE_OWNER_SUB_SHA256:hash};
 const claims={iss:issuer,aud:["a".repeat(64)],type:"app",sub:subject,email:"owner@example.invalid",iat:now/1000-1,exp:now/1000+60};
 async function token(patch:Record<string,unknown>={}){
  const h=json({alg:"RS256",kid:"fixture"}),p=json({...claims,...patch});
  return h+"."+p+"."+b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",pair.privateKey,enc.encode(h+"."+p))));
 }
 let calls=0;
 const http=(async(input:unknown,init?:RequestInit)=>{
  calls++;expect(String(input)).toBe(issuer+"/cdn-cgi/access/certs");expect(init?.redirect).toBe("manual");
  expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  expect(new Headers(init?.headers).has("Cf-Access-Jwt-Assertion")).toBe(false);
  return Response.json({keys:[jwk]});
 }) as typeof fetch;
 return {env,token,http,get calls(){return calls;}};
}
const id="0000000000000001",sid="sesFixture",artifact="a".repeat(32),base=origin+"/api/supervisor/v1/mobile/tasks/"+id;
const req=(token:string,path=base+"/artifacts",headers:Record<string,string>={})=>new Request(path,{headers:{"Cf-Access-Jwt-Assertion":token,"X-OpenCode-Artifact-Read":"v1","Sec-Fetch-Site":"same-origin",...headers}});
test("signed human Access identity, exact owner pin and issuer-only key retrieval",async()=>{
 const f=await setup(),token=await f.token();
 expect(await mobileOwnerAuthorized(req(token),f.env,f.http,now)).toBe(true);
 expect(f.calls).toBe(1);
 expect(await mobileOwnerAuthorized(req(token),{},f.http,now)).toBe(false);
 expect(await mobileOwnerAuthorized(req(token,base+"/artifacts",{"Sec-Fetch-Site":"cross-site"}),f.env,f.http,now)).toBe(false);
 expect(await mobileOwnerAuthorized(req(token,base+"/artifacts",{"X-OpenCode-Artifact-Read":""}),f.env,f.http,now)).toBe(false);
 expect(await mobileOwnerAuthorized(req(token,base.replace(origin,"https://else.invalid")+"/artifacts"),f.env,f.http,now)).toBe(false);
 expect(await mobileOwnerAuthorized(req(token),{...f.env,OPENCODE_MOBILE_OWNER_SUB_SHA256:"b".repeat(64)},f.http,now)).toBe(false);
 expect(f.calls).toBe(1);
 for(const patch of [{aud:["b".repeat(64)]},{sub:"other"},{email:undefined},{common_name:"service"},{exp:now/1000},{iss:"https://other.cloudflareaccess.com"}]){
  expect(await mobileOwnerAuthorized(req(await f.token(patch)),f.env,f.http,now)).toBe(false);
 }
 expect(f.calls).toBe(1);
 const parts=token.split(".");parts[2]="A"+parts[2].slice(1);
 if(parts.join(".")===token)parts[2]="B"+parts[2].slice(1);
 expect(await mobileOwnerAuthorized(req(parts.join(".")),f.env,f.http,now)).toBe(false);
});
test("route never reaches storage without owner auth; no writes, query tokens or generic proxy",async()=>{
 const f=await setup();let calls=0;
 const reads={manifest:async (got:string)=>{calls++;expect(got).toBe(id);return {requestId:id};},
 download:async(got:string,session:string,file:string,expires:number,range:string|null)=>{
  calls++;expect(got).toBe(id);expect(file).toBe(artifact);expect(expires).toBe(1000);expect(range).toBeNull();
  return session===sid?new Response("ok"):new Response(null,{status:404});
 }};
 const token=await f.token(),authorize=(r:Request,e:MobileOwnerEnv)=>mobileOwnerAuthorized(r,e,f.http,now);
 expect((await handleMobileArtifactRead(req("bad"),f.env,reads,authorize)).status).toBe(401);
 expect((await handleMobileArtifactRead(req(token),{},reads,authorize)).status).toBe(503);
 expect((await handleMobileArtifactRead(new Request(base+"/artifacts",{method:"POST"}),f.env,reads,authorize)).status).toBe(405);
 expect((await handleMobileArtifactRead(req(token,base+"/artifacts?token=bad"),f.env,reads,authorize)).status).toBe(404);
 expect((await handleMobileArtifactRead(req(token,origin+"/bundle/file"),f.env,reads,authorize)).status).toBe(404);
 expect(calls).toBe(0);
 expect((await handleMobileArtifactRead(req(token),f.env,reads,authorize)).status).toBe(200);
 const download=base+"/sessions/"+sid+"/artifacts/"+artifact+"?expires=1000";
 expect((await handleMobileArtifactRead(req(token,download),f.env,reads,authorize)).status).toBe(200);
 expect((await handleMobileArtifactRead(req(token,download.replace(sid,"sesOther")),f.env,reads,authorize)).status).toBe(404);
 expect(calls).toBe(3);
});

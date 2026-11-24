import {test,expect} from "bun:test";
import {makePreparationReceipt,preparationReceiptValid,pilotImageDigest,pilotRuntimeMatches,pilotBootDisposition,type PilotPreparationInput} from "./pilot-preparation";
const label="12345678-1234-1234-1234-123456789abc",id="0123456789abcdef",now=1000;
const input:PilotPreparationInput={requestId:id,project:"supervised-"+id,session:"ses_r2_"+id,
 repository:"aamvtrampa36-del/opencode-harness-example",releaseSha:"a".repeat(40),sourceCommit:"b".repeat(40),
 sourceTree:"c".repeat(40),imageDigest:"sha256:"+"d".repeat(64),fingerprint:"e".repeat(64),
 approvalDigest:"f".repeat(64),supervisorOwner:label,supervisorObject:"a".repeat(64),grantDigest:"b".repeat(64),
 generation:1,createdAt:now,workUntil:now+900000,closeUntil:now+1200000};
const fixture=()=>makePreparationReceipt({schema:"pilot-preparation-v1",input,containerObject:"c".repeat(64),containerOwner:label,
 bootLabel:label,bootId:label,imageDigest:input.imageDigest,nodeVersion:"24.20.0",os:"debian-trixie",
 sourceDigest:"e".repeat(64),sourceFiles:123,preparedAt:now+10});
test("exact receipt and independent identity",async()=>{const r=await fixture();expect(await preparationReceiptValid(r,input,now+20)).toBe(true);
 expect(pilotRuntimeMatches({image:"registry/image@"+input.imageDigest,labels:{pilotboot:label}},label,input.imageDigest)).toBe(true)});
test("mutable image tag and missing/wrong instance label fail",()=>{
 expect(pilotImageDigest("cloudflare/debian-trixie")).toBeNull();
 for(const info of [null,{image:input.imageDigest},{image:input.imageDigest,labels:{pilotboot:crypto.randomUUID()}},
 {image:"sha256:"+"0".repeat(64),labels:{pilotboot:label}}])expect(pilotRuntimeMatches(info,label,input.imageDigest)).toBe(false);
});
test("receipt rejects expiry, tamper, wrong owner, wrong source or generation",async()=>{
 const r=await fixture();expect(await preparationReceiptValid(r,input,input.workUntil)).toBe(false);
 expect(await preparationReceiptValid({...r,bootId:crypto.randomUUID()},input,now+20)).toBe(false);
 for(const patch of [{supervisorOwner:crypto.randomUUID()},{sourceCommit:"0".repeat(40)},{sourceTree:"0".repeat(40)},
 {generation:2},{approvalDigest:"0".repeat(64)},{imageDigest:"sha256:"+"0".repeat(64)}])
   expect(await preparationReceiptValid(r,{...input,...patch},now+20)).toBe(false);
});

test("durable boot intent forbids replacement after lost start, lost VM or DO reset",()=>{
 const prior={owner:label,label};
 expect(pilotBootDisposition(undefined,label,false)).toBe("new");
 expect(pilotBootDisposition(undefined,label,true)).toBe("stop");
 expect(pilotBootDisposition(prior,label,true)).toBe("existing");
 expect(pilotBootDisposition(prior,label,false)).toBe("stop");
 expect(pilotBootDisposition(prior,crypto.randomUUID(),true)).toBe("stop");
});

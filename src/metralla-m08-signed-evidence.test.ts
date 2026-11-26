import {test,expect} from "bun:test";
import {evidenceMessage,signedConsumedVerifier} from "./metralla-m08-signed-evidence";
const hex=(x:ArrayBuffer)=>Array.from(new Uint8Array(x),b=>b.toString(16).padStart(2,"0")).join("");
test("M08 independent signed roots bind role, release and exact body",async()=>{
 const release="a".repeat(40),body={receipt:"fixture",at:1},roots:Record<string,string>={},signatures:Record<string,string>={};
 for(const role of ["effect","closure","authorization"] as const){
  const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
  roots[role]=hex(await crypto.subtle.exportKey("raw",pair.publicKey));
  signatures[role]=hex(await crypto.subtle.sign("Ed25519",pair.privateKey,await evidenceMessage(release,role,body)));
 }
 const verify=await signedConsumedVerifier(JSON.stringify(roots),release,signatures);
 expect(await verify("effect",body as any)).toBe(true);
 expect(await verify("effect",{...body,at:2} as any)).toBe(false);
 const wrong=await signedConsumedVerifier(JSON.stringify(roots),"b".repeat(40),signatures);
 expect(await wrong("effect",body as any)).toBe(false);
 await expect(signedConsumedVerifier(JSON.stringify({...roots,closure:roots.effect}),release,signatures)).rejects.toThrow();
 await expect(signedConsumedVerifier(undefined,release,signatures)).rejects.toThrow();
});

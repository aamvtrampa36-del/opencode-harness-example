import {test,expect} from "bun:test";
import {pilotFetchNoRedirect} from "./pilot-http";
test("workerd-compatible no-redirect fetch preserves request options",async()=>{
  const signal=new AbortController().signal;let calls=0;
  const http=(async(input:any,init:any)=>{calls++;expect(input).toBe("https://example.invalid");
    if(init.redirect==="error")throw Error("workerd rejects redirect error");
    expect(init.redirect).toBe("manual");expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer offline-dummy");expect(init.signal).toBe(signal);
    return Response.json({ok:true});}) as typeof fetch;
  const r=await pilotFetchNoRedirect(http,"https://example.invalid",{method:"POST",redirect:"follow",headers:{Authorization:"Bearer offline-dummy"},signal});
  expect(await r.json()).toEqual({ok:true});expect(calls).toBe(1);
});
for(const status of [301,302,303,304,307,308])test("reject redirect without follow or retry "+status,async()=>{
  let calls=0;const http=(async(_url:any,init:any)=>{calls++;expect(init.redirect).toBe("manual");
    return new Response(null,{status,headers:{Location:"https://other.invalid"}});}) as typeof fetch;
  await expect(pilotFetchNoRedirect(http,"https://example.invalid")).rejects.toThrow("PILOT_HTTP_REDIRECT_REFUSED");
  expect(calls).toBe(1);
});

/** Workerd only supports follow/manual. A manual request never forwards a
 * bearer credential or a POST to an unexpected Location. Reject every
 * redirect before parsing a receipt, with no implicit replay or fallback. */
export async function pilotFetchNoRedirect(http:typeof fetch,input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1]):Promise<Response>{
  const response=await http(input,{...init,redirect:"manual"});
  if(response.redirected||response.type==="opaqueredirect"||response.status===0||
     (response.status>=300&&response.status<400)){
    // Do not await arbitrary redirect body data or disclose Location.
    void response.body?.cancel().catch(()=>{});
    throw Error("PILOT_HTTP_REDIRECT_REFUSED");
  }
  return response;
}

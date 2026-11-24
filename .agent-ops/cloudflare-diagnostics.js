// Cloudflare MCP execute input template. Replace only literal input values.
// Requires an already authorized Cloudflare MCP session. No credentials are read or returned.
async () => {
  const input = {
    worker: "opencode-g1-staging",
    from: "2026-11-24T15:40:00Z",
    to: "2026-11-24T15:50:00Z",
    category: "memory",
    request_id: null
  };
  const allowed = ["opencode-g1-staging","opencode-harness-example","cdf-cloud-engine","cdf-cloud-engine-gateway","cdf-cloud-checkpoint-verifier","cdf-workbench-mirror"];
  const categories = ["memory","error","exception","timeout","D1","SQL","RPC"];
  const from = Date.parse(input.from), to = Date.parse(input.to);
  if (!allowed.includes(input.worker) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to-from>3600000 || !categories.includes(input.category) || (input.request_id!==null && !/^[A-Za-z0-9_-]{1,128}$/.test(input.request_id))) throw Error("Invalid diagnostic scope");
  const worker=input.worker;
  const filters=[{key:"$metadata.service",operation:"eq",type:"string",value:worker},{key:"$metadata.message",operation:"includes",type:"string",value:input.category}];
  if(input.request_id!==null) filters.push({key:"$workers.requestId",operation:"eq",type:"string",value:input.request_id});
  const a=await Promise.allSettled([
    cloudflare.request({method:"GET",path:"/accounts/"+accountId+"/workers/scripts/"+worker+"/deployments",query:{per_page:3}}),
    cloudflare.request({method:"POST",path:"/accounts/"+accountId+"/workers/observability/telemetry/query",body:{queryId:"agent-ops-bounded-diagnostics",dry:true,view:"events",limit:10,timeframe:{from,to},parameters:{filters}}})
  ]);
  const d=a[0].status==="fulfilled"?a[0].value.result?.deployments:null;
  const e=a[1].status==="fulfilled"?a[1].value.result?.events:null;
  const list=Array.isArray(e)?e:Array.isArray(e?.events)?e.events:Array.isArray(e?.data)?e.data:null;
  const safe=x=>typeof x==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)?x:null;
  return {schema:"agent-diagnostics/v1",worker,from,to,category:input.category,coverage:Array.isArray(d)&&Array.isArray(list)?"BOUNDED_SAMPLE":"PARTIAL",deployments:Array.isArray(d)?d.slice(0,3).map(x=>({id:safe(x.id),created_on:safe(x.created_on),versions:x.versions?.slice(0,5).map(v=>({id:safe(v.version_id),percentage:v.percentage}))})):null,telemetry:{status:a[1].status,sample_count:list?.length??null,events:list?.slice(0,10).map(x=>({id:safe(x.$metadata?.id),timestamp:typeof x.timestamp==="number"?x.timestamp:safe(x.timestamp),service:safe(x.$metadata?.service),request_id:safe(x.$workers?.requestId)}))??[]},scope:"Deployment list and filtered event sample; no full history, no raw messages, no causation or absence-of-error proof"};
}

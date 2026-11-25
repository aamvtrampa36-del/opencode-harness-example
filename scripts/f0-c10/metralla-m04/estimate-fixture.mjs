import {METERS} from './estimate.mjs';
export function estimateFixture(now=Date.now()){
  const quantities=Object.fromEntries(Object.keys(METERS).map(k=>[k,0]));
  const perTask={...quantities,inputTokens:2000,outputTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,
    providerCalls:2,inferenceMilliseconds:2000,containerVcpuMilliseconds:3000,containerMemoryMiBMilliseconds:512000,
    containerDiskMiBMilliseconds:1024000,workerRequests:10,workerCpuMilliseconds:100,doRequests:20,
    doMemoryMiBMilliseconds:128000,doReadRows:30,doWrittenRows:20,doStorageByteMilliseconds:1000000,
    ciSeconds:10,egressBytes:1000,logBytes:500};
  const shared={...quantities,ciSeconds:60,workerRequests:2,logBytes:100};
  const events=q=>Object.fromEntries(Object.entries(q).map(([k,v])=>[k,v===0?0:(k.endsWith('Tokens')?2:1)]));
  return {schema:'metralla-m04-estimate-v1',pricingRevision:'synthetic-only',totalCapMicroUsd:500000,residualMicroUsd:1000,
    tariffs:Object.fromEntries(Object.entries(METERS).map(([k,unit])=>[k,{unit,microUsd:1,unitsPerCharge:1000,
      rounding:'proportional',revision:'synthetic-only',evidenceId:'a'.repeat(64),measuredAt:now-100,validUntil:now+60000}])),
    rounds:[1,2,4,10].map(n=>({id:'r'+n,tasks:n,maxConcurrent:n,maxDurationMs:1000,maxCallsPerTask:2,
      maxInputTokens:1000,maxOutputTokens:500,maxWireBytes:2000,maxResponseBytes:3000,requestsPerMinute:20,
      taskCapMicroUsd:10000,roundCapMicroUsd:100000,residualMicroUsd:1000,perTask:{...perTask},shared:{...shared},
      perTaskRoundingEvents:events(perTask),sharedRoundingEvents:events(shared)}))};
}

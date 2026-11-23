/**
 * Bounded projection for Remote/MCP progress. Never materializes history().
 * SDK log() still allocates any single event; that upstream limit is separate.
 */
export type ProgressEvent = {seq:number;type:string};
export type ProgressPage = {
  events:ProgressEvent[];nextAfter:number;truncated:boolean;scanned:number;
  skipped:number;duplicates:number;projectedBytes:number;gapDetected:boolean;
  scanBudget:number;projectedEventBudget:number;byteBudget:number;processingBudgetMs:number;
};
export type ProgressLimits={maxScanned?:number;maxEvents?:number;maxBytes?:number;maxMs?:number};
const DEFAULTS={maxScanned:128,maxEvents:64,maxBytes:8192,maxMs:50} as const;

export async function projectSupervisorProgress(
  stream:AsyncIterable<unknown>,after=0,limits:ProgressLimits={}
):Promise<ProgressPage>{
  if(!Number.isSafeInteger(after)||after<0)throw new Error("SUPERVISOR_PROGRESS_CURSOR_INVALID");
  const {maxScanned,maxEvents,maxBytes,maxMs}={...DEFAULTS,...limits};
  if(![maxScanned,maxEvents,maxBytes,maxMs].every(Number.isSafeInteger)||
     maxScanned<1||maxScanned>128||maxEvents<1||maxEvents>64||
     maxBytes<256||maxBytes>8192||maxMs<1||maxMs>50)
    throw new Error("SUPERVISOR_PROGRESS_BUDGET_INVALID");
  const events:ProgressEvent[]=[];
  let nextAfter=after,scanned=0,skipped=0,duplicates=0;
  let projectedBytes=2,gapDetected=false,truncated=false;
  const deadline=Date.now()+maxMs;
  // A limit-edge page may conservatively report truncated even at end-of-stream.
  for await(const raw of stream){
    scanned++;
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new Error("SUPERVISOR_EVENT_SEQUENCE_INVALID");
    const event=raw as Record<string,unknown>;
    const durable=event.durable&&typeof event.durable==="object"
      ?event.durable as Record<string,unknown>:{};
    const seq=durable.seq??event.seq;
    if(typeof seq!=="number"||!Number.isSafeInteger(seq)||seq<1)
      throw new Error("SUPERVISOR_EVENT_SEQUENCE_INVALID");
    if(seq<=nextAfter)duplicates++;
    else{
      // A missing durable sequence may indicate a pruned log, lost event, or
      // wrong task cursor. Never acknowledge unseen records with nextAfter.
      // The caller must reconcile/reset explicitly; don't silently skip.
      if(seq!==nextAfter+1){gapDetected=true;truncated=true;break;}
      const data=event.data&&typeof event.data==="object"
        ?event.data as Record<string,unknown>:{};
      const eventType=(typeof event.type==="string"?event.type:
        typeof data.type==="string"?data.type:"event").slice(0,100);
      if(/reasoning/i.test(eventType)){
        nextAfter=seq;skipped++;
      }else{
        const projected={seq,type:eventType};
        const bytes=new TextEncoder().encode(JSON.stringify(projected)).byteLength+1;
        // A page that did not include an event must not advance beyond it.
        if(projectedBytes+bytes>maxBytes){truncated=true;break;}
        projectedBytes+=bytes;events.push(projected);nextAfter=seq;
      }
    }
    if(scanned>=maxScanned||events.length>=maxEvents||
       projectedBytes>=maxBytes||Date.now()>=deadline){truncated=true;break;}
  }
  return {events,nextAfter,truncated,scanned,skipped,duplicates,projectedBytes,gapDetected,
    scanBudget:maxScanned,projectedEventBudget:maxEvents,byteBudget:maxBytes,processingBudgetMs:maxMs};
}

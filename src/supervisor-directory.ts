/**
 * Bounded, storage-backed supervisor task directory.
 *
 * The supervisor owns task/session mappings in its Durable Object storage.
 * Enumerating them avoids OpenCodeHarness.sessions.list(), which may allocate
 * complete SDK session state before callers truncate the returned array.
 *
 * This is deliberately not a general-purpose OpenCode chat directory:
 * unsupervised chat sessions are excluded, and that scope is disclosed.
 */
type TaskRow = {
  id: string;
  session: string;
  createdAt: number;
  updatedAt?: number;
  status: string;
  model?: string;
};
type Entry = {
  session: string;
  taskId: string;
  status: string;
  model?: string;
  busy: boolean;
  busyVerified: boolean;
};

const TASK_ID=/^[a-f0-9]{16}$/;
const SESSION_ID=/^ses[A-Za-z0-9_]{1,64}$/;
const TASK_PREFIX="supervisor:task:";
const ACTIVE = new Set(["preparing","running","cancel_requested","unknown"]);
const FINISHED = new Set(["finished","cancelled","failed","unanswered"]);

function decodeTask(key: string, raw: unknown): TaskRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("SUPERVISOR_DIRECTORY_INVALID");
  const row=raw as Record<string,unknown>;
  if (typeof row.id !== "string" || !TASK_ID.test(row.id) ||
      key !== TASK_PREFIX + row.id ||
      !Number.isSafeInteger(row.createdAt) || (row.createdAt as number) < 0 ||
      typeof row.status !== "string" ||
      !ACTIVE.has(row.status) && !FINISHED.has(row.status)) {
    throw new Error("SUPERVISOR_DIRECTORY_INVALID");
  }
  if (row.session === undefined || row.session === null) return null; // reservation without a session
  if (typeof row.session !== "string" || !SESSION_ID.test(row.session)) throw new Error("SUPERVISOR_DIRECTORY_INVALID");
  return {
    id:row.id,session:row.session,createdAt:row.createdAt as number,
    ...(Number.isSafeInteger(row.updatedAt) ? {updatedAt:row.updatedAt as number}:{ }),
    status:row.status,
    ...(typeof row.model === "string" ? {model:row.model}:{})
  };
}

function boundedRows(values: ReadonlyMap<string,unknown>,max: number) {
  if (!Number.isSafeInteger(max)||max<1||max>200) throw new Error("SUPERVISOR_DIRECTORY_LIMIT_INVALID");
  if (values.size>max+1) throw new Error("SUPERVISOR_DIRECTORY_UNBOUNDED");
  const rows=[...values.entries()];
  const limited=rows.length>max;
  return {selected:rows.slice(0,max),limited};
}

export function supervisorTaskCount(values: ReadonlyMap<string,unknown>,max=100) {
  const {selected,limited}=boundedRows(values,max);
  const total=selected.reduce((n,[key,raw])=>n+(decodeTask(key,raw)?1:0),0);
  return {supervisedSessions:total,countComplete:!limited,limited};
}

export async function collectSupervisorDirectory(
  values: ReadonlyMap<string,unknown>,
  isBusy: (session: string)=>Promise<boolean>,
  max=100,
  concurrency=4
): Promise<{sessions:Entry[];limited:boolean;countComplete:boolean;scope:"SUPERVISED_INDEX_ONLY"}> {
  if (!Number.isSafeInteger(concurrency) || concurrency<1 || concurrency>8)
    throw new Error("SUPERVISOR_DIRECTORY_CONCURRENCY_INVALID");
  const {selected,limited}=boundedRows(values,max);
  const tasks=selected.map(([key,value])=>decodeTask(key,value)).filter((t):t is TaskRow=>t!==null)
    .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
  const result:Entry[]=[];
  for(let i=0;i<tasks.length;i+=concurrency){
    const chunk=tasks.slice(i,i+concurrency);
    const probes=await Promise.all(chunk.map(async t=>{
      try {
        const busy=await isBusy(t.session);
        if (typeof busy!=="boolean") throw new Error("BAD_BUSY_RETURN");
        const status=busy ? "running" : FINISHED.has(t.status) ? t.status : "unknown";
        return {session:t.session,taskId:t.id,status,
          ...(t.model?{model:t.model}:{ }),busy,busyVerified:true};
      } catch {
        // An unverified busy state is always conservative for safety checks.
        // Client must not interpret a failed probe as confirmation of idle.
        return {session:t.session,taskId:t.id,status:"unknown",...(t.model?{model:t.model}:{ }),
          busy:true,busyVerified:false};
      }
    }));
    result.push(...probes);
  }
  return {sessions:result,limited,countComplete:!limited,scope:"SUPERVISED_INDEX_ONLY"};
}

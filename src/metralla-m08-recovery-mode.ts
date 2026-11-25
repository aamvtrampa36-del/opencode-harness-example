/** Same-source recovery release: no new work, no new durable schema.
 * Unknown configuration fails closed. Existing authoritative observations and
 * signed reconciliation retain their original guards. Never infer a drain. */
export function recoveryMode(env:unknown):boolean {
  const flag=(env as {OPENCODE_M08_RECOVERY_MODE?:unknown}|null)?.OPENCODE_M08_RECOVERY_MODE;
  return flag!==undefined&&flag!=="false";
}
export function assertRecoveryWorkAllowed(env:unknown):void {
  if(recoveryMode(env))throw Error("M08_RECOVERY_NEW_EFFECT_FORBIDDEN");
}
const tasks=/^\/api\/supervisor\/v1\/tasks\/[a-f0-9]{16}$/;
export function recoveryHttpAllowed(method:string,path:string):boolean {
  return method==="GET"&&(path==="/api/health"||path==="/api/supervisor/v1/status"||tasks.test(path))||
    method==="POST"&&path.endsWith("/cancel")&&tasks.test(path.slice(0,-7));
}
const actions=new Set(["status","cancel","r4_reconcile","metralla_inspect_consumed","metralla_archive_consumed","metralla_inspect_budget","metralla_transition_budget","metralla_native_evidence","metralla_request_close","metralla_normal_close"]);
export function assertRecoveryWorkflowAllowed(env:unknown,action:unknown):void {
  if(recoveryMode(env)&&(typeof action!=="string"||!actions.has(action)))throw Error("M08_RECOVERY_WORKFLOW_FORBIDDEN");
}
/** In recovery, never let a timer or an open/unknown Linux receipt cause
 * a snapshot/destroy. A private, positively fenced normal close request is
 * the only new physical operation permitted; caller still checks every
 * existing identity, deadline, accounting and close guard. */
export function recoveryCloseAllowed(env:unknown,explicit:boolean,openReceipt:boolean):boolean {
  return !recoveryMode(env)||explicit&&!openReceipt;
}

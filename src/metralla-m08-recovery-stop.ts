/** Staging-only emergency freeze. Exports the same durable class names and
 * never reads, initializes, migrates or deletes application data.
 * Only after independently verified drain; not a way to stop in-flight work.
 * Resume requires the certified same-schema active release, not an old Worker.
 */
import {DurableObject,WorkflowEntrypoint} from "cloudflare:workers";
export function recoveryResponse(){return Response.json({code:"M08_RECOVERY_FROZEN",admission:false,restored:false},{status:503,headers:{"Cache-Control":"no-store"}});}
export class OpenCodeAgent extends DurableObject<Env>{fetch(){return recoveryResponse();}async alarm(){throw Error("M08_RECOVERY_FROZEN");}}
export class DevContainer extends DurableObject<Env>{fetch(){return recoveryResponse();}async alarm(){throw Error("M08_RECOVERY_FROZEN");}}
export class PersonalSettings extends DurableObject<Env>{fetch(){return recoveryResponse();}async alarm(){throw Error("M08_RECOVERY_FROZEN");}}
export class SessionBackupDrillAgent extends DurableObject<Env>{fetch(){return recoveryResponse();}async alarm(){throw Error("M08_RECOVERY_FROZEN");}}
export class OpenCodeSupervisorWorkflow extends WorkflowEntrypoint<Env,unknown>{async run(){throw Error("M08_RECOVERY_FROZEN");}}
export default {fetch(){return recoveryResponse();}};

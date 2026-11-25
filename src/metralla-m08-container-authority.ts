import {assertSourceScope,type SourceScope,type Lease} from "./metralla-m03-execution-identity";
export type NormalContainerAuthority={source:SourceScope;requestId:string;generation:number;token:string;releaseSha:string;imageDigest:string;workUntil:number;closeUntil:number};
export function assertContainerAuthority(a:NormalContainerAuthority,objectName:string|undefined,release:string,now:number){
 if(!a||!a.source||!/^[a-f0-9]{16}$/.test(a.requestId)||a.source.project!=="supervised-"+a.requestId||objectName!=="project-v1:"+a.source.project||
 !Number.isSafeInteger(a.generation)||a.generation<1||typeof a.token!=="string"||!a.token||a.releaseSha!==release||!/^[a-f0-9]{40}$/.test(release)||
 !/^sha256:[a-f0-9]{64}$/.test(a.imageDigest)||!Number.isSafeInteger(a.workUntil)||a.workUntil<=now||!Number.isSafeInteger(a.closeUntil)||a.closeUntil<=a.workUntil||a.closeUntil-a.workUntil>300000)throw Error("NORMAL_CONTAINER_AUTHORITY_INVALID");
 assertSourceScope(a.source,a.source);
}
export function assertContainerLease(a:NormalContainerAuthority,lease:Lease,source:SourceScope,release:string|undefined,now:number){
 assertContainerAuthority(a,"project-v1:"+source.project,release??"",now);
 assertSourceScope(a.source,source);
 if(lease.requestId!==a.requestId||lease.project!==source.project||lease.generation!==a.generation||lease.token!==a.token||lease.expiresAt>a.workUntil||lease.expiresAt<=now)throw Error("NORMAL_CONTAINER_LEASE_FENCED");
}

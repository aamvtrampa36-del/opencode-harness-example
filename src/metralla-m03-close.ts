import { assertSnapshotMetadata, type SnapshotMetadata } from "./snapshot-policy";
/** Per-project DO journal. A destroy acknowledgement is NOT native closure proof. */
export const CLOSE_KEY="m03-idle-close-v1";
export type IdleCloseRecord={operation:string;objectId:string;identity:string;activity:number;snapshot:SnapshotMetadata;phase:"destroy_requested"|"destroy_acknowledged"};
export type CloseObservation={operation:string;objectId:string;identity:string;source:"independent-native";vmTerminated:boolean;descendants:number;nativeOperations:number;proof:string};
export function assertCloseRecord(r:IdleCloseRecord,objectId:string):void{
 if(!r||r.objectId!==objectId||typeof r.operation!=="string"||!r.operation||typeof r.identity!=="string"||!r.identity||
 !Number.isSafeInteger(r.activity)||r.activity<0||!["destroy_requested","destroy_acknowledged"].includes(r.phase)||!r.snapshot)
 throw Error("M03_CLOSE_RECORD_INVALID");
 assertSnapshotMetadata(r.snapshot.snapshotId,r.snapshot.savedAt,r.snapshot.savedAt);
}
export function physicalCloseVerified(r:IdleCloseRecord,o:CloseObservation|null):boolean{
 assertCloseRecord(r,r.objectId);
 return !!o&&o.source==="independent-native"&&o.operation===r.operation&&o.objectId===r.objectId&&o.identity===r.identity&&
 o.vmTerminated===true&&o.descendants===0&&o.nativeOperations===0&&typeof o.proof==="string"&&/^[A-Za-z0-9._:-]{1,256}$/.test(o.proof);
}
export function assertRecoveryCheckpoint(r:IdleCloseRecord,objectId:string,id:unknown,savedAt:unknown,now:number):void{
 assertCloseRecord(r,objectId);
 const s=assertSnapshotMetadata(id,savedAt,now);
 if(r.phase!=="destroy_acknowledged"||s.snapshotId!==r.snapshot.snapshotId||s.savedAt!==r.snapshot.savedAt)
 throw Error("M03_CLOSE_EFFECT_UNKNOWN");
}

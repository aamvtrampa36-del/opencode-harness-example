import {test,expect} from "bun:test";
import {beginLinuxReceipt,advanceLinuxReceipt,linuxReceiptPage} from "./metralla-m08-native-receipts";
import type {ExecutionScope} from "./metralla-m03-execution-identity";
const id="0123456789abcdef",project="supervised-"+id,release="a".repeat(40),call="11111111-1111-4111-8111-111111111111";
const scope:ExecutionScope={source:{project,repository:"fixture/repo",commit:release,tree:release},boot:{project,objectId:"b".repeat(64),bootId:call,bootLabel:call,image:{kind:"reference",reference:"fixture"}},lease:{requestId:id,project,generation:1,token:"never-export",expiresAt:100}};
function fixture(){const rows=new Map<string,unknown>();return {rows,tx:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}} as unknown as DurableObjectStorage};}
test("real native callback receipt edges preserve exact identity and exit without claiming physical closure",async()=>{
 const {tx}=fixture(),seq=await beginLinuxReceipt(tx,scope,call,release,"c".repeat(64),1);
 await advanceLinuxReceipt(tx,seq,call,{kind:"accepted"},2);
 await advanceLinuxReceipt(tx,seq,call,{kind:"exited",exitCode:7,truncated:true},5);
 const p=await linuxReceiptPage(tx,project,release,null);
 expect(p.rows[0]).toMatchObject({callId:call,acceptedAt:2,exitAt:5,exitCode:7,state:"exited",truncated:true});expect(p.physicalClosureVerified).toBe(false);
 expect(JSON.stringify(p)).not.toContain("never-export");
 await expect(beginLinuxReceipt(tx,scope,call,release,"c".repeat(64),6)).rejects.toThrow("LINUX_RECEIPT_REPLAY");
 await expect(linuxReceiptPage(tx,project,"d".repeat(40),null)).rejects.toThrow();
});
test("lost native response stays open, cannot be converted into exit or new dispatch",async()=>{
 const {tx}=fixture(),seq=await beginLinuxReceipt(tx,scope,call,release,"c".repeat(64),1);
 await advanceLinuxReceipt(tx,seq,call,{kind:"unknown"},2);
 await expect(advanceLinuxReceipt(tx,seq,call,{kind:"exited",exitCode:0,truncated:false},3)).rejects.toThrow();
 await expect(beginLinuxReceipt(tx,scope,crypto.randomUUID(),release,"c".repeat(64),4)).rejects.toThrow();
 expect((await linuxReceiptPage(tx,project,release,null)).openReceipt).toBe(seq);
});

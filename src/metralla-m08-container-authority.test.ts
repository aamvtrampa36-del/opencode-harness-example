import {test,expect} from "bun:test";
import {assertContainerAuthority,assertContainerLease} from "./metralla-m08-container-authority";
test("normal container authority cannot extend generation, source, release or work window",()=>{
 const id="a".repeat(16),project="supervised-"+id,source={project,repository:"owner/repo",commit:"b".repeat(40),tree:"c".repeat(40)},release="d".repeat(40);
 const a={source,requestId:id,generation:2,token:"fixture",releaseSha:release,imageDigest:"sha256:"+"e".repeat(64),workUntil:1000,closeUntil:2000};
 const l={requestId:id,project,generation:2,token:"fixture",expiresAt:900};
 expect(()=>assertContainerAuthority(a,"project-v1:"+project,release,100)).not.toThrow();
 expect(()=>assertContainerLease(a,l,source,release,100)).not.toThrow();
 for(const bad of [{...l,generation:3},{...l,token:"foreign"},{...l,expiresAt:1001}])expect(()=>assertContainerLease(a,bad,source,release,100)).toThrow();
 expect(()=>assertContainerLease(a,l,{...source,tree:"f".repeat(40)},release,100)).toThrow();
 expect(()=>assertContainerLease(a,l,source,release,1000)).toThrow();
 expect(()=>assertContainerAuthority(a,"project-v1:foreign",release,100)).toThrow();
});

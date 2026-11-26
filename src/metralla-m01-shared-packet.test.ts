import {test,expect} from "bun:test";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
test("M01 shared packet applies to exact B0 files without modifying them",()=>{
 const root=fileURLToPath(new URL("../",import.meta.url));
 const blob=(p:string)=>{const b=readFileSync(new URL(p,import.meta.url));return createHash("sha1").update("blob "+b.length+"\0").update(b).digest("hex");};
 // M08 owns subsequent shared edits; its own integration gate must test merged sources.
 if(blob("./server.ts")!=="1930a35b4f248f224bcdfdc5d9d5703ba0338ee4"||blob("./supervisor-control.ts")!=="4589fc979a0bea131356c1f87ff90ae368182754"){
   expect(process.env.GITHUB_REF_NAME).not.toBe("metralla/m01");return;
 }
 const result=spawnSync("git",["apply","--check","docs/metralla/packets/M01/P05_SHARED.patch"],{cwd:root,encoding:"utf8"});
 expect(result.stderr).toBe("");expect(result.status).toBe(0);
});

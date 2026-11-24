import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyNoBundle,verifyCertificate} from "./staging-release-guard.mjs";
function scratch(fn){const d=mkdtempSync(join(tmpdir(),"oc-handoff-"));try{const a=join(d,"a"),b=join(d,"b");mkdirSync(a);mkdirSync(b);writeFileSync(join(a,"index.js"),"export default {}");writeFileSync(join(b,"index.js"),"export default {}");return fn(a,b);}finally{rmSync(d,{recursive:true,force:true});}}
test("no-bundle dry-run matches exact module set and bytes, not its incidental README",()=>scratch((a,b)=>{writeFileSync(join(a,"README.md"),"fixed");writeFileSync(join(b,"README.md"),"tool diagnostic");assert.equal(verifyNoBundle(a,b,"principal").files,1);}));
test("missing or extra module fails handoff",()=>scratch((a,b)=>{writeFileSync(join(b,"extra.js"),"x");assert.throws(()=>verifyNoBundle(a,b,"principal"),/changed/);rmSync(join(b,"extra.js"));rmSync(join(b,"index.js"));writeFileSync(join(b,"other.js"),"x");assert.throws(()=>verifyNoBundle(a,b,"principal"),/changed/);}));
test("changed executable bytes fail handoff",()=>scratch((a,b)=>{writeFileSync(join(b,"index.js"),"export default 1");assert.throws(()=>verifyNoBundle(a,b,"principal"),/changed/);}));
test("unexpected nonmodule cannot be omitted from handoff",()=>scratch((a,b)=>{writeFileSync(join(a,"payload.bin"),"x");assert.throws(()=>verifyNoBundle(a,b,"principal"),/Unexpected/);}));
const expected={commit:"a".repeat(40),tree:"b".repeat(40),archive:"c".repeat(64),certificate:"d".repeat(64)};
function fixtures(){const actual=Object.fromEntries(["principal","mcp","assets","configuration"].map(k=>[k,{files:1,sha256:"e".repeat(64),manifest:[["x","f".repeat(64)]]}]));const c={schema:"opencode-repro-comparison/v1",commit:expected.commit,tree:expected.tree,runId:"123",passed:true,archiveEqual:true,differenceCount:0,replicas:["a","b"],archiveSha256:[expected.archive,expected.archive],groups:Object.fromEntries(Object.keys(actual).map(k=>[k,{a:actual[k].sha256,b:actual[k].sha256,files:1}]))};const r={inputs:{commit:expected.commit,tree:expected.tree},runId:c.runId,archiveSha256:expected.archive,groups:structuredClone(actual)};return {c,r,actual};}
test("external approved certificate verifies exact source, archive and all four groups",()=>{const {c,r,actual}=fixtures();assert.equal(verifyCertificate(c,r,actual,expected),true);});
test("certificate without byte equality is refused",()=>{const {c,r,actual}=fixtures();c.archiveEqual=false;assert.throws(()=>verifyCertificate(c,r,actual,expected),/PASS/);});
test("different release source, CI or group contents are rejected",()=>{const {c,r,actual}=fixtures();r.runId="456";assert.throws(()=>verifyCertificate(c,r,actual,expected),/source or CI/);r.runId=c.runId;actual.mcp.sha256="1".repeat(64);assert.throws(()=>verifyCertificate(c,r,actual,expected),/mismatch/);});
test("wrong or unapproved archive fails",()=>{const {c,r,actual}=fixtures();assert.throws(()=>verifyCertificate(c,r,actual,{...expected,archive:"0".repeat(64)}),/PASS/);assert.throws(()=>verifyCertificate(c,r,actual,{...expected,certificate:""}),/approved/);});

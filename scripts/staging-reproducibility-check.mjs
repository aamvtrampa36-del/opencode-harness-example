import {test} from "node:test";
import assert from "node:assert/strict";
import {diffManifests,compareInputs} from "./staging-reproducibility.mjs";
const groups=()=>Object.fromEntries(["principal","mcp","assets","configuration"].map(k=>[k,{manifest:[["a.js","hash"]]}]));
test("matching manifests contain no difference",()=>assert.deepEqual(diffManifests(groups(),groups()),[]));
test("missing and extra path are distinct",()=>{const a=groups(),b=groups();b.mcp.manifest=[["b.js","hash"]];assert.deepEqual(diffManifests(a,b).map(x=>x.kind),["missing","added"]);});
test("changed byte digest is detected",()=>{const a=groups(),b=groups();b.assets.manifest[0][1]="different";assert.equal(diffManifests(a,b)[0].kind,"bytes");});
test("missing group fails closed",()=>{const a=groups(),b=groups();delete b.mcp;assert.throws(()=>diffManifests(a,b),/Incomplete/);});
const r=(replica)=>({schema:"opencode-repro-build/v1",replica,runId:"123",inputs:{commit:"a".repeat(40),tree:"b".repeat(40),node:"v22"}});
test("distinct replicas with equal inputs pass",()=>assert.equal(compareInputs(r("a"),r("b")),true));
test("same replica cannot certify itself",()=>assert.throws(()=>compareInputs(r("a"),r("a")),/Independent/));
test("different commit and tools fail",()=>{const a=r("a"),b=r("b");b.inputs.node="v24";assert.throws(()=>compareInputs(a,b),/inputs/);b.inputs.node="v22";b.inputs.commit="c".repeat(40);assert.throws(()=>compareInputs(a,b),/inputs/);});

test("different CI runs cannot be mixed",()=>{const a=r("a"),b=r("b");b.runId="456";assert.throws(()=>compareInputs(a,b),/CI run/);});

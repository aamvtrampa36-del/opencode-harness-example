/** Validate independent exact-HEAD receipts. Emits an offline result, NEVER a grant. */
import {readFileSync} from "node:fs";
import assert from "node:assert/strict";
const [source,a,b]=process.argv.slice(2);
assert(/^[a-f0-9]{40}$/.test(source));
const load=p=>{
 const rows=JSON.parse(readFileSync(p,"utf8"));assert.equal(rows.length,2);
 assert.deepEqual(rows.map(r=>r.role).sort(),["mcp","principal"]);
 for(const r of rows){assert.equal(r.source,source);assert.equal(r.schema,"r4-release-inventory-v2");}
 return rows.sort((a,b)=>a.role.localeCompare(b.role));
};
const x=load(a),y=load(b);assert.deepEqual(x,y);
console.log(JSON.stringify({schema:"r4-promotion-preflight-v2",source,independentReplicas:2,inventory:x,
 decision:"STOP",deploymentAuthorized:false,providerDispatchAuthorized:false,completePass:false,
 pending:["pre-freeze-observation-and-budget","freeze-only-upload-and-promotion","post-freeze-drain-and-account-workflow","native-historical-quarantine-certificate","fresh-server-capacity-readback","explicit-pilot-grant-and-principal-promotion","actual-container-preparation"]}));

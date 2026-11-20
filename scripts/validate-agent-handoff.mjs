#!/usr/bin/env node
// Structural handoff validation only. It does NOT verify remote evidence or permissions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, posix } from "node:path";
import { pathToFileURL } from "node:url";

const STATUSES = new Set(["ACTIVE", "BLOCKED", "READY_FOR_REVIEW", "COMPLETE_VERIFIED"]);
const CHECKS = new Set(["pass", "fail", "not_run", "unknown"]);
const SHA = /^[a-f0-9]{40}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const isText = (x) => typeof x === "string" && x.trim().length > 0;
const isPath = (x) => isText(x) && !x.includes("\\") && !x.startsWith("/") &&
  !x.split("/").includes("..") && posix.normalize(x) === x && x !== ".";

export function validateHandoff(h) {
  const errors = [];
  const need = (condition, message) => { if (!condition) errors.push(message); };
  need(h !== null && typeof h === "object" && !Array.isArray(h), "root must be object");
  if (errors.length) return errors;

  need(h.schema === "agent.handoff.v1", "schema must be agent.handoff.v1");
  need(isText(h.task_id) && h.task_id.length <= 120, "task_id required (<=120 chars)");
  need(REPO.test(h.repository ?? ""), "repository must be owner/name");
  need(isText(h.branch) && /^[A-Za-z0-9._/-]+$/.test(h.branch) &&
    !h.branch.includes("..") && !h.branch.startsWith("refs/") &&
    !h.branch.startsWith("/") && !h.branch.endsWith("/"), "branch must be a valid scoped ref name");
  need(SHA.test(h.head_sha ?? ""), "head_sha must be exact 40-hex commit SHA");
  need(isText(h.owner), "owner required");
  need(isText(h.objective) && h.objective.length >= 12, "objective must describe the task");
  need(STATUSES.has(h.status), "status invalid");
  need(Array.isArray(h.write_scope) && h.write_scope.every(isPath), "write_scope must be relative paths");
  need(Array.isArray(h.depends_on) && h.depends_on.every(isText), "depends_on must be an array of refs");
  need(Array.isArray(h.evidence), "evidence must be an array");
  if (Array.isArray(h.evidence)) {
    need(h.evidence.every((v) => v && typeof v === "object" &&
      ["pr","commit","ci","log","readback","tool","manual"].includes(v.kind) &&
      isText(v.url) && /^https:\/\//.test(v.url)), "evidence items require kind and HTTPS url");
  }
  need(Array.isArray(h.checks), "checks must be an array");
  if (Array.isArray(h.checks)) {
    need(h.checks.every((v) => v && isText(v.name) && CHECKS.has(v.status)), "invalid check item");
  }
  need(Number.isFinite(Date.parse(h.updated_at ?? "")) &&
    /^\d{4}-\d{2}-\d{2}T/.test(h.updated_at ?? ""), "updated_at must be ISO date-time");
  if (h.status !== "COMPLETE_VERIFIED") {
    need(isText(h.next_action), "next_action required until verified complete");
  }
  if (h.status === "READY_FOR_REVIEW" || h.status === "COMPLETE_VERIFIED") {
    need(Array.isArray(h.evidence) && h.evidence.length > 0, "review/complete require evidence");
  }
  if (h.status === "COMPLETE_VERIFIED") {
    need(Array.isArray(h.checks) && h.checks.some((v) => v.status === "pass"), "complete requires a passed check");
    need(Array.isArray(h.checks) && h.checks.every((v) => v.status === "pass"), "complete must have no unchecked or failed checks");
  }
  return errors;
}

function selftest() {
  const sample = {
    schema:"agent.handoff.v1", task_id:"synthetic-read-only", repository:"owner/repo",
    branch:"test/synthetic", head_sha:"0".repeat(40), owner:"agent-test",
    objective:"Synthetic bounded read-only verification", status:"BLOCKED",
    write_scope:["docs/example.md"], depends_on:[], evidence:[],
    checks:[{name:"live",status:"not_run"}],
    next_action:"Run real evidence capture", updated_at:"2026-11-20T00:00:00Z"
  };
  assert.deepEqual(validateHandoff(sample), []);
  assert.ok(validateHandoff({...sample,status:"COMPLETE_VERIFIED"}).length > 0);
  assert.ok(validateHandoff({...sample,write_scope:["../secret"]}).length > 0);
  assert.ok(validateHandoff({...sample,branch:"refs/heads/main"}).length > 0);
  assert.ok(validateHandoff({...sample,head_sha:"deadbeef"}).length > 0);
  assert.ok(validateHandoff({...sample,status:"READY_FOR_REVIEW",evidence:[]}).length > 0);
  assert.ok(validateHandoff({...sample,evidence:[{kind:"ci",url:"http://not-secure"}]}).length > 0);
  assert.deepEqual(validateHandoff({...sample,status:"COMPLETE_VERIFIED",
    evidence:[{kind:"ci",url:"https://github.com/owner/repo/actions/runs/1"}],
    checks:[{name:"synthetic",status:"pass"}],next_action:""}), []);
  console.log("8/8 synthetic handoff structural cases passed; no remote validation performed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--selftest") {
    selftest();
  } else if (process.argv.length !== 3) {
    console.error("Usage: node scripts/validate-agent-handoff.mjs --selftest | handoff.json");
    process.exitCode = 2;
  } else {
    try {
      const document = JSON.parse(readFileSync(process.argv[2], "utf8"));
      const errors = validateHandoff(document);
      if (errors.length) {
        console.error(JSON.stringify({status:"BLOCKED",errors},null,2));
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify({status:"STRUCTURE_VALID",remote_evidence_verified:false}));
      }
    } catch (error) {
      console.error("Invalid handoff input:",error.message);
      process.exitCode = 1;
    }
  }
}

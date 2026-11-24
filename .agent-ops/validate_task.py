#!/usr/bin/env python3
"""Agent validation v1: read-only static validation and conservative CI plan.
Run from an isolated checkout using this trusted script from the ops branch.
No deployment, no model calls, no execution of candidate code.
"""
import argparse
import ast
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time

PROJECTS = {
    "cdf-cloud-engine": {
        "workflow": "CDF Cloudflare checks",
        "jobs": ["test-and-package"],
        "local": ["bash tools/run-codex-cloud-tests.sh"],
    },
    "CDF-WorkBench-": {
        "workflow": "Validate and package CDF Workbench",
        "jobs": ["validate", "official-workbench-mcp"],
        "local": ["python scripts/check_release_policy.py", "python scripts/verify_package.py", "npm ci --prefix cloudflare/cdf-workbench-mcp", "npm test --prefix cloudflare/cdf-workbench-mcp"],
    },
    "opencode-harness-example": {
        "workflow": "OpenCode validation",
        "jobs": ["validate"],
        "local": ["bun install --frozen-lockfile", "bun test", "bun scripts/test-preview.mjs", "bun run typecheck", "bun run build", "bun scripts/check-invariants.mjs"],
    },
}

def run(args, cwd, data=None, timeout=20):
    return subprocess.run(args, cwd=cwd, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, check=False)

def git(cwd, *args):
    p = run(["git", *args], cwd)
    if p.returncode:
        raise RuntimeError("git " + args[0] + " failed")
    return p.stdout

def profile(paths):
    if not paths:
        return "no-change"
    if all(p.lower().endswith((".md", ".rst", ".txt")) and not p.startswith(".github/") for p in paths):
        return "documentation"
    if any(re.search(r"(^|/)(oauth|auth|acl|security|wrangler|package|bun.lock|requirements|pyproject|dockerfile|migrations|schema|\.github|mcp)", p, re.I) for p in paths):
        return "security-contract-config"
    return "code-or-unknown"

def sha(data):
    return hashlib.sha256(data).hexdigest()

def node_version(cwd):
    if not shutil.which("node"):
        return None
    p = run(["node", "--version"], cwd)
    return p.stdout.decode().strip() if p.returncode == 0 else None

def static(cwd, project, base, head, cache=None):
    start = time.monotonic()
    b = git(cwd, "rev-parse", "--verify", base + "^{commit}").decode().strip()
    h = git(cwd, "rev-parse", "--verify", head + "^{commit}").decode().strip()
    dirty = bool(git(cwd, "status", "--porcelain", "--untracked-files=normal"))
    raw = git(cwd, "diff", "--name-only", "--no-renames", "-z", b, h, "--")
    paths = [os.fsdecode(x) for x in raw.split(b"\0") if x]
    kind = profile(paths)
    versions = {"python": sys.version, "node": node_version(cwd), "platform": platform.platform(), "git": git(cwd, "--version").decode().strip()}
    ident = {"project": project, "base": b, "head": h, "tools": versions, "validator": sha(pathlib.Path(__file__).read_bytes())}
    key = sha(json.dumps(ident, sort_keys=True).encode())
    destination = pathlib.Path(cache) / (key + ".json") if cache else None
    if destination and destination.is_file():
        try:
            old = json.loads(destination.read_text())
            if old["identity"] == ident and old["static_status"] == "PASS":
                old["static_status"] = "CACHED"
                old["duration_ms"] = round((time.monotonic()-start)*1000)
                old["dirty_worktree"] = dirty
                return old
        except (OSError, ValueError, KeyError, TypeError):
            pass
    results = []
    p = run(["git", "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab", "diff", "--check", b, h, "--"], cwd)
    # Do not leak source lines or credentials in the compact result.
    results.append({"check": "git-diff-check", "status": "PASS" if not p.returncode else "FAIL", "action": None if not p.returncode else "Run git diff --check for exact locations"})
    for name in paths:
        ext = pathlib.PurePosixPath(name).suffix.lower()
        if ext not in (".py", ".mjs", ".cjs", ".json"):
            continue
        entry = git(cwd, "ls-tree", "-z", h, "--", name)
        if not entry:
            continue  # deletion; full CI still required
        if not entry.startswith((b"100644 blob ", b"100755 blob ")):
            results.append({"check": "syntax", "path": name, "status": "BLOCKED", "action": "Non-regular blob; inspect safely"})
            continue
        obj = entry.split(b"\t", 1)[0].split()[-1].decode()
        size = int(git(cwd, "cat-file", "-s", obj))
        if size > 2_000_000:
            results.append({"check": "syntax", "path": name, "status": "SKIPPED", "action": "Large blob; use project CI"})
            continue
        data = git(cwd, "cat-file", "blob", obj)
        check = {"check": "syntax", "path": name, "status": "PASS"}
        try:
            if ext == ".py":
                ast.parse(data, filename=name)
            elif ext == ".json":
                json.loads(data)
            elif versions["node"]:
                with tempfile.TemporaryDirectory() as tmp:
                    f = pathlib.Path(tmp) / ("input" + ext)
                    f.write_bytes(data)
                    proc = run(["node", "--check", str(f)], cwd)
                    if proc.returncode:
                        check.update(status="FAIL", action="Run node --check on the indicated blob")
            else:
                check.update(status="BLOCKED", action="Node unavailable; use project CI")
        except (SyntaxError, ValueError, UnicodeError) as e:
            check.update(status="FAIL", line=getattr(e, "lineno", None), action="Correct invalid syntax/JSON")
        except subprocess.TimeoutExpired:
            check.update(status="BLOCKED", action="Syntax check timed out")
        results.append(check)
    statuses = {x["status"] for x in results}
    stat = "FAIL" if "FAIL" in statuses else "BLOCKED" if "BLOCKED" in statuses else "PARTIAL" if "SKIPPED" in statuses else "PASS"
    result = {"schema":"agent-validation/v1", "identity":ident, "validation_id":key,
              "profile":kind, "file_count":len(paths), "files":paths[:80],
              "dirty_worktree":dirty, "static_status":stat,
              "checks":results, "ci_required":PROJECTS[project],
              "acceptance_status":"FAIL" if stat=="FAIL" else "BLOCKED" if stat=="BLOCKED" else "PARTIAL",
              "pending":["Exact candidate CI jobs, integration and runtime evidence as applicable. Static PASS never closes a task."],
              "duration_ms":round((time.monotonic()-start)*1000)}
    if destination and stat == "PASS":
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(mode="w", dir=destination.parent, delete=False) as tmp:
            json.dump(result,tmp)
            tempname=tmp.name
        os.replace(tempname,destination)
    return result

def selftest():
    with tempfile.TemporaryDirectory() as td:
        root = pathlib.Path(td)
        def g(*args):
            return git(root,*args).decode().strip()
        g("init", "-q")
        g("config","user.email","validation@example.invalid")
        g("config","user.name","Validation")
        def commit(name,content):
            (root/name).write_text(content)
            g("add",name)
            g("commit","-qm",name)
            return g("rev-parse","HEAD")
        base=commit("README.md","base\n")
        bad=commit("test.py","def broken(:\n")
        cache=root.parent / (root.name+"-cache")
        try:
            a=static(root,"cdf-cloud-engine",base,bad,cache)
            assert a["static_status"]=="FAIL" and a["profile"]=="code-or-unknown"
            good=commit("test.py","def fixed():\n    return True\n")
            b=static(root,"cdf-cloud-engine",base,good,cache)
            c=static(root,"cdf-cloud-engine",base,good,cache)
            assert b["static_status"]=="PASS" and c["static_status"]=="CACHED"
            assert b["acceptance_status"]==c["acceptance_status"]=="PARTIAL"
            changed=commit("test.py","def fixed():\n    return False\n")
            d=static(root,"cdf-cloud-engine",base,changed,cache)
            assert d["static_status"]=="PASS" and d["validation_id"]!=b["validation_id"]
            assert profile(["docs/guide.md"])=="documentation"
            assert profile(["cloudflare/oauth-handler.mjs"])=="security-contract-config"
            assert profile(["src/foo.ts"])=="code-or-unknown"
            assert profile([])=="no-change"
            print(json.dumps({"selftest":"PASS","red":a["static_status"],"green":b["static_status"],"reuse":c["static_status"],"changed":d["static_status"],"cache_invalidated":True,"static_not_acceptance":True,"profiles":4,"first_ms":b["duration_ms"],"cached_ms":c["duration_ms"]}))
        finally:
            shutil.rmtree(cache,ignore_errors=True)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--project",choices=PROJECTS)
    parser.add_argument("--base")
    parser.add_argument("--head",default="HEAD")
    parser.add_argument("--cache-dir",help="Trusted private local directory only; never from candidate branch")
    parser.add_argument("--selftest",action="store_true")
    args=parser.parse_args()
    if args.selftest:
        selftest()
        return 0
    if not args.project or not args.base:
        parser.error("--project and --base are required")
    try:
        # Reject option injection and ambiguous arbitrary revision expressions.
        if any(not re.fullmatch(r"[A-Fa-f0-9]{40}|HEAD", x) for x in (args.base,args.head)):
            raise ValueError("Use exact 40-character commit SHA or HEAD")
        output=static(pathlib.Path.cwd(),args.project,args.base,args.head,args.cache_dir)
    except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as e:
        print(json.dumps({"schema":"agent-validation/v1","static_status":"BLOCKED","acceptance_status":"BLOCKED","action":str(e)[:180]}))
        return 2
    print(json.dumps(output,ensure_ascii=True))
    return 1 if output["static_status"]=="FAIL" else 2 if output["static_status"]=="BLOCKED" else 0

if __name__=="__main__":
    sys.exit(main())

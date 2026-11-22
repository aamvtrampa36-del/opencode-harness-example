import { describe, expect, test } from "bun:test";
import { GitHubBridge } from "./github";
import { githubSourceArchive, sourceReceiptMatches } from "./github-import";
import {
  assertSupervisorBoundGitHubOperation, deferSupervisorStart, preflightReadOnlySource,
  supervisorBranch, supervisorFingerprint, supervisorPrompt,
  validateSupervisorStart
} from "./supervisor-control";

const repo = "aamvtrampa36-del/opencode-harness-example";
const other = "aamvtrampa36-del/not-approved";
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const base = {
  requestId: "c1234567890abcde", repository: repo,
  prompt: "Analiza el código sin escribir ni abrir una PR"
};
const readOnly = { ...base, mode: "read_only", sourceCommit: commit, sourceTree: tree };

describe("supervised read_only contract", () => {
  test("accepts an exact lowercase commit and tree pair for the owner repository", () => {
    expect(validateSupervisorStart(readOnly, [repo])).toMatchObject(readOnly);
    expect(validateSupervisorStart(base, [repo])).toEqual(base);
  });

  test("rejects malformed, incomplete, unpaired or non read_only source pins before inference", () => {
    for (const sourceCommit of [commit.toUpperCase(), commit.slice(1), "g".repeat(40), "main"]) {
      expect(() => validateSupervisorStart({ ...readOnly, sourceCommit }, [repo])).toThrow();
    }
    for (const sourceTree of [tree.toUpperCase(), tree.slice(1), "z".repeat(40)]) {
      expect(() => validateSupervisorStart({ ...readOnly, sourceTree }, [repo])).toThrow();
    }
    expect(() => validateSupervisorStart({ ...readOnly, sourceTree: undefined }, [repo])).toThrow("sourceTree");
    expect(() => validateSupervisorStart({ ...readOnly, sourceCommit: undefined }, [repo])).toThrow("sourceCommit");
    expect(() => validateSupervisorStart({ ...base, mode: "read_only" }, [repo]))
      .toThrow("read_only requiere sourceCommit y sourceTree");
    expect(() => validateSupervisorStart({ ...base, sourceCommit: commit, sourceTree: tree }, [repo]))
      .toThrow("read_only");
    expect(() => validateSupervisorStart({ ...readOnly, mode: "develop" }, [repo])).toThrow();
    expect(() => validateSupervisorStart({ ...readOnly, repository: other }, [repo])).toThrow("no autorizado");
    expect(() => validateSupervisorStart(readOnly, [])).toThrow("no autorizado");
  });

  test("fingerprint binds the mode and both pinned hashes", async () => {
    const current = await supervisorFingerprint(readOnly);
    expect(current).toMatch(/^[a-f0-9]{64}$/);
    expect(await supervisorFingerprint({ ...readOnly, sourceCommit: "d".repeat(40) })).not.toBe(current);
    expect(await supervisorFingerprint({ ...readOnly, sourceTree: "e".repeat(40) })).not.toBe(current);
    expect(await supervisorFingerprint(base)).not.toBe(current);
  });

  test("read_only has no branch and its prompt forbids GitHub writes and PRs", () => {
    expect(supervisorBranch(base.requestId, repo, "read_only")).toBe("");
    expect(supervisorBranch(base.requestId, repo)).toBe("opencode/staging-" + base.requestId);
    expect(supervisorBranch(base.requestId, other)).toBe("opencode/supervised-" + base.requestId);
    const prompt = supervisorPrompt(readOnly, "", "supervised-" + base.requestId, commit, tree);
    expect(prompt).toContain("SOLO LECTURA");
    expect(prompt).toContain(commit);
    expect(prompt).toContain(tree);
    expect(prompt).toContain("no crees ramas");
    expect(prompt).toContain("no escribas");
    expect(prompt).not.toContain("Rama precreada");
  });

  test("read_only cannot create branches, write, review or open a PR", () => {
    for (const operation of ["branch", "write", "pr", "review"]) {
      expect(() => assertSupervisorBoundGitHubOperation(operation, "", "", "read_only")).toThrow("solo lectura");
    }
    expect(() => assertSupervisorBoundGitHubOperation("read", undefined, "", "read_only")).not.toThrow();
    expect(() => assertSupervisorBoundGitHubOperation("write", "opencode/staging-x", "opencode/staging-x"))
      .not.toThrow();
  });

  test("read_only import failure stops the sequence before any inference call", async () => {
    let inferred = false;
    const sequence = async (mode: "read_only" | undefined, fail: boolean) => {
      await preflightReadOnlySource(mode, async () => {
        if (fail) throw new Error("Git tree hash mismatch");
      });
      inferred = true;
    };
    await expect(sequence("read_only", true)).rejects.toThrow("tree");
    expect(inferred).toBe(false);
    await sequence(undefined, true);
    expect(inferred).toBe(true);
  });
});

describe("read-only GitHub identity verification", () => {
  function httpFor(options: {
    commit?: unknown; status?: number; tree?: string; requests: string[];
  }) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      options.requests.push((init?.method ?? "GET") + " " + value);
      if (value.endsWith("/repos/" + repo)) {
        return Response.json({ full_name: repo, default_branch: "main" });
      }
      if (value.includes("/commits/" + commit)) {
        if (options.status === 404) return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json({ sha: commit, commit: { tree: { sha: options.tree ?? tree } } });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }) as typeof fetch;
  }

  test("accepts only the commit whose tree equals sourceTree, using GET only", async () => {
    const requests: string[] = [];
    const bridge = new GitHubBridge("token", httpFor({ requests }));
    const result = await bridge.resolveReadOnlySource(repo, commit, tree);
    expect(result).toEqual({ repo, source: "pinned", commit, tree });
    expect(requests.every(item => item.startsWith("GET "))).toBe(true);
    expect(requests.some(item => item.includes("/commits/" + commit))).toBe(true);
  });

  test("rejects a nonexistent commit, a wrong tree and an unauthorized repo without writes", async () => {
    const missingRequests: string[] = [];
    const missing = new GitHubBridge("token", httpFor({ requests: missingRequests, status: 404 }));
    await expect(missing.resolveReadOnlySource(repo, commit, tree)).rejects.toThrow("no existe");
    expect(missingRequests.every(item => item.startsWith("GET "))).toBe(true);

    const wrongRequests: string[] = [];
    const wrong = new GitHubBridge("token", httpFor({ requests: wrongRequests, tree: "f".repeat(40) }));
    await expect(wrong.resolveReadOnlySource(repo, commit, tree)).rejects.toThrow("árbol");
    expect(wrongRequests.every(item => item.startsWith("GET "))).toBe(true);

    let requests = 0;
    const denied = new GitHubBridge("token", (async () => { requests++; throw new Error("unexpected"); }) as typeof fetch);
    await expect(denied.resolveReadOnlySource(other, commit, tree)).rejects.toThrow("not authorized");
    expect(requests).toBe(0);
  });

  test("rejects a missing token before any request", () => {
    expect(() => new GitHubBridge("")).toThrow("GITHUB_TOKEN");
  });
});

describe("source archive pins commit and tree", () => {
  function http(requests: string[], treeValue = tree) {
    return (async (url: string | URL | Request) => {
      const value = String(url);
      requests.push(value);
      if (value.endsWith("/repos/" + repo)) {
        return Response.json({ full_name: repo, default_branch: "main" });
      }
      if (value.includes("/commits/" + commit)) {
        return Response.json({ sha: commit, commit: { tree: { sha: treeValue } } });
      }
      if (value.endsWith("/tarball/" + commit)) return new Response("archive bytes");
      return Response.json({ message: "Not Found" }, { status: 404 });
    }) as typeof fetch;
  }

  test("verifies the commit tree before downloading only source bytes", async () => {
    const requests: string[] = [];
    const source = await githubSourceArchive(repo, "secret", [repo], http(requests), commit, tree);
    expect(source).toMatchObject({ repo, commit, tree });
    expect(requests.at(-1)).toEndWith("/tarball/" + commit);
    expect(await new Response(source.stream).text()).toBe("archive bytes");
  });

  test("aborts on a wrong tree or a nonexistent commit before the tarball", async () => {
    const wrong: string[] = [];
    await expect(githubSourceArchive(repo, "secret", [repo], http(wrong, "f".repeat(40)), commit, tree))
      .rejects.toThrow("árbol");
    expect(wrong.some(item => item.includes("/tarball/"))).toBe(false);

    const missing: string[] = [];
    const httpMissing = (async (url: string | URL | Request) => {
      const value = String(url);
      missing.push(value);
      if (value.endsWith("/repos/" + repo)) return Response.json({ full_name: repo, default_branch: "main" });
      return Response.json({ message: "Not Found" }, { status: 404 });
    }) as typeof fetch;
    await expect(githubSourceArchive(repo, "secret", [repo], httpMissing, commit, tree))
      .rejects.toThrow("no existe");
    expect(missing.some(item => item.includes("/tarball/"))).toBe(false);
  });

  test("validates the pair before HTTP and never sends the token in receipts", async () => {
    let requests = 0;
    const noHttp = (async () => { requests++; throw new Error("unexpected"); }) as typeof fetch;
    await expect(githubSourceArchive(repo, "secret", [repo], noHttp, commit.toUpperCase(), tree))
      .rejects.toThrow("Commit de origen inválido");
    await expect(githubSourceArchive(repo, "secret", [repo], noHttp, commit, tree.toUpperCase()))
      .rejects.toThrow("Árbol de origen inválido");
    await expect(githubSourceArchive(repo, "secret", [repo], noHttp, undefined, tree))
      .rejects.toThrow("sourceCommit");
    await expect(githubSourceArchive("aamvtrampa36-del/other", "secret", [repo], noHttp, commit, tree))
      .rejects.toThrow("autorizado");
    await expect(githubSourceArchive(repo, "", [repo], noHttp, commit, tree))
      .rejects.toThrow("Conecta GitHub");
    expect(requests).toBe(0);
  });

  test("a cached receipt must match both commit and tree", () => {
    expect(sourceReceiptMatches({ commit, tree }, commit, tree)).toBe(true);
    expect(sourceReceiptMatches({ commit, tree }, "d".repeat(40), tree)).toBe(false);
    expect(sourceReceiptMatches({ commit, tree }, commit, "e".repeat(40))).toBe(false);
    expect(sourceReceiptMatches({ commit }, commit, tree)).toBe(false);
    expect(sourceReceiptMatches({ commit }, commit, undefined)).toBe(true);
  });
});

describe("read_only asynchronous start", () => {
  test("returns immediately while slow source preparation continues in the background", async () => {
    let release!: () => void;
    const slowImport = new Promise<void>(resolve => { release = resolve; });
    const scheduled: Promise<void>[] = [];
    let entered = false;
    let completed = false;
    deferSupervisorStart(work => { scheduled.push(work); }, async () => {
      entered = true;
      await slowImport;
      completed = true;
    }, async () => { throw Error("Unexpected background failure"); });
    expect(scheduled).toHaveLength(1);
    expect(completed).toBe(false);
    await Promise.resolve();
    expect(entered).toBe(true);
    release();
    await Promise.all(scheduled);
    expect(completed).toBe(true);
  });

  test("captures an asynchronous start failure rather than rejecting the background lifetime", async () => {
    const scheduled: Promise<void>[] = [];
    const errors: string[] = [];
    deferSupervisorStart(work => { scheduled.push(work); },
      async () => { throw Error("source tree invalid"); },
      async error => { errors.push((error as Error).message); });
    await Promise.all(scheduled);
    expect(errors).toEqual(["source tree invalid"]);
  });
});

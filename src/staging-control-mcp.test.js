import { describe, expect, test } from "bun:test";
import { authorized, dispatchTool, handleMcp, TOOLS } from "./staging-control-mcp.js";

const token = "staging-private-test-token-012345678901234567890";
const url = "https://mcp.example.workers.dev/mcp";
const calls = [];
const backend = {
  remoteSupervisorStatus: async () => ({ environment: "staging", worker: "opencode-g1-staging", ready: true }),
  remoteSupervisorSessions: async () => ({ environment: "staging", sessions: [] }),
  remoteDynamicToolsStatus: async () => ({ environment: "staging", tools: [{id:"json-check",version:"123456789abc",status:"VERIFIED"}], sourceExposed:false,executable:false }),
  remoteSupervisorInspect: async id => ({ id, transcriptExcerpt: "test history" }),
  startSupervisedTask: async input => { calls.push(["start", input]); return { id: input.requestId, status: "running" }; },
  remoteSupervisorContinue: async input => { calls.push(["continue", input]); return { taskId: input.id, status: "submitted", operationId: "op1" }; },
  remoteSupervisorSelectModel: async (id, model) => ({ taskId: id, model }),
  supervisedTaskStatus: async id => ({ id, status: "finished", passed: false }),
  supervisedTaskReview: async id => ({ id, reviewRequired: true, approved: false }),
  cancelSupervisedTask: async id => ({ id, status: "cancelled" })
};
const env = {
  MCP_TOKEN: token,
  STAGING_AGENT: {
    getByName(name) {
      expect(name).toBe("opencode-supervisor-v1");
      return backend;
    }
  }
};
const message = (method, params, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const request = (data, auth = token) => new Request(url, {
  method: "POST", headers: {
    "Content-Type": "application/json",
    ...(auth ? { Authorization: "Bearer " + auth } : {})
  }, body: typeof data === "string" ? data : JSON.stringify(data)
});
const call = async (name, args = {}) =>
  (await handleMcp(request(message("tools/call", { name, arguments: args })), env)).json();

describe("Staging-only remote MCP", () => {
  test("cannot be used without a bound secret or without valid bearer credentials", async () => {
    expect((await handleMcp(request(message("ping")), { ...env, MCP_TOKEN: undefined })).status).toBe(503);
    expect((await handleMcp(request(message("ping"), "wrong-token"), env)).status).toBe(401);
    expect((await handleMcp(request(message("ping"), null), env)).status).toBe(401);
    expect(await authorized(request(message("ping")), token)).toBe("authorized");
    expect(await authorized(request(message("ping")), "short")).toBe("unconfigured");
  });
  test("implements MCP initialization, listing, ping and notifications without another agent", async () => {
    const initialized = await (await handleMcp(request(message("initialize", { protocolVersion: "2025-06-18" })), env)).json();
    expect(initialized.result.serverInfo.name).toBe("opencode-staging-debug-mcp-v2");
    const list = await (await handleMcp(request(message("tools/list")), env)).json();
    expect(list.result.tools).toHaveLength(10);
    expect(list.result.tools.find(x => x.name === "opencode_status").annotations.readOnlyHint).toBe(true);
    expect(list.result.tools.some(x => x.name.includes("production") || x.name.includes("merge"))).toBe(false);
    expect((await handleMcp(request(message("ping")), env)).status).toBe(200);
    const initializedNotification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await handleMcp(request(initializedNotification), env)).status).toBe(202);
    expect((await handleMcp(new Request(url, { method: "GET", headers: {Authorization:"Bearer "+token} }), env)).status).toBe(405);
  });
  test("calls the real bound staging stub, never an untrusted Worker URL", async () => {
    const status = await call("opencode_status");
    expect(JSON.parse(status.result.content[0].text)).toMatchObject({ environment:"staging", ready:true });
    const dyn = await call("opencode_dynamic_status");
    const tools = JSON.parse(dyn.result.content[0].text);
    expect(tools.sourceExposed).toBe(false);
    expect(tools.executable).toBe(false);
    expect(JSON.stringify(tools)).not.toContain("export default");
    const sessions = await call("opencode_sessions");
    expect(JSON.parse(sessions.result.content[0].text).sessions).toEqual([]);
    const read = await call("opencode_operation", { taskId:"a1234567890bcdef" });
    expect(JSON.parse(read.result.content[0].text)).toMatchObject({status:"finished",passed:false});
    const inspection = await call("opencode_inspect", {taskId:"a1234567890bcdef"});
    expect(JSON.parse(inspection.result.content[0].text).transcriptExcerpt).toBe("test history");
  });
  test("refuses production/other routing, unknown tools and malformed task IDs", async () => {
    const before = calls.length;
    for (const args of [
      { requestId:"a1234567890bcdef", repository:"other/production",prompt:"Run a staging test"},
      { requestId:"a1234567890bcdef", repository:"aamvtrampa36-del/opencode-harness-example",prompt:"Run a staging test", environment:"production"},
      { requestId:"bad", repository:"aamvtrampa36-del/opencode-harness-example",prompt:"Run a staging test"}
    ]) {
      const r = await call("opencode_submit", args);
      expect(r.result.isError).toBe(true);
    }
    expect(calls.length).toBe(before);
    const unknown = await call("cloudflare_deploy", { environment:"production" });
    expect(unknown.error.code).toBe(-32602);
  });
  test("submits once with a native model and supports idempotent next-turn operations", async () => {
    calls.length=0;
    const input = {requestId:"1234567890abcdef",repository:"aamvtrampa36-del/opencode-harness-example",
      prompt:"Investigate unit tests in a staging-only branch",model:"economy"};
    const start=await call("opencode_submit",input);
    expect(JSON.parse(start.result.content[0].text)).toMatchObject({id:input.requestId,status:"running"});
    expect(calls[0]).toEqual(["start",input]);
    const next=await call("opencode_continue",{taskId:input.requestId,turnId:"abcdef1234567890",
      prompt:"Continue diagnosing the staging-only test failure"});
    expect(JSON.parse(next.result.content[0].text).operationId).toBe("op1");
    expect(calls[1][1].id).toBe(input.requestId);
    expect(JSON.parse((await call("opencode_cancel",{taskId:input.requestId})).result.content[0].text).status).toBe("cancelled");
  });
  test("does not turn backend errors into success, and blocks non-self browser Origins", async () => {
    const r=await handleMcp(new Request(url,{
      method:"POST",headers:{
        "Content-Type":"application/json",Authorization:"Bearer "+token,
        Origin:"https://evil.example"
      },body:message("tools/list")
    }),env);
    expect(r.status).toBe(403);
    const failed=await handleMcp(request(message("tools/call",{name:"opencode_status",arguments:{}})), {
      MCP_TOKEN:token, STAGING_AGENT:{getByName(){throw new Error("upstream DO unavailable");}}
    });
    expect((await failed.json()).result).toMatchObject({isError:true});
  });
});

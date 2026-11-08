import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8788";
const abort = new AbortController();
const delay = ms => new Promise(r => setTimeout(r, ms));

async function awaitReady() {
  for (let n = 0; n < 90; n++) {
    try {
      const response = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(2500) });
      if (response.ok) return response.json();
    } catch { /* server not ready */ }
    await delay(1000);
  }
  throw new Error("Worker did not become ready after 90 seconds");
}

const health = await awaitReady();
assert.equal(health.status, "ok");
assert.equal(health.features.linuxShell, false, "Do not claim Linux functionality");
assert.equal(health.features.githubWrite, false, "Do not claim GitHub write");
assert.equal(typeof health.openRouterConfigured, "boolean");
console.log("PASS: live HTTP Worker health check", {
  runtime: health.runtime,
  openRouterConfigured: health.openRouterConfigured
});

const object = randomUUID();
const websocketURL = origin.replace(/^http/, "ws") + "/agents/open-code-agent/" + object + "?session=ses_root";

async function openSocket(url, expected = ["hello", "snapshot"]) {
  const socket = new WebSocket(url);
  const messages = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket session handshake timeout; received: " + JSON.stringify(messages)));
    }, 25_000);
    socket.addEventListener("message", e => {
      try {
        const msg = JSON.parse(e.data);
        messages.push(msg);
        if (msg.type === "error" && msg.code === "unknown_session") {
          clearTimeout(timer);
          socket.close();
          reject(new Error("Unexpected unknown session: " + msg.message));
        }
        if (expected.every(x => messages.some(m => m.type === x))) {
          clearTimeout(timer);
          resolve({ socket, messages });
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    socket.addEventListener("error", e => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed in running Worker"));
    });
    socket.addEventListener("close", e => {
      if (!expected.every(x => messages.some(m => m.type === x))) {
        clearTimeout(timer);
        reject(new Error("WebSocket closed before handshake: " + e.code));
      }
    });
  });
}

async function ask(socket, input, timeout = 12_000) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", onMessage); reject(new Error("No reply to " + input.type)); }, timeout);
    function onMessage(evt) {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(msg);
    }
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ ...input, id }));
  });
}

const { socket, messages } = await openSocket(websocketURL);
assert.equal(messages.find(m => m.type === "hello").openRouterAvailable, false);
console.log("PASS: real WebSocket and Durable Object root handshake");

const result = await ask(socket, { type: "create" });
assert.equal(result.type, "result", "Create session should return a real result");
const sessionId = result.result?.session;
assert.match(sessionId, /^ses[A-Za-z0-9_]{1,64}$/);
console.log("PASS: create persistent session");

const malformed = await ask(socket, { type: "submit", text: "no inference", model: "malicious-injected-model" });
assert.equal(malformed.type, "error");
assert.match(malformed.message, /Unknown model preset/);
const missing = await ask(socket, { type: "submit", text: "no inference", model: "economy" });
assert.equal(missing.type, "error");
assert.match(missing.message, /OpenRouter is not configured/);
console.log("PASS: rejected unauthorized model and missing API key without invoking models");

socket.close();
const next = await openSocket(origin.replace(/^http/, "ws") + "/agents/open-code-agent/" + object + "?session=" + sessionId);
assert.ok(next.messages.some(m => m.type === "sessions" && m.sessions.some(s => s.id === sessionId)));
console.log("PASS: session exists after connection is closed and reopened");
next.socket.close();

console.log("PASS: OpenCode local integration smoke checks completed");
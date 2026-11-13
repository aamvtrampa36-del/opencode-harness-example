import { describe, expect, test } from "bun:test";
import { trySendJson } from "./ws-send";

describe("fail-closed WebSocket sends", () => {
  test("transmits JSON when the socket is open", () => {
    const frames: string[] = [];
    const socket = { readyState: 1, send(data: string) { frames.push(data); } };
    expect(trySendJson(socket, { type: "submit", text: "hola" })).toBe(true);
    expect(frames).toEqual(['{"type":"submit","text":"hola"}']);
  });

  test("does not send anything when connecting or closed", () => {
    let calls = 0;
    const socket = { readyState: 0, send() { calls++; } };
    expect(trySendJson(socket, { type: "submit" })).toBe(false);
    socket.readyState = 3;
    expect(trySendJson(socket, { type: "abort" })).toBe(false);
    expect(calls).toBe(0);
  });

  test("reports a synchronous disconnect without throwing", () => {
    const socket = { readyState: 1, send() { throw new Error("Connection lost"); } };
    expect(trySendJson(socket, { type: "submit" })).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { captureBoundedOutput } from "./bounded-process-output";

const encoder = new TextEncoder();
function chunks(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    }
  });
}

describe("bounded process output", () => {
  test("passes through short output, including Unicode, without duplication", async () => {
    const result = await captureBoundedOutput(chunks("Hola ", "🧪", " mundo"), 64);
    expect(result).toEqual({
      text: "Hola 🧪 mundo", truncated: false,
      totalBytes: encoder.encode("Hola 🧪 mundo").length, omittedBytes: 0
    });
  });

  test("handles the exact boundary and overlapping prefix/suffix", async () => {
    const result = await captureBoundedOutput(chunks("abc", "def"), 6);
    expect(result.text).toBe("abcdef");
    expect(result.truncated).toBe(false);
    expect((await captureBoundedOutput(chunks("abc", "def"), 8)).text).toBe("abcdef");
  });

  test("retains start and end but counts omitted bytes", async () => {
    const result = await captureBoundedOutput(chunks("abc", "def", "ghi"), 6);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(9);
    expect(result.omittedBytes).toBe(3);
    expect(result.text.startsWith("abc")).toBe(true);
    expect(result.text.endsWith("ghi")).toBe(true);
    expect(result.text).toContain("3 bytes omitted");
  });

  test("supports absent streams and rejects unsafe limits", async () => {
    expect(await captureBoundedOutput(undefined, 128)).toEqual({
      text: "", truncated: false, totalBytes: 0, omittedBytes: 0
    });
    expect((await captureBoundedOutput(chunks("abc"), 1)).omittedBytes).toBe(2);
    await expect(captureBoundedOutput(chunks("abc"), 0)).rejects.toThrow(RangeError);
  });

  test("drains 16 MiB while retaining at most 128 bytes of payload", async () => {
    let emitted = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted++ < 2048) controller.enqueue(new Uint8Array(8192).fill(65));
        else controller.close();
      }
    });
    const result = await captureBoundedOutput(huge, 128);
    expect(result.totalBytes).toBe(16 * 1024 * 1024);
    expect(result.omittedBytes).toBe(result.totalBytes - 128);
    expect(result.text.startsWith("A".repeat(64))).toBe(true);
    expect(result.text.endsWith("A".repeat(64))).toBe(true);
  });

  test("allows stdout and stderr to drain concurrently", async () => {
    const [stdout, stderr] = await Promise.all([
      captureBoundedOutput(chunks("x".repeat(10000)), 128),
      captureBoundedOutput(chunks("y".repeat(5000)), 128)
    ]);
    expect([stdout.totalBytes, stderr.totalBytes]).toEqual([10000, 5000]);
    expect(stdout.truncated).toBe(true);
    expect(stderr.truncated).toBe(true);
  });
});


describe("bounded pipe edge contracts", () => {
  test("empty chunks and empty stream retain zero bytes", async () => {
    expect(await captureBoundedOutput(chunks("", "", ""), 3)).toEqual({ text: "", truncated: false, totalBytes: 0, omittedBytes: 0 });
  });
  test("odd budget retains ceil prefix and floor suffix", async () => {
    const r = await captureBoundedOutput(chunks("ab", "cdefghij"), 5);
    expect(r.text.startsWith("abc")).toBe(true);
    expect(r.text.endsWith("ij")).toBe(true);
    expect(r.omittedBytes).toBe(5);
  });
  test("a single byte budget retains the prefix and no suffix", async () => {
    const r = await captureBoundedOutput(chunks("a", "z"), 1);
    expect(r.text.startsWith("a")).toBe(true);
    expect(r.omittedBytes).toBe(1);
    expect(r.totalBytes).toBe(2);
  });
  test("UTF-8 character split across actual binary chunks is reassembled", async () => {
    const bytes = encoder.encode("a🧪b");
    const stream = new ReadableStream<Uint8Array>({start(c) { c.enqueue(bytes.slice(0, 3)); c.enqueue(bytes.slice(3)); c.close(); }});
    expect((await captureBoundedOutput(stream, bytes.length)).text).toBe("a🧪b");
  });
  test("pipe errors propagate and release the stream reader", async () => {
    const stream = new ReadableStream<Uint8Array>({start(c) { c.error(Error("pipe broken")); }});
    await expect(captureBoundedOutput(stream, 8)).rejects.toThrow("pipe broken");
    expect(stream.locked).toBe(false);
  });
  test("noninteger and infinite limits fail before reading", async () => {
    const stream = chunks("a");
    await expect(captureBoundedOutput(stream, 1.5)).rejects.toThrow(RangeError);
    await expect(captureBoundedOutput(stream, Infinity)).rejects.toThrow(RangeError);
    expect(stream.locked).toBe(false);
  });
});

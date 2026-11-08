import { describe, expect, test } from "bun:test";
import { BACKUP_CHUNK_BYTES, chunkBackup, joinBackup, MAX_ARCHIVE_BYTES, sha256Hex } from "./durable-backup";

describe("independent project archive backup", () => {
  test("chunks and restores gzip bytes without data loss", async () => {
    const input = new Uint8Array(100_000);
    input[0] = 0x1f; input[1] = 0x8b;
    for (let i = 2; i < input.length; i++) input[i] = i % 251;
    const parts = chunkBackup(input);
    expect(parts.length).toBe(2);
    expect(parts[0].length).toBe(BACKUP_CHUNK_BYTES);
    const restored = joinBackup(parts, input.byteLength);
    expect(restored).toEqual(input);
    expect(await sha256Hex(restored)).toBe(await sha256Hex(input));
  });
  test("refuses invalid, oversized or incomplete backup", () => {
    expect(() => chunkBackup(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => chunkBackup(new Uint8Array(MAX_ARCHIVE_BYTES + 1))).toThrow();
    expect(() => joinBackup([new Uint8Array([0x1f,0x8b,1])], 4)).toThrow();
  });
});

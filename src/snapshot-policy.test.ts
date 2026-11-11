import { describe, expect, test } from "bun:test";
import { assertRecoverableContainer } from "./snapshot-policy";

describe("Container recovery", () => {
  test("allows the initial empty Container and a recent snapshot", () => {
    expect(() => assertRecoverableContainer(undefined, undefined, undefined, 1000)).not.toThrow();
    expect(() => assertRecoverableContainer("snapshot", 900, 950, 1000)).not.toThrow();
  });
  test("fails closed instead of replacing missing or expired work with an empty image", () => {
    expect(() => assertRecoverableContainer(undefined, undefined, 100, 1000)).toThrow("no tiene");
    expect(() => assertRecoverableContainer("snapshot", 100, 100, 31 * 86400_000)).toThrow("venció");
  });
});

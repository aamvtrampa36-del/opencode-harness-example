import { describe, expect, test } from "bun:test";
import { isInternalReminder } from "./message-display";

describe("synthetic message display", () => {
  test("recognizes internal plan-mode context", () => {
    expect(isInternalReminder("  <system-reminder>\nYou are in Plan mode.\n</system-reminder>  ")).toBe(true);
  });
  test("preserves normal status messages and partial or quoted text", () => {
    expect(isInternalReminder("Session restored")).toBe(false);
    expect(isInternalReminder("A user mentioned <system-reminder>")).toBe(false);
    expect(isInternalReminder("<system-reminder>incomplete")).toBe(false);
  });
});

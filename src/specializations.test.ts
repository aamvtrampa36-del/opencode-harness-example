import { describe, expect, test } from "bun:test";
import { validateSpecialization } from "./specializations";

describe("optional specializations", () => {
  test("accept an ordinary reusable project specialization", () => {
    expect(validateSpecialization({
      id: "android", name: "Android", instructions: "Crea apps Java con pruebas", enabled: true
    })).toEqual({
      id: "android", name: "Android", instructions: "Crea apps Java con pruebas", enabled: true
    });
  });
  test("reject malformed names, profiles and forbidden identifiers", () => {
    expect(() => validateSpecialization(null)).toThrow();
    expect(() => validateSpecialization({ id: "../etc", name: "Hi", instructions: "Do work", enabled: true })).toThrow();
    expect(() => validateSpecialization({ id: "web", name: "W", instructions: "Do work", enabled: true })).toThrow();
  });
  test("reject oversized profile prompts and embedded API secrets", () => {
    expect(() => validateSpecialization({ id: "web", name: "Web", instructions: "x".repeat(4001), enabled: true })).toThrow();
    expect(() => validateSpecialization({
      id: "web", name: "Web", instructions: "Use sk-or-v1-abcdefghijklmno", enabled: true
    })).toThrow("API credentials");
  });
});

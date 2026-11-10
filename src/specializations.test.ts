import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPECIALIZATIONS, MAX_SPECIALIZATIONS,
  mergeSpecializations, specializationPrompt, validateSpecialization
} from "./specializations";

describe("G6 reusable editable templates", () => {
  test("seven predefined profiles exist with valid modes, models and bounded instructions", () => {
    expect(DEFAULT_SPECIALIZATIONS.map(profile => profile.id)).toEqual([
      "desarrollo", "diagnostico", "revision", "planificacion", "decisiones", "flujo", "documentacion"
    ]);
    expect(MAX_SPECIALIZATIONS).toBeGreaterThanOrEqual(7);
    for (const template of DEFAULT_SPECIALIZATIONS) {
      expect(validateSpecialization(template)).toEqual(template);
      expect(template.instructions.length).toBeLessThanOrEqual(4000);
    }
  });

  test("defaults are available without rewriting or destroying user records", () => {
    const prior = { id: "android", name: "Android", instructions: "Crea apps Java con pruebas", enabled: true };
    const current = mergeSpecializations([prior]);
    expect(current).toHaveLength(8);
    expect(current.find(item => item.id === "android")).toEqual(prior);
    expect(current.find(item => item.id === "desarrollo")).toEqual(DEFAULT_SPECIALIZATIONS[0]);
  });

  test("a saved override dynamically replaces instructions; deleting override restores default", () => {
    const revised = validateSpecialization({
      ...DEFAULT_SPECIALIZATIONS[0], instructions: "Responde exactamente PERFIL_G6_EDITADO"
    });
    const original = mergeSpecializations([]).find(item => item.id === "desarrollo")!;
    const modified = mergeSpecializations([revised]).find(item => item.id === "desarrollo")!;
    expect(specializationPrompt(modified)).toContain("PERFIL_G6_EDITADO");
    expect(specializationPrompt(original)).not.toContain("PERFIL_G6_EDITADO");
    expect(mergeSpecializations([]).find(item => item.id === "desarrollo")).toEqual(original);
  });

  test("copying yields a separately editable identity and preserves original", () => {
    const original = DEFAULT_SPECIALIZATIONS[1];
    const copied = validateSpecialization({ ...original, id: "diagnostico-copia", name: "Diagnóstico copia" });
    const all = mergeSpecializations([copied]);
    expect(all.find(item => item.id === original.id)?.instructions).toBe(original.instructions);
    expect(all.find(item => item.id === copied.id)?.instructions).toBe(original.instructions);
  });

  test("backward compatibility for saved legacy profiles with no mode/model", () => {
    const old = { id: "android", name: "Android", instructions: "Crea apps Java con pruebas", enabled: true };
    expect(validateSpecialization(old)).toMatchObject({ mode: "build", model: "cloudflare" });
    expect(mergeSpecializations([old]).find(x => x.id === "android")).toEqual(old);
  });

  test("reject malformed names, invalid modes and unknown model identifiers", () => {
    expect(() => validateSpecialization(null)).toThrow();
    expect(() => validateSpecialization({ id: "../etc", name: "Hi", instructions: "Do work", enabled: true })).toThrow();
    expect(() => validateSpecialization({ id: "web", name: "W", instructions: "Do work", enabled: true })).toThrow();
    expect(() => validateSpecialization({ id: "web", name: "Web", instructions: "Do work", enabled: true, mode: "root" })).toThrow();
    expect(() => validateSpecialization({ id: "web", name: "Web", instructions: "Do work", enabled: true, model: "expensive-unlisted" })).toThrow();
  });

  test("reject oversized prompts and recognizable embedded API secrets", () => {
    expect(() => validateSpecialization({ id: "web", name: "Web", instructions: "x".repeat(4001), enabled: true })).toThrow();
    expect(() => validateSpecialization({
      id: "web", name: "Web", instructions: "Use sk-or-v1-abcdefghijklmno", enabled: true
    })).toThrow("API credentials");
  });
});

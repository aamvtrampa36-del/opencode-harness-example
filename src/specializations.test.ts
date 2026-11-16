import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPECIALIZATIONS, MAX_SPECIALIZATIONS, MAX_WORKFLOW_STAGES,
  mergeSpecializations, specializationPrompt, validateSpecialization
} from "./specializations";

describe("editable general chat and staged templates", () => {
  test("offers one optional CDF flow instead of persistent role modes", () => {
    expect(DEFAULT_SPECIALIZATIONS.map(profile => profile.id)).toEqual(["cdf-workflow"]);
    expect(DEFAULT_SPECIALIZATIONS[0]?.stages).toHaveLength(2);
    expect(MAX_SPECIALIZATIONS).toBeGreaterThanOrEqual(1);
    for (const template of DEFAULT_SPECIALIZATIONS) expect(validateSpecialization(template)).toMatchObject(template);
  });

  test("keeps previous custom records while exposing the compact default set", () => {
    const prior = { id: "android", name: "Android", instructions: "Crea apps Java con pruebas", enabled: true };
    const current = mergeSpecializations([prior]);
    expect(current).toHaveLength(2);
    expect(current.find(item => item.id === "android")).toEqual(prior);
    expect(current.find(item => item.id === "cdf-workflow")).toEqual(DEFAULT_SPECIALIZATIONS[0]);
  });

  test("editable overrides are applied dynamically and deletion restores the default", () => {
    const original = DEFAULT_SPECIALIZATIONS[0]!;
    const revised = validateSpecialization({ ...original, instructions: "Confirma cada cambio." });
    expect(specializationPrompt(revised)).toContain("Confirma cada cambio.");
    expect(specializationPrompt(original)).not.toContain("Confirma cada cambio.");
    expect(mergeSpecializations([]).find(item => item.id === original.id)).toEqual(original);
  });

  test("supports ordered stages with individual model and read-only or tool-enabled access", () => {
    const flow = validateSpecialization({
      id: "decision-flow", name: "Decidir y ejecutar", instructions: "Cumple el objetivo con evidencia.", enabled: true,
      model: "cloudflare", stages: [
        { name: "Decidir", instructions: "Compara las opciones.", model: "reasoning", mode: "plan" },
        { name: "Ejecutar", instructions: "Aplica la opción elegida.", model: "economy", mode: "build" }
      ]
    });
    expect(flow.stages).toEqual([
      { name: "Decidir", instructions: "Compara las opciones.", model: "reasoning", mode: "plan" },
      { name: "Ejecutar", instructions: "Aplica la opción elegida.", model: "economy", mode: "build" }
    ]);
    expect(() => validateSpecialization({ ...flow, stages: Array.from({ length: MAX_WORKFLOW_STAGES + 1 }, () => flow.stages![0]) })).toThrow();
    expect(() => validateSpecialization({ ...flow, stages: [{ name: "Etapa", instructions: "   " }] })).toThrow();
  });

  test("retains model preferences for image and decision work", () => {
    const profile = validateSpecialization({ id: "multimodal", name: "Multimodal",
      instructions: "Analiza y crea imágenes.", enabled: true, model: "openrouter:google/gemini-4-hydrogen",
      decisionModel: "reasoning", imageModel: "google/imagen-4" });
    expect(specializationPrompt(profile)).toContain("google/imagen-4");
    expect(() => validateSpecialization({ ...profile, imageModel: "../outside" })).toThrow();
    expect(() => validateSpecialization({ ...profile, decisionModel: "unknown-model" })).toThrow();
  });

  test("accepts legacy templates and rejects invalid or oversized values", () => {
    const old = { id: "android", name: "Android", instructions: "Crea apps Java con pruebas", enabled: true };
    expect(validateSpecialization(old)).toMatchObject({ mode: "build", model: "cloudflare" });
    expect(() => validateSpecialization({ ...old, id: "../etc" })).toThrow();
    expect(() => validateSpecialization({ ...old, instructions: "x".repeat(4001) })).toThrow();
    expect(() => validateSpecialization({ ...old, instructions: "Use sk-or-v1-abcdefghijklmno" })).toThrow("API credentials");
    expect(() => validateSpecialization({ ...old, model: "expensive-unlisted" })).toThrow();
  });
});

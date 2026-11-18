import { describe, expect, test } from "bun:test";
import { classifyNumbers } from "../src/classify-numbers.mjs";

const mixed = [3, -1, 0, 7, -0, -2.5, 0.25];

describe("classifyNumbers — contrato del PLANIFICADOR", () => {
  test("L3: particiona y conserva orden y conteos", () => {
    expect(classifyNumbers(mixed)).toEqual({
      positives: [3, 7, 0.25],
      negatives: [-1, -2.5],
      zeros: [0, -0],
      counts: { positives: 3, negatives: 2, zeros: 2, total: 7 },
    });
  });

  test("L1: array vacío", () => {
    expect(classifyNumbers([])).toEqual({
      positives: [],
      negatives: [],
      zeros: [],
      counts: { positives: 0, negatives: 0, zeros: 0, total: 0 },
    });
  });

  test("L2: -0 cuenta como cero, no como negativo", () => {
    const result = classifyNumbers([-0, 0]);
    expect(result.negatives).toEqual([]);
    expect(result.zeros.length).toBe(2);
    expect(Object.is(result.zeros[0], -0)).toBe(true);
    expect(result.counts).toEqual({ positives: 0, negatives: 0, zeros: 2, total: 2 });
  });

  test("L4: NaN se rechaza", () => {
    expect(() => classifyNumbers([1, NaN])).toThrow(TypeError);
  });

  test("L5: ±Infinity se rechazan", () => {
    expect(() => classifyNumbers([Infinity])).toThrow(TypeError);
    expect(() => classifyNumbers([-Infinity])).toThrow(TypeError);
  });

  test("L6: cadenas numéricas se rechazan sin coerción", () => {
    expect(() => classifyNumbers(["1"])).toThrow(TypeError);
  });

  test("L7: hueco de array disperso se rechaza en su índice", () => {
    const sparse = [1, , 3];
    expect(() => classifyNumbers(sparse)).toThrow(/index 1/);
  });

  test("L8: objeto envoltorio Number se rechaza", () => {
    expect(() => classifyNumbers([new Number(1)])).toThrow(TypeError);
  });

  test("L9: BigInt se rechaza", () => {
    expect(() => classifyNumbers([1n])).toThrow(TypeError);
  });

  test("L10: valores extremos finitos se aceptan", () => {
    const result = classifyNumbers([Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE]);
    expect(result.counts).toEqual({ positives: 2, negatives: 1, zeros: 0, total: 3 });
  });

  test("L11: entrada que no es array se rechaza", () => {
    expect(() => classifyNumbers("1,2")).toThrow(TypeError);
    expect(() => classifyNumbers(null)).toThrow(TypeError);
    expect(() => classifyNumbers(undefined)).toThrow(TypeError);
  });

  test("L12: no muta la entrada", () => {
    const input = [3, -1, 0, -0];
    const snapshot = structuredClone(input);
    classifyNumbers(input);
    expect(input).toEqual(snapshot);
    expect(input.length).toBe(snapshot.length);
  });

  test("atomicidad: un inválido al final no devuelve resultado parcial", () => {
    let result;
    try {
      result = classifyNumbers([1, 2, 3, "boom"]);
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
    }
    expect(result).toBeUndefined();
  });
});

describe("classifyNumbers — hallazgos del REVISOR (regresión)", () => {
  test("R1: [null] y [undefined] se rechazan identificando el índice", () => {
    expect(() => classifyNumbers([null])).toThrow(/index 0/);
    expect(() => classifyNumbers([undefined])).toThrow(/index 0/);
  });

  test("R2: la cadena numérica rechazada identifica su índice", () => {
    expect(() => classifyNumbers([1, 2, "3"])).toThrow(/index 2/);
  });

  test("R3: Proxy con length inconsistente no rompe counts.total", () => {
    const target = [1, 2, 3];
    let lengthReads = 0;
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        if (key === "length") {
          lengthReads += 1;
          return lengthReads <= 4 ? 3 : 2;
        }
        return Reflect.get(t, key, receiver);
      },
    });

    const result = classifyNumbers(proxy);
    expect(result.counts).toEqual({ positives: 3, negatives: 0, zeros: 0, total: 3 });
    expect(lengthReads).toBe(1);
  });
});

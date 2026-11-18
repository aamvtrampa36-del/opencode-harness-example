/**
 * Clasifica números finitos en positivos, negativos y ceros.
 * Función pura: no muta `values` ni estado externo.
 *
 * @param {unknown} values
 * @returns {{positives: number[], negatives: number[], zeros: number[],
 *            counts: {positives: number, negatives: number, zeros: number, total: number}}}
 * @throws {TypeError} si `values` no es un Array o contiene un valor no numérico/no finito.
 */
export function classifyNumbers(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("classifyNumbers: expected an array of finite numbers");
  }

  // Una sola lectura de `length`: evita que un Proxy con `get` inconsistente
  // haga que `counts.total` no coincida con los elementos realmente clasificados.
  const length = values.length;
  const positives = [];
  const negatives = [];
  const zeros = [];

  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `classifyNumbers: value at index ${index} is not a finite number`,
      );
    }

    // `-0` y `0` cumplen ambas comparaciones como falsas y caen en zeros.
    if (value > 0) {
      positives.push(value);
    } else if (value < 0) {
      negatives.push(value);
    } else {
      zeros.push(value);
    }
  }

  return {
    positives,
    negatives,
    zeros,
    counts: {
      positives: positives.length,
      negatives: negatives.length,
      zeros: zeros.length,
      total: length,
    },
  };
}

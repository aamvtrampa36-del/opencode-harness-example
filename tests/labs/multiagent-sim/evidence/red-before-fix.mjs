// Reconstrucción de la versión ANTERIOR (lee values.length dos veces) para
// demostrar que el caso R3 del revisor era un fallo real, no hipotético.
function classifyOld(values) {
  if (!Array.isArray(values)) throw new TypeError("expected array");
  const positives = [], negatives = [], zeros = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("bad");
    if (value > 0) positives.push(value);
    else if (value < 0) negatives.push(value);
    else zeros.push(value);
  }
  return { counts: { positives: positives.length, negatives: negatives.length, zeros: zeros.length, total: values.length } };
}

const target = [1, 2, 3];
let reads = 0;
const proxy = new Proxy(target, {
  get(t, k, r) {
    if (k === "length") { reads += 1; return reads <= 4 ? 3 : 2; }
    return Reflect.get(t, k, r);
  },
});

const result = classifyOld(proxy);
const sum = result.counts.positives + result.counts.negatives + result.counts.zeros;
console.log(JSON.stringify({ counts: result.counts, sum, consistent: result.counts.total === sum }));

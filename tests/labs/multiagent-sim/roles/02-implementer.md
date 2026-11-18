# ROL 2 — IMPLEMENTADOR (notas de implementación)

Estado: artefacto escrito por el coordinador, sin agente independiente.
Archivo producido: `src/classify-numbers.mjs`.

## Decisiones

- Bucle `for` indexado (no `for..of`) para reportar el índice exacto del valor
  inválido y para no saltar huecos de arrays dispersos: un hueco produce
  `undefined` y se rechaza.
- Validación por elemento antes de clasificar. Al lanzar `TypeError` no se
  devuelve objeto parcial: el rechazo es atómico a nivel de retorno.
- `typeof value !== "number"` rechaza `"1"`, `null`, `undefined`, `BigInt` y
  objetos envoltorio (`new Number(1)`), sin coerción.
- `Number.isFinite` rechaza `NaN`, `Infinity` y `-Infinity`.
- `value > 0` / `value < 0`: `-0` y `0` no cumplen ninguna y van a `zeros`.
- Sin `sort`, `map` ni copias intermedias: el orden de entrada se conserva
  dentro de cada grupo y el coste es O(n).

## Límite conocido declarado por el implementador

- El mensaje de error incluye el índice, pero no el valor recibido (evita
  serializar objetos raros en el mensaje). El planificador no lo exige.

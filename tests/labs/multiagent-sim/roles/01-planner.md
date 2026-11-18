# ROL 1 — PLANIFICADOR (especificación)

Estado: artefacto escrito por el coordinador, sin agente independiente.
Fecha: 2026-11-18. Ámbito: `tests/labs/multiagent-sim/` exclusivamente.

## Contrato solicitado

`classifyNumbers(values)` — función JavaScript pura.

Entrada: un `Array` de números finitos.
Salida: objeto con tres grupos en orden de entrada y sus conteos:

```
{
  positives: number[],
  negatives: number[],
  zeros: number[],
  counts: { positives, negatives, zeros, total }
}
```

Invariantes:

1. Pureza: no muta la entrada ni estado externo; misma entrada → mismo resultado.
2. Partición completa: cada elemento válido aparece exactamente en un grupo.
3. `total === values.length` y `total === counts.positives + counts.negatives + counts.zeros`.
4. Orden relativo conservado dentro de cada grupo.
5. `-0` es cero (no negativo); `0` es cero.
6. Rechazo atómico: si algún elemento no es `number` finito, se lanza `TypeError`
   y no se devuelve resultado parcial. El mensaje identifica el índice.
7. `NaN`, `Infinity`, `-Infinity`, `"1"`, `null`, `undefined`, huecos de array
   disperso, `BigInt` y `new Number(1)` son entradas inválidas.
8. Entrada que no es `Array` → `TypeError`.
9. Valores extremos finitos (`Number.MAX_VALUE`, `Number.MIN_VALUE`,
   `-Number.MAX_VALUE`) son válidos.

## Casos límite que el verificador debe cubrir

| # | Caso | Esperado |
|---|------|----------|
| L1 | `[]` | tres grupos vacíos, `total: 0` |
| L2 | `[-0, 0]` | `zeros: [-0, 0]`, `negatives: []` |
| L3 | `[1, -1, 0]` | conteos 1/1/1, `total: 3` |
| L4 | `[NaN]` | `TypeError`, sin resultado |
| L5 | `[Infinity]`, `[-Infinity]` | `TypeError` |
| L6 | `["1"]` | `TypeError` (no coerción) |
| L7 | `[1, , 3]` (hueco) | `TypeError` en índice 1 |
| L8 | `new Number(1)` | `TypeError` |
| L9 | `[1n]` | `TypeError` |
| L10 | `Number.MAX_VALUE`, `Number.MIN_VALUE` | aceptados, clasificados |
| L11 | entrada no array (`"1,2"`, `null`) | `TypeError` |
| L12 | input no mutado | comparación estructural tras la llamada |

## Fuera de alcance

- Redondeo, suma o estadísticas (solo clasificación y conteo).
- Coerción de tipos.
- Escritura fuera de la carpeta del laboratorio.

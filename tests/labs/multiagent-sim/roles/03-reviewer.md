# ROL 3 — REVISOR (crítica independiente)

## Trazabilidad de la invocación

- Sesión hija real: `ses_e1255326cffct1hjizaUBRwmxI` (herramienta `start_subagent`,
  kind=analysis, solo lectura, contexto limpio).
- El revisor leyó por su cuenta `roles/01-planner.md`, `src/classify-numbers.mjs` y
  `tests/classify-numbers.test.mjs` con `inspect_linux`.
- **No ejecutó comandos** ni `bun test`; su revisión fue estática y lo declara.
- Es una sesión derivada del mismo runtime, **no un proceso del sistema operativo**.
  No se observó concurrencia física con el coordinador.

## Crítica recibida (resumen fiel, sin reescribirla como propia)

1. **Defecto real — `Proxy` con `length` inconsistente.** `Array.isArray` acepta un
   Proxy sobre array y el código releía `values.length` al construir `counts.total`;
   un `get` inconsistente rompe `total === suma de conteos`.
2. **Contrato de error más estrecho que el JSDoc** ante `get`/Proxy hostiles.
3. **Cobertura incompleta del plan:** no había tests de `[null]` ni `[undefined]`
   como elementos (solo como entrada completa).
4. **Mensaje con índice poco probado:** solo L7 verificaba `/index 1/`.
5. **Pureza escasamente demostrada:** L12 no cubre getters ni estado externo.

## Caso adversarial nuevo propuesto

```js
const target = [1, 2, 3];
let reads = 0;
const p = new Proxy(target, {
  get(t, k, r) {
    if (k === "length") return ++reads <= 4 ? 3 : 2;
    return Reflect.get(t, k, r);
  },
});
classifyNumbers(p);
```

Predicción del revisor: `counts.total: 2` con 3 elementos clasificados → **falla**.

## Veredicto del revisor

**PASS CON OBSERVACIONES.** Implementación correcta para arrays reales y para todo
el plan; tests no tautológicos (L2 distingue `-0`, L7 verifica índice, L12 no
mutación). Hueco material: `Proxy`/`length` y cobertura de `[null]`/`[undefined]`.

## Acción del coordinador

- Se aceptó la observación 1: `length` se lee una sola vez.
- Se añadieron tests R1 (`[null]`, `[undefined]` con índice), R2 (índice en cadena)
  y R3 (Proxy con `length` inconsistente, exige una sola lectura).
- Se verificó el rojo real con `evidence/red-before-fix.mjs`:
  `{"counts":{...,"total":2},"sum":3,"consistent":false}`.
- Tras la corrección: **16 pass / 0 fail** (`evidence/verifier-final.log`).

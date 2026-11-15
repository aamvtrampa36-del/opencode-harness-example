# Experimento aislado: `OpenCodeHarness.settled()` (2026-11-15)

**Solo investigación.** No se importa el archivo modificado desde OpenCode Cloud, no se ha cambiado `main`, PR #54, Staging ni Producción. **NO FUSIONAR NI DESPLEGAR.**

## Qué se modificó
- Paquete fijado por la app: `agents@0.33.0`, OpenCode SDK `2.0.24`.
- Fuente upstream oficial de la release: `cloudflare/agents`, tag `agents@0.33.0`, `packages/agents/src/harness/opencode/harness.ts`; blob Git `60a53571e9ab23f012a4fedbf5aed5255fad773e`. Licencia MIT adjunta.
- Archivo `harness-patched.ts.txt`: copia real del código interno del Harness con una única corrección reversible en `settled()`: no despertar al job ni esperar `heartbeatMs/30` después de una operación que ya terminó normalmente.
- Se conservó la activación del wake si la operación queda pendiente tras una interrupción. Este cambio es similar al fix publicado en `cloudflare/agents#2784` / PR #2785: **no es un hallazgo original**.
- `src/harness-wait-experiment.test.ts` contrasta en CI las dos ramas de control del algoritmo y que el archivo modificado tenga la lógica esperada. Es una prueba **sintética**, no ejecuta el Harness desplegado.

## Medición local con modelo sintético de flujo de control

Entorno: Node.js 22.16.0, espera del Harness configurada a `heartbeatMs = 30 000` (pausa `= 1000 ms`), 3 repeticiones por caso y variante, orden alterno AB/BA. Una simulación conserva únicamente la lógica de `settled()`, sin modelos de IA, DO, red, SQLite ni herramientas de producción.

| Escenario | Original media (ms) | Variante media (ms) | Invariante |
| --- | ---: | ---: | --- |
| Operación terminada normalmente | 1001.54 | 0.011 | resultado `done`; wake original=1 y variante=0 |
| Recuperación de operación interrumpida | 1001.28 | 1001.59 | resultado `done`; ambas generan 1 wake |

12/12 ejecuciones sintéticas cumplen los invariantes fijados. El registro bruto `runs.jsonl` y sus pares `begin`/`end` se conserva en el artefacto descargable de la conversación; SHA-256 `498f8fa63666e7a7bc6e68bfcfbb472cd18ff95883428bc2b4a977e947672ae9`. Un fallo del agregador inicial se registró y corrigió **sin alterar el journal**; ver `summary-corrected.json` en el artefacto.

## Interpretación estricta

- **Viabilidad de modificar la fuente interna:** OBSERVADA (copia exacta de la release, cambio localizado persistido en la rama).
- **Beneficio de la variante para el flujo sintético:** OBSERVADO en 3 pares.
- **Beneficio sobre una ejecución real de OpenCode Cloud/Cloudflare:** **NO VERIFICADO**. Este experimento NO compila `agents` modificado ni lo ejecuta en un Durable Object. No permite afirmar mejora de latencia end-to-end, tokens o dinero.
- **Integración futura posible:** `bun patch agents@0.33.0` y `bun patch --commit agents@0.33.0` en una copia de desarrollo (o fork del SDK), seguido de pruebas reales de `harness.wait()`, recuperación tras caída y regresiones. No se realizó porque es más costoso y excede esta primera demostración.
- **Criterio de avance:** solo considerar una prueba de integración real si el beneficio esperado justifica mantener un parche propio sobre una dependencia experimental; comprobar primero si Cloudflare incorporó la corrección en una versión nueva.

El verdadero precedente con Asana fue una campaña de evaluación del bucle de navegación y la gestión de caché/historial; no permite extrapolar multiplicadores de rendimiento a OpenCode Cloud.

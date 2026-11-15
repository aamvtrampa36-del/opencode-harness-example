# Experimento 3 — Lecturas incrementales del historial de OpenCode Cloud

**Fecha:** 15 de noviembre de 2026. **Estado:** mejora local observada, efecto real en Cloudflare **NO VERIFICADO**. **NO FUSIONAR NI DESPLEGAR.**

## 1. Antecedentes protegidos

- PR #55 / `experiment/harness-settled-20261115`: archivada para investigación futura. Solo hubo un beneficio simulado.
- PR #56 / `experiment/session-snapshot-delta-20261115`: archivada, validada parcialmente (hasta 95,4 % menos tráfico WebSocket en un escenario artificial); no demostró ahorro de tokens, costo o latencia real.
- Este experimento es una rama nueva e independiente. No incluye cambios de las PR #55/#56 y no las modifica. La PR #54 y la operación existente tampoco se tocaron.

## 2. Evidencia del cuello de botella

En `main`, `src/sockets.ts` llama a `handle.history()` en `#snapshot()`, invocado tras eventos como `tool_end`, `tool_start`, `message_end` y al conectarse. En `agents@0.33.0`, `OpenCodeSession.history()` recorre `opencode.message.list()` en páginas **ascendentes de 100 mensajes hasta el final**, incluyendo mensajes anteriores a compactaciones. En sesiones extensas, cada actualización repite todo el recorrido.

**No confundir:** `history()` es el historial completo visible; `messages()` usa el contexto activo después de compactación. La modificación no altera las entradas al modelo.

Referencias técnicas: `cloudflare/agents` tag `agents@0.33.0`, `packages/agents/src/harness/opencode/harness.ts`; `src/sockets.ts` y `src/use-opencode-session.ts` de la aplicación.

## 3. Implementación experimental

La clase `src/experimental-history-tail.ts` utiliza **la implementación de la app** y la API interna accesible del Harness, `harness.use(opencode => opencode.message.list(...))`, para recuperar una página reciente en **orden descendente** (100 mensajes) y unirla con el historial completo leído anteriormente mediante un ID estable que aparece en ambos.

- Primera lectura, nuevo WebSocket y `resync`: siempre lectura canónica completa.
- `run_end`, `compaction_start` y `transcript_reset`: invalidan la memoria y fuerzan lectura completa.
- Si no existe solapamiento de IDs: lectura completa automática.
- La caché es **solo memoria de un Durable Object, no almacenamiento persistente**; se descarta si la sesión deja de estar observada.
- Limita a 2.000 mensajes el historial retenido. Serializa las lecturas concurrentes por sesión y usa una generación de invalidación para evitar reutilización tras una carrera con reset.
- No se añade dependencia, servicio ni sistema de caché distribuido.
- `src/sockets.ts` tiene el modo `tail` como opción de constructor exclusivamente experimental. El valor por defecto sigue siendo `full`; **el runtime de la aplicación no habilita esta variante**.

**Limitación estructural:** una modificación silenciosa de mensajes antiguos que no emita un evento de invalidación podría dejar el prefijo temporalmente desactualizado; deben validarse las garantías de los eventos reales antes de integrar. Además, `harness.use` es `@internal` y puede cambiar en actualizaciones. La memoria adicional depende de longitud/contenido de mensajes, no solo del contador.

## 4. Protocolo y dos etapas de prueba

`protocol.json` fijó hipótesis, cargas, métricas y umbrales **antes** de correr la línea base.

**A — Baseline anterior al cambio:** GitHub Actions run `43678675627`, job `132704327654`, commit `2b7e3312c7f9b187a030803ca3372ee0f837f994`. Nueve ejecuciones, tres por escenario, todas PASS. Conservadas en `baseline-runs.jsonl`.

**A/B — Comparación emparejada:** GitHub Actions run `43679002928`, job `132705353729`, commit `ad126d0ad6f4d50dcc7568ac2dbbc7359c78679b`. Dieciocho ejecuciones (3 pares por escenario, orden AB/BA), todas PASS. También pasaron pruebas específicas de ausencia de solapamiento e invalidación concurrente. Se preservaron las filas BEGIN y END con los datos de CI en `paired-runs.jsonl`, y los agregados en `summary.json`.

Los ensayos ejecutan la clase **real** `OpenCodeSessionSockets`, incluido el envío de eventos y generación de instantáneas; sustituyen `OpenCodeHarness`, `message.list` y WebSocket por implementaciones deterministas para contabilizar páginas y bytes. No usan Cloudflare remoto, Durable Object real, SQLite real ni modelos. La salida original de GitHub Actions es la fuente primaria; los archivos JSONL se transcribieron **después de la ejecución**, no durante ella.

| Escenario | Llamadas originales | Variante | Ahorro llamadas | Bytes leídos originales | Variante | Ahorro bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Corto: 8 mensajes, 6 eventos | 7 | 7 | 0 % | 16.786 | 16.786 | 0 % |
| Largo: 1.005 mensajes, 10 eventos | 121 | 21 | **82,6 %** | 3.304.796 | 599.846 | **81,8 %** |
| Compactación/reconexión: 230 mensajes, 8 eventos | 19 | 13 | 31,6 % | 286.153 | 169.867 | 40,6 % |

El historial final y todas las instantáneas observadas fueron iguales en las 18 ejecuciones. La variante no ahorra consultas en conversaciones cortas (resultado esperado y aceptable). El costo adicional es mantener un prefijo en memoria, construir un mapa de IDs y consultar una página descendente por evento.

**Tiempo del test (no latencia real):** corto 7,00 vs 6,76 ms; largo 22,32 vs 16,67 ms; compactación 10,13 vs 10,03 ms. Con un runtime local simulado y muestra pequeña, esas diferencias **no demuestran mejora de la latencia real ni CPU en Cloudflare**. Tokens, costo monetario y memoria real quedan **UNKNOWN**.

## 5. Verificación de integridad

Se volvieron a abrir `protocol.json`, `baseline-runs.jsonl`, `paired-runs.jsonl` y `summary.json` desde GitHub tras guardarlos.

- Baseline: 9 inicios, 9 finales, 9 IDs únicos, todos PASS.
- A/B: 18 inicios, 18 finales, 18 IDs únicos, todos PASS.
- Los agregados de `summary.json` coinciden con los valores recalculados desde los finales individuales.
- Las pruebas de la variante pasan incluyendo modificaciones del mensaje reciente, sustitución del historial sin solapamiento, compactación, resync y carrera de invalidación.
- No se reconstruyeron tiempos a partir de medias ni se omitieron fallos.

## 6. Decisión

**Experimento parcialmente validado.** Se demuestra una reducción **sustancial de paginaciones y bytes recuperados dentro del flujo instrumentado** en sesiones largas, sin pérdida en los casos probados. La hipótesis queda apoyada a nivel de mecanismo.

**INCONCLUSIVE** para ahorro de CPU, memoria, latencia de usuario, almacenamiento facturado y costo total de OpenCode Cloud. No existe observación sobre SQLite real ni inferencia. **NO CHANGE** para producción.

Una prueba siguiente razonable es medir `message.list` y el tiempo de actualizaciones dentro de un Durable Object local/aislado utilizando el Harness real; comprobar también el contrato de eventos para cambios históricos silenciosos. Solo entonces discutir integración. **No merece la pena crear una infraestructura permanente de cache o monitoreo** para estos resultados.

## 7. Reproducibilidad

En la rama del experimento:

```sh
bun install --frozen-lockfile
bun test src/history-tail-experiment.test.ts src/experimental-history-tail.test.ts
bun run typecheck
bun run build
```

El ensayo no modifica `main`, PR #54/#55/#56, Producción o Staging. Se mantiene aislado en PR #57, borrador y marcada **NO FUSIONAR**.

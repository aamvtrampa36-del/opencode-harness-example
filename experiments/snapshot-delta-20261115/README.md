# OpenCode Cloud — Experimento 2: transporte incremental de sesiones

**2026-11-15 · Solo experimental · No fusionar, no publicar y no desplegar.**

## Archivo del experimento 1

PR #55 (`experiment/harness-settled-20261115`) se considera **archivada para investigación posterior**. No se ha tocado su rama ni su PR. Su resultado fue una reducción de espera en una simulación del Harness, no una mejora confirmada dentro de Cloudflare.

## Hipótesis y evidencia de código

En `src/sockets.ts` del estado `main` `e2736d1221247b5186879cda3beb9230b4b977f5`:

- `#onEvents` reenvía eventos y solicita una nueva instantánea completa tras eventos como `tool_end`, `tool_start` o `message_end`.
- `#snapshot` siempre invoca `handle.history()` (que pagina el historial), `handle.busy()` y `harness.pending()`.
- `#broadcastSnapshot` reenvía los mensajes completos a cada WebSocket, aun cuando solo haya cambiado el último mensaje.

Esto sugiere tráfico creciente con la longitud del historial multiplicada por la cantidad de eventos. **No demuestra por sí solo el impacto en tiempo de usuario ni tokens.**

Hipótesis H1 congelada antes de medir: transmitir solo el sufijo modificado, conservar instantáneas completas al conectar/resincronizar y recuperar el historial exacto, con ahorro objetivo de 70% de bytes en un flujo largo.

## Modificación ejecutable y reversible

Se implementó en la app real, pero **desactivada por defecto**:

- `src/snapshot-delta.ts`: empaquetado incremental por prefijo JSON exacto. Evita depender de referencias mutables, permite caídas a instantánea completa si el delta no ahorra al menos 15%, y limita la caché de comparación a 2 millones de caracteres.
- `src/sockets.ts`: conserva modo `full` (baseline/producto), ofrece modo experimental `delta` mediante parámetro final opcional de `OpenCodeSessionSockets`. Usa `WeakMap` por WebSocket, no comparte bases entre clientes y reconecta con instantánea completa.
- `src/protocol.ts`: `snapshot_delta` añade `baseLength`, `baseLastId`, `from`, cambios de mensajes y estado ocupado/pendiente.
- `src/use-opencode-session.ts`: aplica cambios sobre el historial sincronizado; si falla la base solicita `resync`, sin mezclar conversaciones incompatibles.
- `src/snapshot-delta-experiment.test.ts`: ejecuta `OpenCodeSessionSockets` y el protocolo reales con un Harness, WebSocket y transcript deterministas. Prueba cambios, compactación, dos conexiones simultáneas, nueva conexión y resincronización.

La aplicación no pasa `snapshotDelivery="delta"` en ninguna ruta operativa; permanece el comportamiento anterior si se ejecutara esta rama sin configuración adicional. **Ninguna versión de este código se desplegó en Cloudflare.**

## Resultados observados

GitHub Actions `43677519991`, job `132700797679`, código ensayado en commit `653256c6bb2da3e29ce341202282ccb00079fe03`:
- 18 ejecuciones: 3 pares A/B por escenario, orden alternado, 18 BEGIN y 18 END, 0 fallos.
- Comparación por mensajes serializados y WebSocket transmitidos realmente por los métodos de la app; Harness artificial determinista (sin inferencia ni DO real).
- El historial final reconstruido coincide por contenido y orden en cada caso.

| Caso | Base (bytes) | Delta (bytes) | Reducción |
|---|---:|---:|---:|
| 6 mensajes y 4 eventos | 14.793 | 5.685 | 61,57 % |
| 160 mensajes y 25 eventos de herramienta | 6.113.570 | 281.145 | **95,40 %** |
| 24 mensajes, 8 eventos y compactación | 63.553 | 17.957 | 71,74 % |

**No se redujo el número de lecturas del historial:** base y variante mantienen respectivamente 5, 26 y 9 lecturas por ejecución. El cálculo JSON de diferencias añade trabajo local, aunque el ensayo no demostró una penalización de tiempo inequívoca.

**No se midió ni se demostró:** reducción de tokens, precio de inferencia, tiempo para completar una tarea real, memoria de Durable Objects, comportamiento del navegador Android con carga real, latencia de red real ni compatibilidad con todas las clases de eventos.

Por tanto:
- **Resultado de transporte WebSocket en los escenarios ejecutados: mejora observada**.
- **Resultado de rendimiento/costo total en tareas reales: INCONCLUSIVE**.
- **Decisión sobre integración: NO CHANGE; candidata aislada, sin autorización ni necesidad de fusionar.**

## Evidencia recuperable

- `protocol.json`: hipótesis y umbrales fijados **antes** de la primera comparación.
- `runs.jsonl`: registro de los 18 pares BEGIN/END transcrito **después** del job desde su salida original en GitHub Actions. No se afirma que el archivo se creara en tiempo real durante las pruebas: la salida de CI es la evidencia original.
- `summary.json`: resultados por caso y procedencia. El registro fue releído del repositorio: 18 comienzos, 18 finales, 18 IDs únicos, todos PASS, y las medias coinciden.

Reproducir en la rama con `bun test src/snapshot-delta-experiment.test.ts`, `bun run typecheck` y `bun run build`.

## Evaluación del beneficio y siguiente cuello

La reducción de bytes es relevante para conversaciones largas y teléfonos con red limitada. La causa es estructural: el protocolo enviaba repetidamente el mismo historial. Sin embargo, las lecturas completas de `handle.history()` siguen ocurriendo, por lo que **el siguiente posible cuello** sería la consulta/paginación repetida del historial desde el Harness. No intervenir sin medir qué proporción del tiempo real ocupa.

No añadir nueva infraestructura. No intervenir sobre contexto del modelo ni caché del proveedor basándose únicamente en este ensayo de transporte. Para decidir sobre integración haría falta una prueba aislada con Durable Object, agente real o carga representativa, y una comparación de tiempo/CPU/bytes sin regresión.

## Estado y aislamiento

Rama `experiment/session-snapshot-delta-20261115`; PR #56 en borrador y etiquetada para no fusionar. No se tocaron `main`, las PR #54/#55, Producción ni Staging. Solo hubo llamadas de lectura a Cloudflare para comprobar los identificadores de despliegue. No hay nuevas dependencias ni Workers nuevos.

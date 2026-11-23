# F0-C10/T10 — Prueba reproducible de diez ejecuciones simultáneas

**Corte:** 2026-11-22, America/Sao_Paulo. **Actor:** ChatGPT (instrumento desarrollado offline; no mediante OpenCode Remote). **Estado:** validación del harness local; NO se ejecutó un E2E real de diez tareas en Staging. **Referencia:** [F0-C10 plan](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), issue #90 y PR #91, #94, #106, #108–#113. **Base Staging observada:** staging/opencode-g1-rpc-safe-20261120 @ 11161dd6f2c4b5237a2da59d7275ff693e0afdbe. Revalidar en encargo T11.

## 1. Objetivo y contrato de aceptación

F0-C10 no significa diez HTTP 200 ni diez sesiones busy. Significa **diez solicitudes independientes, admitidas, persistidas, ejecutándose realmente durante una ventana común, y finalmente con diez respuestas comprobadas**. El caso RED de [issue #90, 22-11-2026](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558) presentó **0/10 resultados verificados**, seis respuestas de inicio OOM, dos operaciones not_found y cuatro solicitudes preparing canceladas. El fixture historical-red modela el **perfil** del incidente, no reproduce un transcript original ni atribuye causa raíz. El instrumento debe rechazarlo.

Para cada ID: received → admitted → persisted → [queued] → execution_start → tool/inference start → tool/inference end → output → completed. Queued y busy no contribuyen a actividad; completed y verified=true no sustituyen la validación de artefactos. Una sesión puede permanecer en cola o no existir pese a una respuesta HTTP del cliente.

## 2. Reutilización y arquitectura de prueba

Inventario revisado en GitHub: scripts/selftest.mjs, scripts/test-preview.mjs, scripts/check-invariants.mjs, scripts/test-staging-mobile.mjs, scripts/test-staging-control-mcp.mjs, src/staging-control-mcp/server.test.ts, .github/workflows/ci.yml y la CI de móvil. El CI Stage histórico ejecuta Bun test, typecheck, build, preview e invariantes; no certifica concurrencia real. No ejecutar selftest a ciegas porque puede tener efectos y no debe implicar costos no autorizados.

Comparables consultados: [SWE-agent trajectories](https://swe-agent.com/latest/usage/trajectories/) preserva acciones y observaciones; [OpenHands benchmarks](https://github.com/OpenHands/benchmarks) separa los runners de los informes; [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) trata ciclos de vida y sandbox; [DeepSeek Harness subprocess](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subprocess.md) documenta ejecución de procesos y terminación. Se reutilizaron criterios, no se copiaron fuentes ni se introdujo otro ejecutor. El bash-local de DeepSeek no proporciona aislamiento de sandbox por sí solo.

Archivos implementados:
- scripts/f0-c10/tasks.mjs: diez entradas y oráculos; hash real de bytes UTF-8.
- scripts/f0-c10/mock.mjs: proveedor falso con demoras, ejecución concurrente simulada, estados y fallos.
- scripts/f0-c10/evaluate.mjs: aceptación fail-closed y cálculo de solapamiento temporal mediante intervalos de herramienta/inferencia; distingue modo offline de live.
- scripts/f0-c10/evaluate.test.mjs: 26 tests RED/GREEN.
- scripts/f0-c10/run-offline.mjs: CLI ejecutable y matriz de fallos.
- .github/workflows/f0-c10-offline.yml: prueba aislada sin secretos, inferencia ni llamadas a Staging.

Usa Node >=20 sin paquetes externos, proveedores ni credenciales. Ejecutar desde raíz:

    node --test scripts/f0-c10/evaluate.test.mjs
    node scripts/f0-c10/run-offline.mjs --suite --out f0-c10-offline-evidence.json
    node scripts/f0-c10/run-offline.mjs --size 10 --fault historical-red
    node scripts/f0-c10/run-offline.mjs --size 10 --fault false-pass

El último par **debe salir con código 1**; el modo --suite sale 0 solo si los GREEN pasan y **todos** los RED fallan. La salida JSON está limitada a fixtures no sensibles; no contiene tokens ni transcripciones. Resultado de validación local T10: **24/24 tests y 16/16 escenarios originales de suite correctos**, antes de la auditoría de lectura independiente. La rama de auditoría agrega dos tests y dos negativos; el resultado de CI de estos cambios debe verificarse en el HEAD de la PR.. En mock hubo solapamiento de aproximadamente 130 ms para diez herramientas simuladas; no representa rendimiento real de OpenCode.

## 3. Diez tareas sintéticas descartables

| # | Caso | Validación independiente |
|---|---|---|
| 1 | SHA-256 de cadena local | digest exacto en UTF-8 |
| 2 | JS y Unicode | longitud UTF-16, code points, transformación |
| 3 | CSV | 4 filas; total 19, A=12, B=7 |
| 4 | JSON válido e inválido | dos resultados booleanos |
| 5 | Logs sintéticos | INFO=2, WARN=1, ERROR=2 |
| 6 | HTML | main + h1 + button con aria-label, sin script |
| 7 | TDD | salida límite=256, recibos RED exit=1 / GREEN exit=0 |
| 8 | Config | precedencia override: timeout=5000, retries=2, featureX=false |
| 9 | DAG | orden topológico, ciclo detectado |
| 10 | Pipeline | 3 filas, total=18 y hash de reporte |

Cada entrada tiene requestId hexadecimal único (exactamente 16 caracteres), sessionId, operationId, projectId y executorId distintos; output en ruta efímera tmp/f0-c10/[requestId]/[kind].json. El hash debe coincidir con los bytes recuperados y el oráculo estructural; tamaño máximo 8192 bytes. Comprobar lectura separada, no solo salida del modelo. Los diez casos no requieren escritura real a GitHub, redes ni cambios del runtime.

## 4. Matriz RED/GREEN ejecutada offline

| Fixture | Esperado |
|---|---|
| Escalones 1→2→4→10 | GREEN |
| historical-red: 6 OOM, 2 not_found, 4 cancelaciones (perfil abstracto) | RED |
| oom | RED |
| partial (persistencia omitida pese a completed) | RED |
| orphan (status not_found) | RED |
| false-pass (verified=true con contenido incorrecto) | RED |
| queued-only (diez recibidos, solo cuatro con intervalos) | RED |
| cross-project | RED |
| duplicate-request | RED |
| client-only/busy-only | RED |
| cancelled inesperado | RED |\n| missing-readback; corrupt-readback | RED: el artefacto afirmado no basta si no se recuperan bytes idénticos |
| restart-recovered, ids duraderos reconciliados | GREEN de simulador |
| retry 429 con mismo requestId, una vez | GREEN de simulador |
| TDD sin evidencia RED; output ausente; status fuera de actividad; campaña duplicada; forged live sin telemetría | RED |

Estas pruebas verifican la capacidad del **observador** para rechazar evidencia mala; no prueban reinicio, cancelación ni supervivencia del Durable Object auténtico. Los experimentos reales necesitan nuevos permisos específicos.

## 5. Evidencia temporal y correlación

Evento mínimo: type, seq, atMs, requestId, sessionId, operationId, projectId, executorId y source. Para un intervalo: callId, toolName, exitCode y pares start/end emitidos por el runtime. Output: kind, content, projectId, path, sha256; readback: bytes completos recuperados por un colector separado, misma ruta, proyecto, SHA y oráculo. Un evento output autoemitido nunca prueba descarga. En modo live, el validador exige source=runtime para eventos de ejecución y source=artifact-collector para el evento separado de lectura de bytes; también exige metadata de SHA/base/deployment y clockSyncMaxSkewMs <=250, un query ID de Cloudflare, lease con fencing token y telemetría independiente. Una traza mock renombrada live debe fallar.

Medir máximo de tareas con intervalos tool/inference realmente abiertos y duración de la intersección de las diez. Los HTTP iniciados, el campo busy, una cola, las llamadas al proveedor aún no iniciadas y la mera existencia de operaciones no cuentan. La lectura de estado bajo carga se registra con su latencia y debe estar temporalmente dentro del intervalo de una herramienta. Las métricas del isolate en Cloudflare pueden sumar varios Durable Objects: nunca adjudicar la memoria compartida a una sola sesión. Ver [límites Worker](https://developers.cloudflare.com/workers/platform/limits/) y [métricas DO](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).

El Remote actual expone start/status/progress, pero su secuencia de eventos por sí sola **no acredita** intervalos reales de inferencia o ejecución. Las marcas `source` del JSON no son firmas criptográficas: T11 debe autenticar la procedencia del colector y los recibos contra Cloudflare o un registro verificable externo antes de considerar confiable cualquier traza live. Para T11 hace falta un colector runtime independiente y verificado; no sintetizar intervalos de busy ni inventar timestamps.

## 6. Umbrales fijados antes de medir

| Métrica | Límite live |
|---|---|
| Solapamiento | 10 tareas independientes activas, intersección >=1000 ms |
| Rondas | **3** completas, experimentId diferente, 10/10 resultados válidos en cada una |
| Integridad | 0 outputs mezclados, 0 operaciones huérfanas, 0 OOM |
| Memoria | <=102.4 MiB (80% de 128 MiB por isolate), observación durante solapamiento, 0 resets |
| Latencia | p95 admisión <=10 s, status bajo carga <=5 s, duración por tarea <=180 s |
| Retries | <=1 por tarea, requestId estable, sin doble efecto |
| Errores | 0 fallos definitivos imprevistos; transitorios recuperados con límites |
| Bytes de output | <=8192 y checksum/verificación independiente |
| Coste | maxCostUsd=null: **no iniciar live** hasta cap real verificado |

El costo total incluye tokens por proveedor/modelo real, Workers/DO, Container CPU/memoria/disco, observabilidad/egreso, CI y reintentos. No asumir economy=gratis ni un límite en USD escrito en documento como control operativo. Confirmar control y corte **real** por proveedor antes de fijar un importe para T11. El umbral no se ajusta después de una corrida fallida para convertirla en PASS.

## 7. Procedimiento E2E para el futuro encargo T11 (NO ejecutado aquí)

1. Reconstruir estado exacto: HEAD del repositorio, base, PR/CI de cambios, SHA fuente y versiones efectivamente desplegadas de opencode-g1-staging y opencode-staging-control-mcp; comparar contratos, assets, bindings, DO, Containers, R2, Workflows. No asumir PR #106 desplegada. Preparar rollback de Worker y recuperación de DO/Container separadas.
2. Obtener exclusión real: lease **atómico** probado ante dos aspirantes, fencing token, owner y TTL; status=ok o una rama no son locks. No realizar acciones si el lease falla o hay trabajo ambiguo.
3. Revalidar modelos y proveedor, rate limits, posibilidad de diez tareas activas y **medición/corte efectivo de gasto** de todos los recursos. Pre-registrar monto máximo y alertas; sin ello STOP.
4. Instrumentar en el propio runtime los pares tool/inference start/end, exit codes, ID del Container, proyecto/sesión/operación, timestamps confiables, progreso duradero y recuperar artefactos por bytes. Validar reloj, procedencia, observabilidad Cloudflare con query ID y correlación a deployment. Evitar transcripciones completas y lecturas enormes.
5. Con permiso específico de campaña **distinto de T10**, ejecutar escalones 1→2→4→10. Registrar requestId antes de cada inicio y NO usar otro ID para repetir tras timeout; reconciliar status/progress con el mismo ID. Hacer lecturas bajo carga, pruebas de recuperación, cancelación focalizada y permisos negativos. Verificar los diez outputs.
6. Tras gates de escalones, efectuar **tres rondas independientes** con diez tareas realmente solapadas y sin fallos; conservar JSON de trazas, source SHA/deployment, Cloudflare memoria/CPU/errores, costes, outputs, checksums, huérfanos, cancelaciones y tiempos. Ejecutar evaluateCampaign sobre trazas live válidas, con cap preregistrado; no usar mock para aceptar.
7. Parar ante OOM, lease no válido, id/operación incierta, mezcla de proyectos, límite de costo no demostrable, pérdida de sincronía, salida o retries no acotados, despliegue divergente o permisos insuficientes. No hacer merge, despliegues ni rollback automático en este encargo.

**Estado final del instrumento:** PASS solo cuando implementación, CI del HEAD y negativos estén verdes. **Estado F0-C10:** NOT VERIFIED hasta E2E autenticado y auditoría independiente de G-C10-A/B/C/D/E. Ni tres rondas simuladas ni CI verde equivalen a COMPLETE PASS.

**Handoff T11:** requiere autorización específica de prueba real, lease atómico, instrumento de telemetría genuina, candidato Stage/versiones SHA, medidor/corte de gasto, límites de proveedor y Containers, permisos y rollback independientes, integración de outputs e infraestructura estable. Cero inicios masivos autorizados por esta documentación.

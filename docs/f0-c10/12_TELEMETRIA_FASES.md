# F0-C10/R3 — Instrumentación segura por fase (T01, coordinación T02/T05)

**Estado:** PARTIAL / SOURCE_INSTRUMENTED / LIVE_MEMORY_NOT_MEASURED / NO DEPLOY.
**Actor:** ChatGPT, mediante GitHub autorizado. No OpenCode Remote ejecutor, no consumo nuevo de inferencia ni acceso a sesiones/historias privadas.
**Base:** PR [#129](../../pull/129) draft @ `c8afb5302252d7edce18332b602d6d4e72755d58`, apilada sobre PR [#126](../../pull/126) candidata @ `1268ba22f26330d619b046fcf551ca846cb69d0f`. Rama propia `f0-c10/r3-phase-telemetry-t01-t02-t05-20261122`. **No** se ha fusionado #129 ni #126 en Staging. Issue [#90](../../issues/90) sigue abierto.
**Propósito concreto:** hacer observable el orden y duración de etapas potencialmente costosas sin inventar bytes de heap ni alterar decisiones de permisos, gasto, sesiones y recuperación. Es preparación para un E2E futuro autorizado, **no un E2E**.

## 1. Qué se añadió

Se creó `src/supervisor-phase-telemetry.ts`: función `createSupervisorPhaseProbe()`, que emite a `console.info` un marcador `supervisor.phase.v1` **antes** de entrar en una llamada peligrosa y **después** de terminarla o lanzar una excepción. El texto es una etiqueta fija y un objeto plano de esquema cerrado:

```json
{"marker":"supervisor.phase.v1","probe":"<UUID efímero aleatorio>","phase":"create/fork","operation":"create","edge":"begin"}
{"marker":"supervisor.phase.v1","probe":"<mismo UUID>","phase":"create/fork","operation":"create","edge":"end","outcome":"ok","durationMs":19}
```

El UUID solo relaciona subetapas **dentro de la misma petición RPC**. No es `requestId`, `sessionId`, un identificador estable del usuario ni un token de recuperación. Campos únicos permitidos: `marker`, `probe`, `phase`, `operation`, `edge`, `outcome`, `durationMs`. `phase/operation/outcome` proceden de un catálogo cerrado; `durationMs` es entero truncado a 0–600.000 ms. La emisión no incluye excepción, stack, prompt, respuestas del modelo, credenciales, nombres de proyecto, ID de tarea ni histogramas crudos. El error original se relanza sin sustituirlo. Si `console.info` falla, la tarea no cambia de resultado. No hay escritura de este instrumento en SQLite, R2 o Containers.

**No se registra `process.memoryUsage()` en el Worker**: no es un contador API de `workerd`, y `durationMs` no es `heapUsed`. No leer histories para medir histories. Si aparece `begin` sin `end`, significa «cierre no observado»; también puede deberse a pérdida/muestreo de logs, cancelación, timeout o reset, por lo que **NO** identifica por sí solo el allocator del OOM.

## 2. Mapa de fases y cobertura real

Se editaron únicamente las llamadas siguientes dentro de `src/server.ts`. Las acciones se ejecutan tal como antes; la envoltura observa sin transformar retornos ni reintentar errores:

| Fase | Operaciones observadas | Proceso real y límite |
|---|---|---|
| `admit` | `validate`, `fingerprint`, `reserve`, `branch` | validación/política de repos, huella, transacción de reserva, GitHub `ensureSupervisorBranch`. No implica nuevo límite global de capacidad |
| `create/fork` | `sourceLookup`, `create` **o** `fork`, `scope` | `sessions.list()` solo para fork (potencial materialización); creación/fork SDK y vinculación de scope; si se pierde receipt, journal conservador #120 sigue aplicando |
| `setModel` | `configure` | `setAgent("build")` y `setModel` agrupados; **no** separa aún coste de `setAgent` frente a `setModel` ni mide memoria de proveedor |
| `submit` | `dispatch` | `handle.submit` del inicio; UUID efímero de marcadores no reemplaza `operationId` durable |
| `status` | `wait`, `busy`, `foldLog`, `progress` | polling `wait` con 120ms abort, `busy`, fold de hasta 256 eventos, proyección MCP de #114 de hasta 128 eventos de entrada; sin `history()` |
| `recover` | `legacyBusy`, `resumeReceipt` | dos ramas existentes de reconciliación, **no** todas las rutas del SDK ni reconciliación global |
| `alarm` | **sin marcador nuevo** | `OpenCodeAgent` no tiene `onAlarm()` visible que pueda envolverse sin alterar internals del SDK. Eventos de alarma ya visibles en Cloudflare; no se declara métrica inexistente |

La integración preserva las contenciones `SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED` de PR #106 y `projectSupervisorProgress` de PR #114. **T05** debe inspeccionar el tamaño de los eventos *antes* de que sean entregados por SDK (el límite de objetos proyectados no limita el tamaño de un objeto entrante). `exportSessionData()` fuera del supervisor aún serializa historia entera; no se invoca ni se intenta repararlo por este lote.

### Invariantes de seguridad

- Sin modificaciones de `main`, Producción, claves, bindings, nombres de Durable Objects, migraciones, políticas de autorización, locks, gasto, flujos de GitHub o almacenamiento de sesiones.
- Los markers son **opt-in solo de código candidato**: al no haber deploy, no aparecen en el activo #374 por este trabajo.
- La instrumentación **no es un kill switch**, no impide nuevos OOM y aumenta en alguna medida los logs/CPU, coste no cuantificado. No deberá publicarse sin revisar retención y volumen de logs.

## 3. Pruebas y CI que deben aceptarse

`src/supervisor-phase-telemetry.test.ts`: tests sobre emisión ordenada, retorno idéntico, propagación de excepción con texto secreto no registrado, emitter que falla, rechazo de operaciones inválidas sin ejecutar callback, `begin` previo a promesa pendiente y duración acotada. Los casos son RED/GREEN de **semántica e higiene de telemetría**, no pruebas de memoria de workerd.

`.github/workflows/f0-c10-r3-phase-telemetry.yml`: ejecución de solo código, disparada por `push` de la rama R3 y PR hacia rama R2, con `contents:read`, timeout 10 minutos y ninguna credencial de Cloudflare. Pasos:

```sh
bun install --frozen-lockfile
bun test src/supervisor-phase-telemetry.test.ts
bun test
bun run typecheck
bun run build
bun scripts/check-invariants.mjs
node --test scripts/f0-c10/phase-memory-profile.test.mjs
```

No se ejecutan `wrangler deploy`, `staging_start_task`, `staging_agent_check`, simulación de Container real, herramientas con efectos de Remote ni tests de carga. Registrar posteriormente run, job, HEAD, estados y exit codes; no asumir éxito del HEAD final por un run previo.

Los fixtures R2 anteriores del PR #129 (seis sesiones sintéticas, RED/Green local) no son evidencia de bytes reales de V8. La CI del HEAD #126 y la CI de R3 son pruebas de distinto alcance.

## 4. Procedimiento real de correlación futuro (NO EJECUTADO)

Una vez aprobados **lote operativo separado**, lease exclusivo con fencing, saldo y **corte de coste efectivo**, despliegue versionado/rollback de ambos Workers y protección de datos:

1. Consultar deployment y **SHA de binario** activo tanto de `opencode-g1-staging` como `opencode-staging-control-mcp`. No interpretar un CI verde como deploy ni atribuir nuevos markers al antiguo #374.
2. Consultar Workers Observability con filtros por service, evento `supervisor.phase.v1`, versión y ventana UTC exacta. Agrupar **dentro de una petición** por `probe` y `edge`: observar primer `begin` sin `end`, latencia por etapa, fallos; anotar pérdida de logs/muestreo. No exportar prompts ni histories.
3. Correlacionar con los eventos de `exceededMemory` por versión, request trace y DO. Un `begin` inmediato anterior no determina culpabilidad: distinguir threads, awaits superpuestos y otros objetos en el isolate. Usar Cloudflare Memory Usage `durableObjectsPeriodicGroups.quantiles.memoryUsageBytesP50..P999` y marcar que los percentiles son **por isolate** incluso filtrados por DO ID.
4. Medir por separado estado de Container (RAM/RSS observada mediante su mecanismo de métricas autorizado), tamaño de respuesta MCP **antes y después** de sanitizar y telemetría de V8 por isolate. No sumar ni restar estas tres cifras como si procedieran del mismo espacio de memoria. La respuesta MCP transmitida no demuestra que no hubiese materialización previa.
5. Si una fase queda candidata causal, realizar aislamiento controlado **1 → 2 → 4** y solo después 10, con test de seguridad/rollback y gasto limitado. Registrar el **resultado verificado** de cada operación (inicio, herramienta, exit code, output real) y cambios de memoria; en fallo detener. Para confirmar referencias retenidas usar heap profile **solo en entorno aislado y aprobado**: pueden contener secretos y datos de conversación.

No existe confirmación de lease global ni de gasto máximo con corte técnico, por lo que **todos esos pasos de runtime están BLOCKED** en esta tarea. Ninguna lectura segura de estado convierte un trigger pagado en autorizado.

## 5. Coordinación explícita

**T02 (memoria/DO):** [02_DURABLE_OBJECTS.md](02_DURABLE_OBJECTS.md). Prioridad de muestras: `create/fork:sourceLookup` (materialización de índice), `create/fork:create/fork` (SDK), `setModel:configure` y `submit:dispatch`. Comparar traza de único DO con P50/P99/P999 isolate, no asumir 128 MB por DO. Si el heap sube sin respuesta final, estudiar referencias a sesiones y callbacks en `OpenCodeHarness`, solo con perfil autorizado. No cambiar routing ni migración v4.

**T05 (Remote/MCP):** [05_REMOTE_MCP.md](05_REMOTE_MCP.md). Prioridad: `status:wait`, `status:foldLog`, `status:progress`; mantener los límites de #114 y la guarda #106. Investigar separadamente `runConnector(event.transcript)` y `jsonText`, donde recortar salida tras serializar no acota allocations. **No usar transcript real de usuario para benchmark**.

**T04 (recuperación):** marcador `recover:resumeReceipt` solo mide lectura del registro y `recover:legacyBusy` el probe heredado. No implica evidencia de alarma ni recuperación del SDK; `unknown` se conserva si faltó una confirmación.

**T10 (aceptación):** el test de diez requiere diez intervalos de trabajo real solapado, diez resultados auténticos y tres rondas sin OOM, huérfanos ni cruces de sesiones. No elevar el fixture sintético ni este marcador a gate integral.

Documentos de referencia: [PR #129](../../pull/129), [#126](../../pull/126), [#114](../../pull/114), [#106](../../pull/106), [issue #90](../../issues/90), Cloudflare [DO Memory Usage](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/#memory-usage) y [Workers memory limits](https://developers.cloudflare.com/workers/platform/limits/#memory).

## 6. Cierre y reversión

**RESULTADO:** `PARTIAL`; instrumentación incorporada al código candidato en rama privada, **no instalada en runtime**.
**EVIDENCIA:** ver la PR draft R3 y CI del HEAD. Pruebas comprueban que no sale información sensible por marcadores y que el código base compila; sin inferencia nueva.
**BLOQUEANTE:** no existe perfil de memoria por fase del isolate/SDK desplegado ni test E2E autenticado; lease/corte de gasto, carga y despliegue deben aprobarse fuera de esta PR.
**PRÓXIMA ACCIÓN:** auditoría T02/T05 del diff R3 y plan operativo/telemetría de isolate; ejecución real solo tras garantías de presupuesto, exclusividad y autorización de despliegue/carga. Revertir el cambio fuente elimina logging de instrumentación, **no revierte estado de DO ni Containers**.

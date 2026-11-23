# F0-C10/T05 — Remote/MCP sin lecturas de historial ilimitadas

**Fecha:** 2026-11-22 (America/Sao_Paulo)  
**Actor:** ChatGPT (código y análisis locales); **OpenCode Remote solo lectura**.  
**Entorno:** rama `f0-c10/t05-20261122`, base Staging `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`. **Sin merge, deploy ni inferencia.**  
**Issue:** [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).  
**PR relevantes:** [#91](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/91), [#94](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/94), [#102](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/102), [#106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106), [#112](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/112), [#113](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/113).

## Resultado y criterio de aceptación

**PARTIAL.** Se identifica un defecto reproducible en la lectura incremental de `progress`: la implementación anterior excluye los eventos de `reasoning` **antes** de contabilizar el límite de 100 entradas y **antes** de avanzar `nextAfter`. Un log que contenga solo estos eventos se recorre entero en cada consulta; el cliente vuelve a empezar en el mismo cursor. El helper nuevo aplica límites antes de materializar listas y mantiene el cursor de cada evento duradero consumido.

No se ha demostrado todavía que el runtime soporte diez tareas activas simultáneas ni se ha medido la memoria real de un isolate. El OOM de #90 no tiene una única causa raíz establecida. El 22-11-2026 hubo **diez solicitudes concurrentes pero cero tareas completadas y verificadas**; esto no equivale a diez ejecuciones efectivamente solapadas.

## Estado verificable de código y despliegues

Lecturas Cloudflare del 22-11-2026:
- `opencode-g1-staging` **#374**: versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, 100 %.
- `opencode-staging-control-mcp` **#19**: versión `196240c0-1052-47b3-aaa7-02cf5baa87f0`, deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, 100 %.
- Estas versiones corresponden a la fuente histórica `74632f75db010223cc90d99ba4a801ce0e6414e5` según #112/#113, **no** a la contención candidata #106 `19bba24d81be5b0673acbf2a56b500aed4fa0b66`. La atribución source→bundle debe revalidarse al integrar.
- Lectura Remote: `status=ok`, supervisor `ready=true`, esquema `opencode.staging-control.v2`, `supervisedSessions=96`, `supervisedCountComplete=false`, `supervisedCountAtLeast=96`: **un mínimo, no un total ni 96 activos**.

## Inventario de contratos reales y efectos

| API / ruta de implementación | Entrada y salida observada en código | Costo/riesgo y semántica |
|---|---|---|
| `staging_status` / `remoteSupervisorStatus` | Sin argumentos; salud, esquema, índice de sesiones supervisadas | `storage.list(prefix,limit:101)`, sin `sessions.list()`; total parcial explícito |
| `staging_sessions` / `remoteSupervisorSessions` | `workspace?`; hasta 100 índices y `busyVerified` | `storage.list(limit:101)`, probes `busy()` hasta cuatro concurrentes; scope `SUPERVISED_INDEX_ONLY` |
| `staging_task_status` / `supervisedTaskStatus` | `id`, `workspace?`; operación, estado, contadores, `toolCountsComplete` | `wait(operationId)` con abort de 120 ms, `busy()`, hasta 256 eventos de `log()`, transacción/cambio de estado posible; **no es lectura sin efectos de storage**; `passed:false` y `verified:false` |
| `staging_task_progress` / `remoteSupervisorProgress` | `id`, `workspace?`, `after`; `events[{seq,type}]`, `nextAfter`, `truncated` | En base antigua devuelve 100 eventos visibles pero NO acota filas crudas filtradas; este encargo introduce proyección acotada |
| `staging_session_inspect` / `remoteSupervisorInspectSession` | `session`, `workspace?`; excerpt final | **Base desplegada:** `sessions.list()`, `history()`, render completo y `slice(-12000)` tardío. **PR #106:** rechaza antes de la carga |
| `remoteSupervisorInspect` | `id` y salida con status/progress/transcript | **Base:** `supervisedTaskStatus` más `supervisedTaskTranscript` y `remoteSupervisorProgress(0)`; caro y no acotado. **PR #106:** snapshot durable sin `wait()/history()` |
| `staging_task_transcript` / `supervisedTaskTranscript` | `id`; formato de mensajes exportados | **Base:** `exportSessionData()` hace `sessions.list()` + `history()` + `JSON.stringify()`; MCP recién después `messages.slice(-20)`. **PR #106:** error temprano `SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED`, no paginación |
| `staging_task_continue` / `remoteSupervisorContinue` | `id`, `turnId`, `prompt`; `operationId`, recepción y reúso | **Mutación con efectos**, reserva durable `supervisor:turn`, hash, `submit(...whenBusy:"steer")`; idempotencia por `turnId`, no usar para lectura |
| `staging_cancel_task` / `cancelSupervisedTask` | `id`; `status`, `confirmed`, `abortAccepted` | **Mutación:** almacena `cancel_requested`, ejecuta `abort(operationId)` y consulta status. `confirmed` solo ante cancelación comprobada |
| `/api/session/export` y `/api/supervisor/v1/tasks/{id}/transcript` | Descarga/exportación | Exportación general aún materializa historial completo en #106; fuera del parche T05 |

**Regla de interpretación:** `received` ≠ `admitted` ≠ `running` ≠ `finished` ≠ `passed/verified`. `operationAnswerAvailable`, `busy`, `toolCalls` o `countComplete` falsos/desconocidos no certifican un resultado. Mantener `passed:false`, `verified:false` hasta verificación externa explícita. Un `gapDetected` exige reconciliar el historial, no saltar a PASS.

## Contrato de progreso propuesto (parche de este encargo)

La herramienta MCP existente **mantiene nombre e inputs** `staging_task_progress({id, workspace?, after?})`, con `after` como entero seguro no negativo (default 0). El RPC principal mantiene `remoteSupervisorProgress(id,after)`. No se requiere cambiar el Worker MCP para consumir propiedades adicionales.

Ejemplo esquemático de respuesta (valores ilustrativos, no lectura live):

```json
{
  "taskId": "0123456789abcdef",
  "session": "ses_example",
  "status": "running",
  "events": [{"seq": 52, "type": "session.tool.called"}],
  "nextAfter": 53,
  "truncated": true,
  "scanned": 64,
  "skipped": 63,
  "duplicates": 0,
  "projectedBytes": 50,
  "gapDetected": false,
  "scanBudget": 128,
  "projectedEventBudget": 64,
  "byteBudget": 8192,
  "processingBudgetMs": 50
}
```

**Topes por llamada:** 128 registros crudos del AsyncIterable, 64 eventos devueltos, 8192 bytes proyectados para eventos y 50 ms de plazo de iteración observado; este último **no** corta una llamada SDK `next()` que quede bloqueada. El cuerpo completo del RPC añade metadatos por encima del byteBudget. Como máximo diez consultas simultáneas procesarían **1280 eventos fuente** y producirían **640 eventos proyectados / 80 KiB de proyecciones** bajo estos topes, sin inferir memoria real de SDK ni garantizar scheduler paralelo.

Se contabilizan también eventos filtrados por razonamiento: consumen presupuesto y **avanzan cursor**. Un evento que no cabe en bytes **no** adelanta cursor; se reintenta desde el mismo `after`. Un seq duplicado no se reproduce. Salto detectado en `seq` implica `gapDetected:true`. Un límite alcanzado marca `truncated:true` incluso si el log termina justamente allí: puede producir página adicional vacía, nunca afirmar completitud falsa. El cliente guarda `nextAfter` por `(workspace,taskId)`; no comparte cursores entre tareas.

**Límite fundamental:** `session.log()` puede construir cada evento con un payload grande **antes** de cederlo al iterador. Este parche no garantiza un límite de bytes de **cada evento crudo** ni CPU de una llamada SDK bloqueada. Exigir prueba específica o API SDK con proyección de solo `seq/type` antes de afirmar protección fuerte frente a datos maliciosamente grandes.

## Opciones comparadas

1. **Cursor sobre log duradero (adoptado para progreso).** Menor diff, reusa `session.log({after,follow:false})`; recuperación por cursor, control de eventos y payload proyectado. No crea servicio nuevo.
2. **Snapshots de progreso persistidos (recomendación siguiente).** Lectura O(1) para salud general, transiciones y contadores; actualizar en transición/evento confirmado, conservar versiones y `complete/asOf`, nunca falsificar conteos parciales. Es más resistente a polling de diez sesiones, pero requiere revisar eventos y escrituras.
3. **Paginación durable de transcript con `taskId` + `after` o cursor opaco ligado al workspace.** Preferible para recuperar contenido histórico completo o últimas N páginas. Necesita índice `seq` y límites de bytes *antes de leer*; no simular con `history().slice(-N)`. Respetar sesiones heredadas y devolver `PAGINATION_UNAVAILABLE_LEGACY` si no hay índice sin inventar resultados.
4. **Streaming acotado (SSE/WebSocket/MCP notifications).** Adecuado para seguimiento en vivo; requiere backpressure, heartbeats, desconexión y reanudación desde cursor durable. Nunca usar la conexión como única prueba de persistencia.

Patrones públicos consultados: [MCP 2026-07-28 paginación y `nextCursor`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx), [MCP resources/list](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/resources.mdx), [OpenHands Agent Server event_service.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/event_service.py) (eventos duraderos y push), [OpenHands event search paginado](https://github.com/OpenHands/software-agent-sdk/issues/2623) y [límites DO Cloudflare](https://developers.cloudflare.com/durable-objects/platform/limits/). **Análisis de patrones, sin copiar código ni añadir dependencias.** La paginación de `tools/list` del protocolo MCP no pagina automáticamente el resultado arbitrario de una herramienta `tools/call`; el API de progreso requiere su contrato propio.

## RED / GREEN, cobertura y límites de prueba

**RED sintético local** (Node 22, sin Cloudflare/SDK): implementación histórica equivalente procesó 10 000 filas `session.reasoning.delta`, devolvió `nextAfter=0`; test con umbral 128 dio **exit 1, 0 pass / 1 fail**. No es prueba de un OOM real.

**GREEN prototipo local**: `node --experimental-strip-types --test supervisor-progress.node.test.mjs`, **exit 0, 8/8 pass**. Casos: log grande filtrado; cursor tras reinicio; duplicados; secuencias omitidas; cursor/filas malformados; bytes; diez lectores intercalados; evento que no cabe no se pierde. Los tests de repositorio `src/supervisor-progress.test.ts` verifican el helper mediante Bun; sus resultados y CI exacto deben leerse por separado (no atribuir éxito previo al HEAD nuevo).

**Alcance del cambio:** `src/supervisor-progress.ts`, `src/supervisor-progress.test.ts`, integración de `remoteSupervisorProgress` en `src/server.ts` y este informe. No modifica endpoints REST legacy, ACL, secretos, bindings, DO schema, Workers publicados ni las sesiones persistidas. Error de secuencia invalida la página y no la convierte en success.

## Compatibilidad y orden de integración futuro

- **Base actual #374 + MCP #19:** siguen con riesgo de transcript completo. No probar `staging_task_transcript` en runtime vivo; evitar `staging_session_inspect` y export general con historial grande.
- **PR #106:** contención complementaria (rechazos tempranos para transcript, inspect, snapshot de inspect). Cambia segmentos distintos de `src/server.ts`; al reconciliar se debe aplicar el guard de #106 **y** este parche de progress, y repetir tests de ambos Workers. La guard no equivale a paginación: la lectura del transcript quedaría temporalmente deshabilitada.
- **MCP #19 y contrato progress ampliado:** `callTask()` serializa el objeto devuelto por el RPC, por lo que los campos nuevos son aditivos. Sus otras llamadas de transcript se mantienen peligrosas hasta que la guard MCP de #106 se publique en un lote separado.
- **Preflight de integración:** revalidar SHA de Staging, diff PR #106, identidad artefactos T02/T03/T04/T05, nombres/bindings de dos Workers, 30 invariantes #110, budget/rollback y CI exacto. Integrar **sin merge o deploy automático** en este encargo.
- **Gate runtime pendiente:** prueba autenticada 1→2→4→10 con lease atómico y límites de gasto demostrados; verificar diez líneas de actividad de ejecución real y diez resultados correlacionados por `requestId/sessionId/operationId`. Las pruebas sintéticas de diez lectores **no** prueban diez agentes activos ni recuperación de DO tras reinicio real.

**No hay reserva exclusiva atómica y corte efectivo de gasto verificados para este encargo:** no se invoca `staging_start_task`, `continue`, `cancel` ni MCP dinámico. No se modifica Staging en vivo.

---

# R2-T05 — Segunda ronda, endurecimiento del contrato (2026-11-22/23)

**Base de esta ronda:** [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126) HEAD histórico y revalidado `1268ba22f26330d619b046fcf551ca846cb69d0f`, tres GitHub Actions en `completed/success`. #126 ya incorpora #106 y #114; **no se modifica la rama de #126**. Autoría de esta rama: **ChatGPT**, no OpenCode. Sin inferencia ni gastos de Staging autorizados.

**Plan:** archivo de proyecto `F0_C10_PLAN_INTEGRAL.md` leído directamente. El path pedido `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md` no aparecen en el tree de #126 (404/listado de directorio); los bloqueos comunes se contrastan con `11_CONSOLIDACION.md` de la misma PR. No se inventa `00_COORDINACION.md`.

## A. Estado Cloudflare y contrato afectado

Lectura GET independiente:
- Principal `opencode-g1-staging`: deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, 100%.
- MCP `opencode-staging-control-mcp`: deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, versión `196240c0-1052-47b3-aaa7-02cf5baa87f0`, 100%.
- `staging_status`: supervisor `ready=true`; 96 sesiones como **cota inferior** (`supervisedCountComplete=false`). Ninguna prueba diez activos.

**No se desplegó** esta rama ni #126. Las correcciones del branch son candidatas offline.

| Camino | Base integrada #126 | R2-T05 |
|---|---|---|
| `staging_task_status`→`supervisedTaskStatus` | `wait(operationId)` acotado con AbortController de 120 ms, `busy()`, `log()` hasta 256, almacenamiento de métricas y posiblemente status; no `history()` directo | Sin alterar esta lógica compartida con T01/T04; `wait()` puede invocar internamente `#messagesAfter` y no tiene cota dura de heap observada |
| `staging_task_progress`→`remoteSupervisorProgress` | 128 eventos fuente, 64 visibles, 8192 bytes proyectados, 50 ms **soft** | Si `seq` salta, `gapDetected=true, truncated=true` y **no adelanta el cursor** más allá del hueco. No confunde progreso con aprobación |
| `remoteSupervisorInspect` | Snapshot durable, `transcriptAvailable=false`, `passed=false`/`verified=false`, no `wait/history` | Conservado |
| `staging_session_inspect` y `staging_task_transcript` | Guardas #106 antes de obtener transcript | Conservadas. Mensajes históricos intactos; no hay paginación de texto completa certificada |
| `exportSessionData` → `/api/session/export` | `sessions.list()`, `history()`, `JSON.stringify` íntegro; el recorte HTTP posterior no limita memoria | Rechaza la ruta heredada antes de esas operaciones; `SESSION_EXPORT_PAGINATION_UNAVAILABLE_LEGACY` (422 REST) y `SESSION_EXPORT_ID_INVALID` cuando corresponda |
| Serialización MCP `result/callTask` | `safeValue(value)` visita todo, `JSON.stringify(safe)` completo, y solo entonces `clipJsonValue`. Además `callTask` expande `{...asRecord()}` | `boundedMcpJsonText` examina como máximo 512 nodos, 64 keys/array, profundidad 10 y cadenas individuales de 4096 caracteres **antes** de serializar; elimina spread completo de resultados de `callTask` |
| `staging_task_continue` y `cancel` | Mutaciones con `turnId`/abort/journal; no son lecturas | Sin cambio, sin invocación viva |

**Límites efectivos del nuevo proyector MCP:** a lo sumo 64 entradas por colección, 512 nodos visitados, 4096 caracteres por valor textual, 32 KiB procesados en conjunto y respuesta final de hasta 16 KiB (hasta 64 KiB si `maxChars` de llamada lo pide). Cadenas enormes se omiten por completo para evitar que un token parcialmente recortado escape a la redacción. Todo recorte se marca `_responseTruncated:true`, `passed:false`, `verified:false`, `status:"unknown"` si había status, y los flags de prueba incluidos pasan a false. Un resultado `isError:true` sigue siendo error, nunca PASS. El límite se aplica a la **proyección de la respuesta ya recibida en MCP**, no a los bytes que el otro Worker tuvo que crear o enviar mediante RPC.

**Caveats de integridad:** no se puede acotar la materialización de **un evento crudo individual** si `session.log()` entrega ya un objeto gigante (8 MiB sintéticos de entrada, salida pequeña); tampoco `await iterator.next()` está preemptado por los 50 ms declarados. No calificar estos topes de protección absoluta de heap. El paso de progreso `gapDetected:true` detiene el cursor pero no recupera por sí solo un evento perdido; requiere reconciliación / diagnóstico.

## B. Paginación de transcript y decisión de compatibilidad

La SDK fijada en `package.json` es `agents@0.33.0`. La documentación oficial de `OpenCodeHarness` documenta `session.log({after,follow:false})` y secuencias durables, pero **no** un contrato estable que permita leer contenido de conversación histórica arbitrario con *proyección de columnas y límite de bytes antes de materializar cada registro*. No confundir paginación de metadatos `seq/type` con una exportación real de mensajes completos.

**Decisión:** NO instalar un falso `transcript page` construido mediante `history().slice` ni exponer una vista de eventos parciales como si fuera transcript. `staging_task_transcript` se mantiene fail-closed (`SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED`); la exportación general histórica ahora falla con `SESSION_EXPORT_PAGINATION_UNAVAILABLE_LEGACY`. Las sesiones persistidas no se alteran ni se migran. Introducir en otro lote, solo si hay API SDK respaldada y pruebas, `transcriptPage(taskId, cursor, maxBytes, maxMessages)` con cursor ligado a workspace/sesión, evidencia de completitud, truncamiento explícito por mensaje y validación de identidad. Un cursor anterior sin índice no produce un éxito vacío, sino error. Coordinación necesaria con T09 para no confundir export de chat con descarga de artefactos de ejecución.

## C. RED/GREEN y compatibilidad

**RED reproducido offline:** `node --test red-baseline.test.mjs` contra la forma de `safeValue(array.map(...))` antigua, con un getter prohibido en el elemento 65 de una lista de 10.000: **exit 1** (`UNBOUNDED_ARRAY_SCAN`). En el código nuevo no se visita ese elemento. Es una prueba estructural de riesgo, no medición de OOM en Cloudflare.

**GREEN candidato:** `src/staging-control-mcp/bounded-response.test.ts` cubre respuestas pequeñas, evento gigante, límite de array, no acceso a campos secretos, redacción, ciclos, fallback fail-closed y diez proyecciones intercaladas. `src/supervisor-progress.test.ts` suma evento individual de 8 MiB, gap inicial, gap tras razonamiento filtrado, duplicados y diez lectores. `src/supervisor-transcript-containment.test.ts` comprueba que export legacy rechaza sin llamar a `sessions.list/history/wait`. **Anotar el resultado real Bun/CI del HEAD R2 tras ejecutarlo; no inferirlo de #126.**

**Compatibilidad bilateral:** el esquema MCP de progreso permanece `id/workspace/after`; la respuesta agrega/informa `gapDetected/truncated`. `callTask` conserva los campos RPC comunes en el objeto raíz y `targetWorker`; al exceder topes devuelve error conservador, no una falsa validación. Ambos Workers deben construirse y probarse juntos en CI, pero **no** publicarse en este lote.

**Conflictos T03/T04/T01:** no se modifica el journal o admisión de `src/server.ts`. El rechazo en `exportSessionData` y la semántica estricta de progreso son hunks independientes. Cualquier intervención sobre `supervisedTaskStatus`/`wait()` requiere atribución y revisión conjunta con T01 y T04; el nuevo gate no toca la sesión / duración de `continue`. **T09** debe revisar el error de export legacy antes de prometer exportabilidad de chat o descargar archivos vía esa ruta. **T10** debe exigir `gapDetected=false`, cursor confiable y evidencia externa completa, no interpretar resultados truncados ni `finished` como PASS.

## D. Investigación externa, licencias y no adopción

- <https://github.com/cloudflare/agents> — OpenCode Harness, `session.log` durable: <https://developers.cloudflare.com/agents/harnesses/opencode/>. Licencia **MIT** observada. Versión **fijada en este repo: `agents@0.33.0`**; la lectura de commit upstream mutable no pudo fijarse mediante los conectores, por tanto **no se copia ni instala código**. Compatibilidad documentada con Worker/DO, pero proyección pre-fetch y bytes/cursor no probada.
- <https://github.com/modelcontextprotocol/typescript-sdk> — SDK MCP v2, especificación 2026-07-28 y paginación de operaciones `list`; licencia declarada **Apache-2.0 para nuevas contribuciones; MIT para código anterior**, según README. Paquetes fijados localmente: servidor 2.4.0 y cliente 2.0.0; los cursores de `listTools` **no** convierten `tools/call` en paginación de transcript. No importar ni cambiar SDK.
- <https://github.com/OpenHands/software-agent-sdk> — eventos duraderos y `event_service.py`, licencia **MIT** observada; runtime Python/Agent Server no es directamente ejecutable dentro de `workerd`, no reemplazar el actual Harness. Commit exacto externo no comprobable mediante los endpoints disponibles, por lo que se usa solo como referencia de arquitectura y no se adapta código.

**Atribución:** diseño y tests nuevos desarrollados en esta ronda por ChatGPT; sin dependencias ni fragmentos copiados de esos proyectos. No hay costes de inferencia/Cloudflare mutativos registrados para este trabajo. El CI GitHub consume runners existentes; no hay medición monetaria efectiva disponible.

## E. Condiciones de cierre R2 y gate general

R2-T05 puede aceptarse como **PASS técnico acotado** si `bun test`, `typecheck`, build Worker principal + MCP, invariantes y CI del HEAD exacto pasan, y se comprueba que las rutas peligrosas fallan antes de `history()`. **R2 no certifica** una prueba de diez tareas verdaderamente activas ni limita eventos crudos ya deserializados. F0-C10 sigue `PARTIAL/NO COMPLETE PASS` hasta las pruebas E2E auténticas T10 con presupuesto y exclusividad verificados.

## F. Entrega a C11/T11 — selección de cambios y contratos (2026-11-22/23)

La reconciliación posterior se documenta en [`05_C11_HANDOFF.md`](./05_C11_HANDOFF.md) de esta rama y en la PR #139. Incluye el diff seleccionado de #139, solapamiento concreto con T09 R2 [#133](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/133) y controles del evaluador T10 de #126. **Esta es una entrega al integrador C11, no una integración realizada**; no reescribir #126 ni #133.

Puntos de bloqueo: #133 deriva de #123, no de #126 y conserva funciones heredadas de transcript/exportación que se deben descartar al portar; su manifiesto GET llama a `supervisedTaskStatus` (no está demostrado que sea lectura barata). En `scripts/f0-c10/evaluate.mjs` de #126, el `status_probe` no invalida por sí solo `gapDetected:true` o `_responseTruncated:true`; C11/T10 debe cerrar ese negativo antes de aceptar trazas live. La nueva prueba `bounded-response.test.ts` presenta manifiestos sintéticos de ocho archivos de T09 y salida MCP truncada; no se ha fusionado código T09 en esta rama. Ver CI del HEAD posterior a la entrega, no reaprovechar únicamente los runs históricos.

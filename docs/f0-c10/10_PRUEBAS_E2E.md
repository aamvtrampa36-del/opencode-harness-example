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

El último par **debe salir con código 1**; el modo --suite sale 0 solo si los GREEN pasan y **todos** los RED fallan. La salida JSON está limitada a fixtures no sensibles; no contiene tokens ni transcripciones. Resultado de validación local T10: **24/24 tests y 16/16 escenarios originales de suite correctos**, antes de la auditoría de lectura independiente. La rama de auditoría agrega dos tests y dos negativos; la CI de #119 se verificó sobre HEAD `ecbc531166b6c3806a906ec362f0aac520a6ef69`: 26/26 tests, suite 18/18 y build/CI generales en verde; no hay E2E real. En mock hubo solapamiento de aproximadamente 130 ms para diez herramientas simuladas; no representa rendimiento real de OpenCode.

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
| cancelled inesperado | RED |
| missing-readback; corrupt-readback | RED: el artefacto afirmado no basta si no se recuperan bytes idénticos |
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


---

## R2-T10 — Entrada E2E con pruebas de procedencia y lectura de bytes (2026-11-22/23)

**Actor:** ChatGPT mediante GitHub/CI, no OpenCode Remote. **Rama R2** `f0-c10/r2-t10-live-evidence-20261122` desde candidato integrado [#126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126) @ `1268ba22f26330d619b046fcf551ca846cb69d0f`. No modificar #126 ni desplegar. Evidencia Stage de lectura Cloudflare: principal deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, version `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`; MCP deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, version `196240c0-1052-47b3-aaa7-02cf5baa87f0`, ambos al 100 %. **No** equivalen al candidato #126 ni al código R2 publicado. Remote solo consultado en lectura, devolvió `ready=true` y `supervisedCountComplete=false`.

### Modelo mínimo de recibos live (nuevo)

La **entrada** del evaluador es una traza `mode:"live"` más cuatro firmas **Ed25519 independientes** sobre vistas canónicas del mismo experimento (`scripts/f0-c10/live-evidence.mjs`). El archivo de claves públicas confiables se suministra **por el operador de T11 fuera de la traza**; las claves privadas nunca se entregan al modelo ni al repo. Un JSON que autoafirme `source:"runtime"`, `source:"cloudflare"` o `verified:true` no basta. No se aceptan claves públicas incluidas en la entrada. La aceptación requiere firmas válidas, custodios independientes (sin reutilizar una clave para dos roles), identidades y bytes correctos.

1. **runtime:** adaptador que observe las llamadas y resultados directamente en el Worker/Harness, firme `metadata`, `tasks` y los eventos `received/admitted/persisted/queued/execution_start/tool_start/tool_end/inference_start/inference_end/status_probe/output/completed` con `experimentId`, `sourceSha` de 40 hex, `requestId` de 16 hex, `sessionId`, `operationId`, `projectId`, `executorId`, `callId`, `seq`, `atMs`. La firma cubre el `workerVersion`, `mcpVersion`, `gitBaseSha`, el hash de límites y lease. Captura desde fuentes internas autorizadas y no desde mensajes generados por IA. Para inferencia, el cierre debe tener `outcome:"success"`; para herramienta, `exitCode:0`. Falta instalar/auditar el adaptador. La firma no inventa observaciones.
2. **artifact:** colector **distinto** con GET real autenticado bajo identidad/ACL de tarea, `retrievalReceipt` con `retrievalId`, `authenticated:true`, `method:"GET"`, `status:200`, `sha256`, `byteLength`. Firma el evento `artifact_readback` y su `bytesBase64` original; el verificador exige base64 canónico, SHA-256 de bytes, longitud, igualdad byte a byte con contenido y oráculo independiente, ruta/proyecto e identidad de sesión correctos. La ruta textual de `/bundle` no es GET. T09 informa que **no existe todavía endpoint de archivo individual en Staging**: fixture local HTTP no equivale a entrega real.
3. **telemetry:** colector de Cloudflare **fuera del runtime del agente** que consulte endpoints autorizados, preserve `queryId`, versión, servicio, UTC del evento, memoria del isolate y errores OOM, deduplicando resets por identidad trazable. Firma las muestras. El evaluador rechaza firmas alteradas, versión/query incompatibles, memoria sobre umbral o falta de muestra durante la intersección completa. Muestras del isolate no prueban memoria privada de un DO.
4. **budget:** colector independiente de T07 que firme la contabilidad por inferencia, Workers, DO, Container, observabilidad, CI y egreso; cada importe debe ser numérico y conocido, incluidos ceros demostrados. También firma cap y recibo del *corte técnico realmente aplicado* (`stop.enforced`, `scope:full-experiment`, `controlId`, `meterReceiptId`). Los eventos autoafirmados de consumo o un `maxCostUsd` escrito a mano no prueban corte. **Actualmente NO hay control efectivo certificado**.

Todas las firmas usan bytes `OPEN-CODE/F0-C10/LIVE-EVIDENCE/V1/<rol>\0<JSON canónico>`, separación por rol y vistas de procedencia en el código; no hay dependencias externas. `metadata.limitsSha256` ata los límites a un archivo externo. La verificación reejecuta el oráculo por tarea y el barrido temporal. Las firmas verifican la **custodia de claves**, no el comportamiento honesto del software: para que una traza sea auténtica, T11 debe inspeccionar el código, SHA, despliegue, ACL, orígenes, relojes y permisos de cada colector, y conservar el recibo de consulta Cloudflare.

### Ejecución offline y exit codes

Desde checkout verificable, Node >=20 y sin credenciales:

```sh
node --test scripts/f0-c10/evaluate.test.mjs scripts/f0-c10/live-evidence.test.mjs
node scripts/f0-c10/run-offline.mjs --suite --out f0-c10-offline-evidence.json
node scripts/f0-c10/verify-live.mjs --traces ronda1.json,ronda2.json,ronda3.json --trust /ruta/externa/claves-publicas.json --limits /ruta/externa/limites-bloqueados.json --out evaluacion.json
```

`verify-live` **únicamente lee archivos offline** y nunca solicita tareas ni se conecta a Staging. `--traces` exige 1 o 3 entradas, `--trust` cuatro claves independientes `{runtime,artifact,telemetry,budget}` en PEM, `--limits` valores numéricos completos incluyendo dos caps positivos predeclarados: `maxCostUsd` por ronda y `maxCampaignCostUsd` acumulado para las tres, con corte independiente. Exit `0`: el registro recibido cumple el verificador (aún requiere auditoría humana de procedencia); `1`: RED/rechazado; `2`: entradas ausentes/corruptas o error del verificador. El `--out` se escribe nuevo con modo 0600 y nunca contiene claves privadas ni transcripts. El CI sólo genera claves efímeras de TEST en memoria. No admitir claves del fixture ni datos autoafirmados como prueba E2E real.

Matriz adicional RED: firma de runtime alterada; telemetría Cloudflare falsificada; reset/OOM autenticado en muestras de Cloudflare aun cuando el agente reporte éxito; status solo fuera de la ventana común de diez; coste acumulado de campaña fuera de cap; clave incluida en traza o reutilizada; SHA de evento cambiado aun con nueva firma; bytes alterados tras GET; lectura inexistente; contabilidad desconocida o sin corte real; intervalos sólo de cuatro ejecutores; OOM histórica #90; `requestId` reutilizados entre rondas. GREEN de fixture: 1/2/4/10 y tres rondas de 10 con firmas **sintéticas**; se distingue en el informe de una aceptación auténtica.

### Dependencias y coordinación horizontal

- **T01 (memoria):** reportar queryId de Observability, `rpcMethod`, DO/isolate asociado, deduplicación de resets, muestras y origen de timestamps; no inventar medición de heap. La ausencia de memoria verdadera equivale a STOP para campaña.
- **T09 (outputs):** construir endpoint GET autenticado por task/artefacto con ACL server-side y leer bytes originales, metadata `sha256/length`, estado 403/404/409/410, retención y aislamiento; T10 solo consume el recibo firmado. Fixture T09 loopback es verde parcial, no autenticación real.
- **T03 (admisión):** contrato de lease único con fencing, transiciones persistidas, `requestId` idempotente y capacidad de sostener diez trabajos efectivamente activos, no sólo queued/busy.
- **T07 (inferencias y costes):** presupuesto de *worst case*, reserva/corte técnico de facturación total y reconciliación de unknown charge, límite de intentos. Sus tests de proveedor falso no prueban corte real; el propio informe T07 reconoce ese bloqueo. No iniciar tarea Remote hasta tenerlo.

### Ventanas, métricas predeclaradas y escalones

Conservar los límites de sección 6 y establecer `maxCampaignCostUsd` explícito, no nulo, antes de iniciar la campaña. Comprobar el total de tres rondas y el control técnico de gasto del conjunto. Exigir lecturas status exitosas para cada una de las diez tareas **dentro** de la ventana común. 10 intervalos firmados con intersección >= 1000ms, peak isolate <=102.4MiB, p95 admisión <=10s, p95 status <=5s, duración <=180s por tarea, <=1 reintento por tarea, 0 OOM, 0 huérfanos, 0 mezclas y 0 outputs sin byte-readback. **Tres rondas distintas**, 10/10 outputs por ronda. Probar escalones **1→2→4→10** con lectura durante herramienta activa y verificar recuperación/cancelación focalizada antes de ejecutar tres rondas; la continuidad/fairness y los outputs tras reinicio requieren pruebas reales específicas. No ajustar thresholds después del fallo para forzar PASS. `maxCostUsd:null` es STOP para actividad real; el valor positivo del fixture sirve sólo para probar el parser. Los importes reales permanecen **desconocidos**.

**STOP estricto:** sin fuente runtime autenticada, firma/identidad/version/sha corrupta, sin lectura real, coste desconocido, lease ambiguo, OOM o reset, usuario de otro proyecto, cursores incompletos, tiempos no comparables, límite de memoria excedido, fallo de 10/10, o más de un reintento. No reintentar efectos ambiguos con otro requestId.

### Alternativas abiertas: revisión documental, no copia de código

- [DeepSeek Harness @ 4b399c39a6d1479cd84ca591b4d7c88e24d38a96](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96) — licencia MIT (archivo LICENSE verificado), subprocess supervisado, lecturas bounded y offsets. Se aprovecha patrón de observación, no su shell local como sandbox Cloudflare.
- [OpenHands software-agent-sdk @ ebec01b3893696c2f5454762eb44796c71bb391a](https://github.com/OpenHands/software-agent-sdk/tree/ebec01b3893696c2f5454762eb44796c71bb391a) — MIT, eventos de conversación y workspace remoto. Patrón de eventos independientes vs resultados, no conexión binaria directa con OpenCode.
- [SWE-agent @ 3ea751c087f32b16e039a2233dd6eefecef325d5](https://github.com/SWE-agent/SWE-agent/tree/3ea751c087f32b16e039a2233dd6eefecef325d5) — MIT, trajectories y verificación posterior. Patrón de separar acción, observación y resultado.
- **Compatibilidad:** la implementación R2 utiliza exclusivamente `node:crypto`, `node:fs` y los fixtures del proyecto; Node >=20/Bun soportado. No se copiaron módulos externos ni se instalaron paquetes, por tanto no hay obligaciones nuevas de redistribución de código tercero.

### Delimitación de resultados

La CI de esta PR confirma únicamente el verificador offline y las pruebas de regresión. Aun con firmas de fixture verdes, sin adaptadores realmente autenticados, reserva/corte efectivo, source-to-deployment y E2E de tres rondas, **F0-C10 continúa PARTIAL / NO COMPLETE PASS**. Los propietarios de integración decidirán el siguiente lote de instrumentación, despliegue y campaña; R2-T10 no modifica `src/server.ts`, Workers, credenciales, DO, main ni #126.


**R2-contrapruebas adicionales:** El análisis de CI detectó y corrigió una comprobación que confundía `clockSyncMaxSkewMs:0` con ausencia; el primer run RED tuvo 39 PASS y 2 FAIL del fixture firmado, ambos por esa condición. El HEAD `a9e663d15d8acc1b7267697f5e49afdc451b24d3` pasó 41/41 pruebas Node (`exit=0`), la suite 18/18 (`exit=0`) y las regresiones de Bun, build, preview, typecheck e invariantes, así como el workflow T09. Recibos: [offline #45100382647](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45100382647), [general #45100382645](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45100382645), [T09 #45100382687](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45100382687). **Esa evidencia corresponde al HEAD anterior; los tres negativos de OOM/sondeo/presupuesto agregado incorporados posteriormente requieren CI nuevo del HEAD final.** El coste monetario de las ejecuciones de GitHub Actions no se ha conciliado: no declararlo cero. Inferecia pagada sobre Staging: ninguna.


---

## PARTE R3 — T10: oráculo de observaciones y handoff único a T11 (23-11-2026)

**Criterio RED antes del parche:** las firmas Ed25519 de #141 cubrían JSON reconstruido por un test `runMock()` y los valores `source='runtime'`. Un test sintético con claves efímeras podía devolver `pass:true` en el modo `live` porque no había una segunda fuente de **observación primaria de la llamada**. El informe R2 reconocía el riesgo; la implementación actual no instalaba ningún colector real. La meta de R3 es cerrar ese falso positivo por ausencia de recibo primario y entregar a T11 un contrato único, sin carga real.

**Fuente de partida:** cadena apilada #126 → #143 → #144 → #145, HEAD de código #145 `a49e985909cb56bb42c609c9cd5cb4250a620169`. Documentación R3 de #146 `05da68fd1644f92578588c62a4586d561c418c49`, utilizada como base exacta del parche. #145 y #146 siguen draft, no fusionadas. El informe `14_SESSION_RECOVERY_READMISSION.md` confirma ledger T03 `supervisor:admission:v1`, claves `token+generation`, GET por sesión exacta y estados `effect_unknown`; esto NO es observación de tool/inference. El issue #90 continúa OPEN con 0/10 resultados verificados en el episodio histórico, seis inicios con OOM, y ninguna ventana de diez trabajos probada.

### 1. Contrato implementado, sin nuevas dependencias ni recursos

`scripts/f0-c10/observed-journal.mjs` verifica un diario de observaciones que debe proceder de tres **fuentes distintas fuera del modelo**. Todo registro contiene `origin` (`do`, `container`, `provider`), `collectorId`, `deploymentId`, `clockProofId`, `sourceSha`, `workerVersion`, `experimentId`, `fencingToken`, `seq`, `epoch`, `prevHash`, `observedAtMs` y el evento observado (con `requestId`, `sessionId`, `operationId`, `projectId`, `executorId`, `atMs`, `seq` y el resto del contrato T10). Para herramientas se exigen además `containerId`, hash del comando, `callId` y `exitCode`; para inferencia, `providerRequestId`, modelo, `callId` y resultado. Los marcadores de admisión/estado/output deben proceder del observador DO; `test_result` y salidas de comando del Container; las parejas de inferencia del observador proveedor. No se infiere actividad a partir de `busy=true`, de diez HTTP iniciados o de `finished`.

Cada observación va firmada por su propio colector Ed25519 con dominio `OPEN-CODE/F0-C10/OBSERVED-JOURNAL/V1`; se valida una cadena hash por fuente, numeración contigua, `epoch` y `prevHash`, sin ordenar en silencio eventos ausentes o repetidos. Un `observer_resume` firmado con hash de último evento permite pasar a la siguiente época; las parejas start/end no pueden cruzar una época reiniciada sin un recibo final auténtico. Se permiten eventos entremezclados entre DO, Container y proveedor. **Ningún test crea archivos de claves de producción, hace deploy o toca DO.**

El operador de T11 proporciona **fuera de la traza** el trust store con claves públicas específicas `runtime/artifact/telemetry/budget` heredadas de #141, tres claves distintas de observadores y **una aprobación Ed25519 adicional firmada por una raíz de operador**. La aprobación vincula huellas públicas de cada observador, IDs/deployments, fuente SHA, versiones, lease, fencing y recibo externo de sincronización de reloj. La firma del modelo, una clave incrustada en su propia salida o cambiar `source` a `runtime` no reemplazan esas credenciales. Las pruebas generan claves **únicamente efímeras y en memoria**; cualquier fixture en modo `live` es solo un ensayo del verificador, nunca prueba de producción. Las firmas autentican a un *firmante*, no certifican por sí solas que un API auténtico fue consultado: el propietario de cada colector debe auditar implementación, secretos, ACL, infraestructura y ruta de despliegue.

`evaluateTrace()` exige que **cada evento no-artifact_readback** coincida byteestructuralmente con un registro primario firmado, incluyendo identidades y fencing, y comprueba que toda pareja de actividad tiene begin/end con mismo `callId` y mismo ciclo del observador. Las lecturas de archivos siguen la atestación separada T09 con GET autenticado, SHA-256 calculado sobre bytes, tamaño, propiedad de tarea y oráculo determinista. El solapamiento exigido se evalúa de forma conservadora: **10 intervalos + >=1000ms después de descontar 2× el máximo error de reloj aprobado**; la cota de incertidumbre debe ser <=250ms por reloj y comprobada con recibo independiente, no un número autodeclarado. Las muestras de isolate se atribuyen a Cloudflare y su versión, nunca a una sola sesión sin evidencia.

**Lo que R3 implementa:** consumidor/verificador offline de un diario firmado, anclaje de claves, detección de huecos/replays/reinicios, comparación de eventos y solapamiento conservador. **Lo que NO implementa:** emisores efectivos en workerd/Container/inferencia, raíz de operador real, consulta de Cloudflare con queryId, GET autenticado de bytes en Staging, verificación de reloj independiente ni presupuestos/gates efectivos. No afirmar `LIVE_ACCEPTED` cuando faltan.

### 2. RED/GREEN obligatorio (solo offline)

Ejecutar desde el checkout exacto, Node >=20/Bun 1.4.4:

```sh
node --test scripts/f0-c10/evaluate.test.mjs scripts/f0-c10/live-evidence.test.mjs
node scripts/f0-c10/run-offline.mjs --suite --out f0-c10-offline-evidence.json
bun test
bun scripts/test-preview.mjs
bun run typecheck
bun run build
bun scripts/check-invariants.mjs
```

El workflow existente `.github/workflows/f0-c10-offline.yml` verifica el HEAD y ejecuta las pruebas; no se ha añadido un segundo workflow. El CLI `verify-live.mjs` solo verifica archivos `--traces/--trust/--limits` suministrados por el operador, no crea traces ni infiere; su ausencia de datos sale con exit `2`. Los negativos deben salir `RED` (verificador rechaza) mientras **el test unitario sale 0**, nunca convertir un rechazo esperado en fallo de CI.

Casos prioritarios: #90 perfil histórico *sintético* (no volcado crudo); diez solicitudes y cero herramientas; diez `busy`; start/end inventados después de firmar; reloj alterado; salida de otro proyecto; respuesta `completed` ausente; OOM reportado por runtime o Cloudflare; cancel; huérfano `not_found`; coste parcial/inexistente; firma del propio modelo; raíz de operador ajena; cambio de deployment/SHA; clave de observador reutilizada; duplicación/replay de secuencias; corte de cadena hash; cambio de época sin `observer_resume`; inference sin recibo proveedor; interleaving normal de diez tasks y reanudación firmada de DO sin efectos a medias. Se admite GREEN de **formato firmado** bajo claves efímeras de test, nunca GREEN de Staging.

### 3. Receta preregistrada para T11 — STOP antes de pagar

**Preflight sin inferencia (todos obligatorios):**

1. **T01:** fuente instrumentada con queryId Cloudflare/Observability, versión exacta, métricas OOM/reset y memoria del isolate; confirmar traza bajo cada deployment, distinguir DOs que comparten isolate. Un `supervisor.phase.v1` agregado sin IDs personales no demuestra correlación con diez `requestId`; necesita ruta protegida del coletor autorizado.
2. **T02:** demostrar headroom medido de isolate/Container y que diez trabajos no migran ni interfieren. Medir la cota <=102.4MiB por isolate que realmente interviene, sin asignar 128MiB independientes a diez DO. Si no hay muestras durante la ventana real, STOP.
3. **T03/T04:** admisión durable con fence real, lease atómico y exclusión en Staging, diez slots controlados incluyendo rutas legacy; recuperación de `effect_unknown` sin otro `create`/submit; nunca liberar reserva por TTL solo. Confirmar origen SHA↔binario, estados, reversión y permisos server-side.
4. **T07:** tarifa/modelo/proveedor realmente habilitados, cuota, rate limits, reservas y medición reconciliable, corte técnico **total** (inferencia + Workers + DO + Containers + observabilidad + CI + egress) y `maxCostUsd` y `maxCampaignCostUsd` positivos **antes de comenzar**. Una constante de presupuesto o `maxCostUsd:null` es STOP.
5. **T09:** GET real autenticado de artefactos por tarea/owner con ACL y lectura byte-exact de los diez resultados; retención/caducidad; `403/404/409/410` pertinentes y prueba Android cuando el gate la requiera. Paths internos y `file` declarado por modelo no cuentan.
6. **T10/infra:** colectores DO, Container, proveedor, artefacto, Cloudflare y presupuesto con claves separadas aprobadas por operador, versión del colector/release, IDs reales, prueba de reloj común y hash encadenado a través de reinicio; control de acceso al trust store fuera de la traza. Si cualquiera es mock o no está autenticado, STOP sin inferencia.

**Ejecución real futura (no autorizada aquí):** bloquear el lease con fence y comparar workers/HEAD↔artefacto publicados, registrar control de gasto y condiciones de aborto; empezar **1→2→4→10**, con status leído durante actividad y pruebas acotadas de recuperación/cancelación. Solo si cada escalón entrega N/N readbacks correctos sin OOM/huérfanos/mezclas, realizar **3 campañas independientes de diez**. Exigir por ronda diez `tool/inference start/end` auténticos, ventana común real >=1s descontada incertidumbre de reloj, 10/10 artefactos recuperados byte-exact, p95 admisión <=10s, p95 status <=5s, duración <=180s, <=1 retry por tarea, memoria <=102.4 MiB por isolate, 0 OOM/reset/huérfanos/duplicados/cancelaciones inesperadas, costes por ronda y acumulados por debajo de topes técnicos. Pre-registrar tolerancia de precio/tokens y no cambiar umbrales después de un resultado RED.

**Abort inmediato:** fallo de lease/fence, desalineación SHA/source, clock sync no demostrable, pérdida/hueco del diario firmado, inicios sin salida correlacionada, evento sin fuente autenticada, OOM/reset, mezcla de proyectos, output ilegible, coste desconocido o reserva insuficiente, provider 402 o efecto de cobro `UNKNOWN`, reintento potencialmente duplicado, permisos/ACL ambiguos o estado Staging ajeno activo. Detener sin cancelar tareas ajenas ni convertir `unknown/not_found` en PASS.

### 4. Integración, licencias y procedencia

El cambio se limita a `scripts/f0-c10/` y este informe, sin alterar scheduler, Worker/MCP, DO, Access, middleware, claves ni la PR #145/#146. Se reutilizó el patrón existente de `node:crypto` y los oráculos de #119/#141, sin copiar módulos externos. Referencias comparadas anteriormente: [DeepSeek Harness @ 4b399c39…](https://github.com/deepseek-ai/deepseek-harness/commit/4b399c39a6d1479cd84ca591b4d7c88e24d38a96), [OpenHands SDK @ ebec01b3…](https://github.com/OpenHands/software-agent-sdk/commit/ebec01b3893696c2f5454762eb44796c71bb391a), [SWE-agent @ 3ea751c0…](https://github.com/SWE-agent/SWE-agent/commit/3ea751c087f32b16e039a2233dd6eefecef325d5); licencias MIT verificadas en el encargo anterior, no se ha integrado nada de sus repos. El código nuevo es JavaScript nativo Node/Bun sin paquetes instalados ni costes de inferencia.

**Autoría real:** ChatGPT vía GitHub y GitHub Actions, no OpenCode Remote, no Codex. Lecturas Cloudflare GET y Remote `staging_status` sin efectos; Worker `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` 100 % y MCP `196240c0-1052-47b3-aaa7-02cf5baa87f0` 100 %, desplegados antes de la PR, NO procedentes de R3. Remote solo devolvió `ready=true`, recuento >=96 sesiones incompleto: NO es actividad probada. Coste monetario exacto de GitHub Actions, llamadas GET y observabilidad: **desconocido**; coste de inferencia nueva en Staging: no hubo llamadas de generación. Estado global: `PARTIAL / NO COMPLETE PASS`.

**Única entrega:** entregar PR draft R3 de esta rama a T11, con test/CI del HEAD exacto y copia de documentación no sensible en Biblioteca con recibo si es posible. No crear cuarta ronda R3 de especialistas ni repetir experimentos históricos.

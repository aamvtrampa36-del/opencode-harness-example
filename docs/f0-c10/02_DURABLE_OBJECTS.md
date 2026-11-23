# F0-C10/T02 — Durable Objects, memoria y aislamiento de sesiones

**Fecha de investigación:** 2026-11-22 (America/Sao_Paulo).  
**Actor:** ChatGPT (investigación GitHub/Cloudflare + prototipo local Node; **no OpenCode Remote**).  
**Estado:** `PARTIAL / ARCHITECTURE_VERIFIED_AT_SOURCE_LEVEL / TEN_ACTIVE_NOT_VERIFIED`.  
**Entorno:** solo Staging y prototipo offline. **No despliegue, cambio de bindings/migraciones, escritura de datos DO, merge ni pruebas de carga remotas.**

## 1. Decisión ejecutiva

La implementación vigente **concentra supervisión y ejecución de las sesiones supervisadas en un único Durable Object lógico**. El punto de acceso de ambas rutas es `OpenCodeAgent.getByName("opencode-supervisor-v1")`, y ese objeto retiene un `OpenCodeHarness`, `Workspace`, conexiones/plugins, sockets y estado de sesiones. **Los proyectos Linux sí se enrutan a `DevContainer` distintos mediante nombres `project-v1:<project>`**, pero eso no divide el heap del Harness.

En las pruebas reales de diez solicitudes reportadas en [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558) hubo **0/10 resultados completos**, seis respuestas de inicio con OOM y sesiones `not_found`. La simultaneidad efectiva de diez agentes **no** fue demostrada. Es un fallo de aceptación, no prueba de un tamaño de heap exacto ni de causalidad única.

**Recomendación:** primero agotar contención acotada y observabilidad en la arquitectura existente; **si** el perfil muestra que diez ejecuciones mantienen la memoria del objeto por encima del margen seguro aun sin lecturas no acotadas, separar el coordinador ligero del Harness por sesión/tarea. No proponer sharding como arreglo suficiente de 128 MB: múltiples objetos de una clase pueden compartir isolate.

## 2. Fuentes, SHA y estado efectivo

| Fuente | Evidencia comprobada | Límite |
|---|---|---|
| GitHub rama Staging | `staging/opencode-g1-rpc-safe-20261120`, **base fijada para esta PR** `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`; `src/server.ts` blob `64df02c90781766769b4fdc96cd5cb0b7fc3e4d6`, `src/dev-container.ts` blob `1d96e090f3b322b6e610d09fb9bfc253729365ff` | Este SHA es fuente revisada/base del prototipo, NO byte-identidad con el bundle activo |
| GitHub fuente histórica del activo | `74632f75db010223cc90d99ba4a801ce0e6414e5` citado por [#113](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/113); `src/server.ts` blob `d488943ed5a81d8f7394c070211d9264af421a38` inspeccionado | El mapeo a bytes del despliegue depende de auditorías T02/T03; no afirmamos certificación propia |
| Cloudflare GET deployments/versions | `opencode-g1-staging` deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, versión **#374** `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, **100 %** | Solo prueba versión/tráfico observado, no E2E |
| Cloudflare GET deployments/versions | `opencode-staging-control-mcp` deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, versión **#19** `196240c0-1052-47b3-aaa7-02cf5baa87f0`, **100 %** | Candidato de #106 no activo según #113 |
| Cloudflare GET settings | Principal: `OpenCodeAgent`, `DEV→DevContainer`, `SETTINGS→PersonalSettings`, `SESSION_BK→SessionBackupDrillAgent`, AI, LOADER, RECOVERY_R2, SUPERVISOR_WORKFLOW. MCP: servicio `STAGING_HEALTH` y DO `STAGING_SUPERVISOR→OpenCodeAgent` en script principal | Se omitieron deliberadamente valores de credenciales/secretos |
| OpenCode Remote lectura | `staging_status`: `health=ok`, `supervisor.ready=true`, 96 sesiones indexadas mínimas, `supervisedCountComplete=false` | Salud no demuestra 10 ejecuciones ni reserva de carga |
| Issues y PR | [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), [#91](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/91), [#94](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/94), [#106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106), [#110](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/110), [#113](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/113) | No confundir PR abierta/draft, CI verde y versión activa |

### Estado de correcciones existentes

- **#91 merged:** sustituyó `handle.history()` del polling de estado por log incremental y contadores persistentes.
- **#94 merged:** `remoteSupervisorStatus` y `remoteSupervisorSessions` dejan de enumerar `harness.sessions.list()`; usan `storage.list({prefix:"supervisor:task:", limit:101})`, máximo 100 entradas y `busy()` en grupos de cuatro.
- **#106 draft, no desplegada:** `supervisedTaskTranscript` y `remoteSupervisorInspectSession` fallarían cerrado antes de `history()`; `remoteSupervisorInspect` sería snapshot del ledger; también deshabilita lectura MCP de transcript. Es una contención funcional con pérdida temporal de la vista de transcript, **no** una solución integral de concurrencia.
- **#110/#113 draft:** auditorías de compatibilidad/preflight sin promoción de los artefactos #106.

## 3. Mapa de arquitectura real

```text
Cliente Android / ChatGPT -> MCP opencode-staging-control-mcp
                              | STAGING_HEALTH: service binding -> Worker principal
                              | STAGING_SUPERVISOR: DO binding del Worker principal
                              v
opencode-g1-staging -> OpenCodeAgent.getByName("opencode-supervisor-v1")
                              |
                              +-- supervisor:task:<requestId> [SQLite durable]
                              +-- supervisor:session:<sessionId> [SQLite durable]
                              +-- opencode_* [tablas SDK en storage del mismo DO]
                              +-- OpenCodeHarness / OpenCodeWorkerd
                              |     +-- sesiones, operaciones, logs y plugins
                              |     +-- Workspace / Dynamic MCP / sockets
                              |     +-- proveedor Workers AI / OpenRouter
                              |     +-- GitHubBridge / guardas de rama
                              |
                              +-- DEV.getByName("personal") [registro global]
                              +-- DEV.getByName("project-v1:"+project)
                              |      +-- DevContainer DO + Container Linux por proyecto
                              +-- SETTINGS.getByName("personal") [config global]
                              +-- SESSION_BK [drill]
                              +-- Workflow y RECOVERY_R2 [recuperación]
```

Referencias exactas del código: [src/server.ts @11161dd](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/server.ts) (`OpenCodeAgent` L60; `startSupervisedTask` L68; `advanceSupervisedTask` L155; `harness` L1382; `isolatedProject` L1335; llamada al host L1500), [src/supervisor-control.ts](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/supervisor-control.ts) (`SUPERVISOR_WORKSPACE` L9; `supervisor:task:` L100), [src/project-container.ts](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/project-container.ts) L4–6, [src/dev-container.ts](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/dev-container.ts) L75–129, [wrangler.g1.jsonc](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/wrangler.g1.jsonc), [wrangler.mcp-staging.jsonc](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/wrangler.mcp-staging.jsonc).

**Persistencia:** en un DO, SQLite/`ctx.storage` conserva receipts, registros y sesiones según el contrato SDK; las variables del objeto y el cache del Harness no sobreviven al reinicio. La durabilidad de una operación y la conservación de los archivos en GitHub no garantizan que un `operationId` ambiguo sea recuperable sin lógica de reconciliación. El lote del 22-11 exhibió este riesgo (`not_found`).

## 4. Componentes residentes y vías de crecimiento de memoria

| Residente o carga | Dónde / prueba de código | Riesgo / conclusión |
|---|---|---|
| `OpenCodeHarness / OpenCodeWorkerd` | Campo `readonly harness` y factory en `OpenCodeAgent` | **Compartido para todas las sesiones supervisadas** del mismo DO; cuantía de heap por sesión aún **no medida** |
| Modelos registrados / plugins | `registeredWorkersModels`, AI, OpenRouter, TokenEconomizer, Remote MCP, Workspace Plugin | Objetos persistentes por instancia y posibles caches de herramientas/conexiones; tamaño desconocido |
| `Workspace`, sockets y `Lifecycle` | Campos `workspace`, `sockets`, `webSockets`, `lifecycle` en `server.ts` | Retención de referencias y conexiones; dependerá de tráfico/hibernación |
| Receipts/índice de tareas | `supervisor:task:`, `supervisor:session:`, `storage.list(limit:101)` | Índice consultado en memoria de máximo 101 entradas **por consulta**; `supervisedCountComplete=false` no significa que solo haya 100 sesiones históricas |
| Estado de sesión y logs | `sessions.create`, `session(...).submit`, `wait`, `log`, `history` | Historial completo y serialización pueden generar picos; no todas las rutas están contenidas en #374 |
| `remoteSupervisorInspectSession` | En fuente ligada al activo, `sessions.list()` + `history()` + render total + `slice` final | **Ruta no acotada presente**; `slice` posterior no reduce el pico previo |
| `remoteSupervisorInspect` / transcript | `supervisedTaskTranscript -> exportSessionData -> history()` | **Ruta no acotada presente**; #106 propone rechazo seguro antes de leer |
| `supervisedTaskStatus` | `wait(operationId)` y lectura incremental posterior | `wait()` aún requiere perfilado; no afirmar que ha causado OOM |
| Subagentes y legacy G8/G9 | `harness.sessions.list()` y `history()` en varias rutas | Posibles cargas fuera de supervisor; no atribuir incidente sin traza |
| Linux Container / `DevContainer` | `DEV.getByName(projectContainerName(project))`; `run` remoto al Container | **Aislamiento Linux por proyecto**, no por isolate del Harness; Container tiene recursos y facturación propios |

La fase de inicio ejecuta serialmente varios pasos persistentes por solicitud (rama GitHub, creación de sesión, scope, modelo, operación, submit) bajo un lock **por requestId** y transacciones del mismo DO. No hay evidencia de un semáforo global de capacidad de diez activos. El lock por ID evita duplicados de una tarea, **no limita los inicios simultáneos de tareas diferentes**.

**Cuello de botella demostrado a nivel lógico:** un único `OpenCodeAgent` concentra recepción, materialización de sesiones, coordinación del SDK, eventos, inspecciones y escrituras de estado de diez tareas independientes. Es una dependencia y un dominio de fallo compartido. **Cuello de botella físico por memoria/CPU atribuido a un componente específico: NO DEMOSTRADO**, requiere perfil/probetas de T01.

## 5. Límites de Cloudflare y qué significa repartir Durable Objects

La documentación oficial vigente confirma:
1. **128 MB por isolate, no por invocación, sesión ni Durable Object**. El heap JS y WebAssembly cuentan. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#memory).
2. Un isolate **puede alojar varios DO de una misma clase**, y el uso de memoria mostrado al filtrar por DO sigue siendo el del isolate completo. [DO memory analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/#memory-usage).
3. Un DO tiene una única instancia activa para su ID, JavaScript síncrono single-threaded y concurrencia intercalada en `await`; `blockConcurrencyWhile` prolongado reduce el throughput. [Rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [DO state](https://developers.cloudflare.com/durable-objects/api/state/).
4. Cloudflare indica que los trabajos independientes escalan mejor cuando no pasan todos por el objeto de control; advierte que los IDs distintos **no garantizan isolates distintos**. [Architecture guidance, actualizado 2026-11-21](https://developers.cloudflare.com/durable-objects/best-practices/architecture-guidance/).
5. Un Container tiene vCPU/memoria configurables propios, separados de la cuota V8 del Worker/DO, con coste de ejecución propio. [Containers limits](https://developers.cloudflare.com/containers/platform/limits/), [pricing](https://developers.cloudflare.com/containers/platform/pricing/).

**Consecuencia:** `getByName("task:"+id)` no reserva 128 MB ni garantiza separación física. Distribuir los *estados y cargas* puede reducir retención por objeto y contención de eventos, pero solo observabilidad + test real confirman estabilidad. Cloudflare permite además medir `durableObjectsPeriodicGroups.quantiles.memoryUsageBytesP99`; cada muestra sigue siendo del isolate, incluso filtrada por ID. No deducir MiB por sesión por resta entre gráficos agregados.

## 6. Matriz de alternativas

Escala de evaluación cualitativa: **1 = menos coste/complejidad**, **3 = más**; capacidad es hipótesis hasta E2E.

| Criterio | A. Mantener y acotar memoria | B. Coordinador ligero + ejecutores | C. Distribución por sesión/objeto o unidades aisladas |
|---|---|---|---|
| Cambio funcional | Eliminar `history/list/export` no acotados; índices/paginación; perfil de `wait`; backpressure segura | Separar ledger/admisión/routing de Harness que ejecuta una tarea o grupo | Elegir DO independiente por tarea/sesión y, donde sea necesario, Containers independientes |
| Memoria en `OpenCodeAgent` | Puede reducir picos; permanece un Harness compartido | Coordinador pequeño; heap del SDK pasa a ejecutores | Reducir sesiones por objeto; **no garantiza isolate independiente** |
| Capacidad de 10 activos | **Posible, no probada** | Potencialmente mejor, no probada | Potencialmente mejor, no probada |
| Complejidad/operación | **1** | **3** | **3** |
| Gastos adicionales | **1**: solo pruebas y cambios acotados | **2–3**: RPC, DO activos, almacenamiento y migración | **3**: más instancias/DO activos/Containers posibles |
| Recuperación | Preserva SQLite/operationIDs actuales; reconciliar huérfanos | Precisa ledger central y recuperación cruzada idempotente | Precisa routing versionado, estado por unidad y tolerar fallos parciales |
| Reversibilidad | Alta para guardas/PR; baja si cambia formato de estado | Media-baja tras migrar storage/sesiones | Media-baja; sharding dinámico y estados previos complican rollback |
| Aislamiento lógico | Parcial: rama y Container por proyecto, sesiones en Harness común | Mejor por función, si estado del ejecutor es independiente | Mejor por tarea/DO/Container; no equivale a garantía física |
| Mantenimiento | **1** | **3** | **3** |
| Gate previo | RED/GREEN de rutas de memoria y observabilidad | Perfil demuestra límite A; contrato recuperación/migración | Bench de B y co-residencia; migración autorizada |

**Elección provisional: A, con criterio de salida mensurable.** No pagar el coste de B/C si diez trabajos se vuelven estables con acotación. Si el heap sigue saturado en diez sesiones aun sin inspecciones, pasar a **B**: coordinador durable con receipts pequeños y **ejecución por tarea** (posiblemente usando la clase existente `OpenCodeAgent` con nombres por tarea), sin reemplazar el SDK. C no añade garantía física respecto a B y solo se justifica con datos de contención o aislamiento.

**Importante:** B/C requieren diseño de migración de state y, si se agregan nuevas clases/bindings, nuevas migraciones DO. **Solo propuesta**; no introducir tag `v5` ni cambiar routing de sesiones previas. Explorar admisión de tareas nuevas con IDs deterministas, compatibilidad del SDK al mover su almacenamiento, versión de routing, sticky ownership, reconciliación, permisos por ejecutor y fallback de tareas legadas antes de una PR de código.

## 7. Prototipo offline reproducible (no Worker real)

Archivos de esta rama:
- [memory-retention-prototype.mjs](../../scripts/f0-c10/memory-retention-prototype.mjs)
- [memory-retention-prototype.test.mjs](../../scripts/f0-c10/memory-retention-prototype.test.mjs)

```sh
node --test scripts/f0-c10/memory-retention-prototype.test.mjs
node --expose-gc scripts/f0-c10/memory-retention-prototype.mjs
```

**Fixture:** generador sintético de **10 sesiones, 1.200 eventos cada una, 4.096 bytes de payload por evento**; comparación secuencial bajo el **mismo proceso Node 22.16.0**. La estrategia `full-history` crea array completo y serializa, luego trunca; `bounded-cursor-simulation` conserva solo 20 IDs en un ring y agrega cuentas. No modela la implementación interna de `agents@0.33.0`, el isolate workerd, los costes ni la verdadera concurrencia de inferencia.

**Resultado local dos ejecuciones:**

| Métrica | `full-history` | `bounded-cursor-simulation` |
|---|---:|---:|
| Eventos procesados | 12.000 | 12.000 |
| Bytes contabilizados aprox. | 49,72 MB | 49,71 MB |
| Aumento heap en primera muestra | 149,55 MiB | 11,12 MiB |
| Aumento heap en segunda muestra | 149,49 MiB | 11,08 MiB |
| Duración primera muestra | 380 ms | 153–167 ms |
| Último ID | `9:1199` | `9:1199` |

Las cuatro pruebas unitarias pasaron (4/4): equivalencia del tail, vacío/singleton, máximo fijo y rechazo de entradas inválidas. Las mediciones son **no deterministas** (GC/JIT) y solo ilustran por qué recortar *después* de serializar no acota pico. **No comparar los 149 MiB de Node directamente con el límite DO de Cloudflare como si fuera una reproducción de #90**. No se ejecutó Bun/typecheck/build/SDK por ausencia de repo y Bun en entorno local; CI del HEAD debe registrarse por separado.

## 8. Referencias externas y licencias

| Referencia precisa | Patrón aprovechable | Licencia/precaución |
|---|---|---|
| [DeepSeek Harness `packages/shell/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/README.md) y [`bash-sandbox`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/bash-sandbox/README.md) | Abstracción de ejecutor intercambiable y confinamiento antes de ejecutar procesos, desacopla core del host | [LICENSE MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE). `dsh-bash-local` ejecuta con autoridad del host: **no usarlo sin sandbox**; revisar [avisos de terceros](https://github.com/deepseek-ai/deepseek-harness/blob/master/THIRD_PARTY_NOTICES.md) |
| [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk), [`examples/02_remote_agent_server`](https://github.com/OpenHands/software-agent-sdk/tree/main/examples/02_remote_agent_server) | Separación servidor remoto, conversación, runtime y Workspace; API/streaming/ejecutores independientes | [LICENSE MIT](https://github.com/OpenHands/software-agent-sdk/blob/main/LICENSE). Ejemplo de patrón, **no prueba de compatibilidad directa** con Cloudflare Workers |
| [Cloudflare DO architecture guidance](https://developers.cloudflare.com/durable-objects/best-practices/architecture-guidance/) | Atom de coordinación; control separado de ejecución; getByName determinista; evitar hot object global | Documentación oficial, no código copiado; verificar despliegue y límites |
| [Cloudflare DO memory metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/) | Medir isolate P50/P90/P99 y filtrar por DO ID; correlacionar logs/OO​M por método | No atribuye heap solo al DO filtrado |

**No se copió código de proyectos externos ni se agregaron dependencias.** Para una futura adaptación de código, fijar commit upstream, incluir avisos/licencia MIT y revisar transitivas. Reutilizar primero `agents@0.33.0` y OpenCode SDK del repo.

## 9. Plan de verificación y criterios de decisión

**A — Observabilidad/contención (T01/T02/T08, sin carga masiva):**
1. Confirmar versión y código fuente del bundle activo; registrar por solicitud `requestId`, `operationId`, DO ID, RPC, outcome, periodo y bytes. Cloudflare P50/P99 son **por isolate**.
2. Perfil de rutas `remoteSupervisorInspectSession`, `remoteSupervisorInspect`, `supervisedTaskTranscript`, `exportSessionData` y `wait`, con fixtures 1/2/4/10 sesiones sin reactivar inferencia pagada. Priorizar integración controlada de #106 por lote independiente.
3. Acotar payloads desde origen, no `slice()` posterior; evitar `sessions.list()` completo en rutas de inspección; preservar transparencia de conteo `limited`, estado `unknown` y idempotencia.
4. Con reserva/coste real autorizado, ejecutar en Staging de forma escalonada 1→2→4→10 solo después de integrar y revalidar un candidato, no desde T02.

**Gate para cambiar a B:** se mantiene problema de 10 activos, con herramientas reales y logs acotados, y un perfil identifica retención/contención del único Harness en el mismo DO sin otra reparación pequeña segura. Diseñar entonces prototipo independiente de coordinador + ejecutores con datos sintéticos, incluyendo reinicio/crash, mismos requestIds, herramientas con exit code y verificación de estados ambiguos.

**Observables obligatorios para demostrar diez:** intervalos con **10 sesiones diferentes realmente ejecutando inferencia/herramientas al mismo tiempo**, no diez HTTP POST ni `busy=true` artificial; 10 outputs y verificaciones, sin OOM, sin huérfanos y sin escrituras fuera de rama. G-C10-D requiere tres rondas y coste verificado. Gate de esta PR: solo investigación + prototipo, **NO COMPLETE PASS**.

### Recuperación y reversión del diseño B propuesto (sin aplicar)

Ledger mínimo debe persistir `requestId`/fingerprint, owner ID y routing version, `sessionId`, `operationId`, transiciones observadas y confirmación de efectos. Registro de estado por ejecutor solo con actor propietario; no copiar sesiones en caliente ni asumir que exportar JSON restaura el schema SQLite interno de OpenCode. Mantener compatibilidad de tareas históricas con el DO `opencode-supervisor-v1` mientras se evalúan nuevas; auditar recuperación después de reset sin producir duplicados. Cualquier reconfiguración de DO/Container requiere autorización, pruebas en entorno descartable y rollback propio; rollback de Worker **no restaura** storage de DO, snapshots de Containers ni R2.

## 10. Coordinación, costes y cierre de T02

- **Rama exclusiva:** `research/f0-c10-t02-do-isolation-20261122` desde `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`, sin tocar rutas de código de otros especialistas.
- **Archivos:** este informe y dos scripts offline independientes. Sin edición de `src/server.ts`, `src/dev-container.ts`, configuración/migración o APIs del supervisor.
- **OpenCode Remote:** se consultó solo `staging_status`. No hay lease exclusivo ni corte efectivo de coste verificados, de modo que **0 ejecuciones Remote** y 0 inferencias iniciadas por T02. Autoría del prototipo: ChatGPT.
- **Coste:** 0 inferencia remota nueva, 0 Container remoto nuevo, 0 Cloudflare deploy por este encargo. La lectura de APIs y CI pueden tener costes marginales no medidos; **no se afirma facturación total US$0**. Tiempo local offline no monetizado.
- **Conflictos potenciales:** #106 y T01/T08 trabajan `src/server.ts` y rutas peligrosas; este PR deliberadamente no entra en esos archivos. Merge y despliegue fuera de alcance.

**RESULTADO:** estructura lógica de concentración confirmada; reparación prioritaria A; B/C propuestas condicionadas; no demostrado que A pueda o no pueda sostener diez ejecuciones hasta E2E.  
**EVIDENCIA:** GitHub fuente base y fuente asociada a activo, Cloudflare GET #374/#19, issue #90, prototipo Node 4/4 y comparativa sintética.  
**BLOQUEANTE:** no existen heap profile de SDK/DO con diez activos, reserva Remote ni corte efectivo para carga; #106 no activa.  
**PRÓXIMA ACCIÓN:** T01 identifica la ruta causante y el perfil; integrar primero contención acotada, revalidar estado/CI, y únicamente con permiso operativo posterior ejecutar benchmarks 1→2→4→10. Si A no sostiene diez activos con memoria acotada, prototipar B sin aplicar migraciones.

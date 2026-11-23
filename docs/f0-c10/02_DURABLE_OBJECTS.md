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


---

# Parte II — F0-C10/R2-T02: residencia del Harness y umbral de separación (2026-11-22/23 UTC)

**Autor:** ChatGPT con lecturas GitHub, Cloudflare y Remote, más pruebas **Node locales offline**; no atribuir este trabajo a OpenCode. **Estado:** `PARTIAL / SDK_SOURCE_AUDITED / SYNTHETIC_BENCH_PASS / WORKER_10_ACTIVE_NOT_VERIFIED`.

**Punto de integración:** [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126) HEAD `1268ba22f26330d619b046fcf551ca846cb69d0f`, **draft/unmerged**, comparación R2 fijada. El [plan maestro R2 #127](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/127) prioriza perfil de memoria T01/T02 antes de estructurar una migración. Esta rama R2 no escribe #126 ni ninguna rama T01/T03/T05.

## 11. Estado medido de los dos Workers y de los candidatos

| Capa | Snapshot Cloudflare GET y origen | Lectura correcta |
|---|---|---|
| Principal | `opencode-g1-staging` deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, **#374** `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, **100 %** | El candidato integrado #126 **NO** está desplegado |
| MCP | `opencode-staging-control-mcp` deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, **#19** `196240c0-1052-47b3-aaa7-02cf5baa87f0`, **100 %** | Las protecciones MCP candidatas no equivalen a runtime activo |
| Remote lectura | `status=ok`, `supervisor.ready=true`, `supervisedCountAtLeast=96`, `supervisedCountComplete=false` | Es recuento indexado incompleto; **NO** 96 activas |
| T11 #126 | 40 archivos; base `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`; CI de fuente: 45093134023, 45093134014, 45093134038, `completed/success` | No prueba E2E ni memoria workerd |
| Incidente #90 | Seis RPC `startSupervisedTask` terminaron `exceededMemory` al lanzar diez; 0/10 completas verificadas | El método final no identifica el allocador; sesiones `not_found` siguen sin resolver |

Fuentes: [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), [T01 #116](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/116), [T03 #125](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/125), [#126 consolidación](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/1268ba22f26330d619b046fcf551ca846cb69d0f/docs/f0-c10/11_CONSOLIDACION.md). El estado de #115 original era una investigación con benchmark Node de primera ronda; se conserva como histórico y este apéndice no reinterpreta esos números como workerd.

## 12. SDK real, versión y mapa de referencias fuertes

Dependencias inmóviles en [package.json de #126](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/1268ba22f26330d619b046fcf551ca846cb69d0f/package.json): `agents@0.33.0`, `@opencode/sdk@2.0.24` y `@opencode/plugin@2.0.24`; Bun `1.4.4` y Wrangler `4.158.0`. Código auditado **exactamente** en tag [`agents@0.33.0`, commit `5684e278e44abfb592a6ae6ef3e2f5250feacd8c`](https://github.com/cloudflare/agents/blob/5684e278e44abfb592a6ae6ef3e2f5250feacd8c/packages/agents/src/harness/opencode/harness.ts); blob SHA de `harness.ts` `60a53571e9ab23f012a4fedbf5aed5255fad773e`. **No se auditó la implementación interna de `@opencode/sdk@2.0.24` ni su host V8 mediante heap snapshot**. Por tanto no afirmar memoria retenida dentro de sus tablas, plugins o caches, más allá de las referencias observadas.

```text
OpenCodeAgent DO [un solo nombre: opencode-supervisor-v1]
├── readonly harness = new OpenCodeHarness(...)
│   ├── #options.opencode factory -> OpenCodeWorkerd.create()
│   ├── #opening: Promise<OpenCode> | undefined -> host V8 de OpenCode
│   ├── #leases: number (uso y suscripciones abiertas)
│   ├── #waits: Map<sessionId, Promise<void>> (esperas de jobs activos)
│   ├── #admitting: Map<sessionId, number> (admisiones en tránsito)
│   └── sessions: OpenCodeSessions (fachada; no Map completo propio)
├── readonly workspace = Workspace(...) [storage DO, providers y plugins]
├── readonly sockets = OpenCodeSessionSockets(...)
│   ├── #watches: Map<sessionId, Promise<OpenCodeEventStream>>
│   ├── #snapshots: Map<sessionId, boolean>
│   ├── #submitLocks: Map<sessionId, Promise<void>>
│   ├── #activeConfigurations: Map<sessionId, {operations:Set}>
│   └── #cancelledWorkflows: Set<sessionId>
├── webSockets + lifecycle, models registrados y closures hacia configuración
│
└── ctx.storage SQLite durable [supervisor:task: / opencode_* / jobs]
        -> instancias DEV distintas por proyecto para Linux
```

**Hallazgos precisos en el SDK fijado** ([`harness.ts`](https://github.com/cloudflare/agents/blob/5684e278e44abfb592a6ae6ef3e2f5250feacd8c/packages/agents/src/harness/opencode/harness.ts)):
- L218–244: el Harness almacena `#waits`, `#admitting`, `#leases` y `#opening`. `session(id)` crea una **fachada nueva** sin I/O ni cache de sesiones propio (L290–297); NO afirmar que la mera creación de un handle conserva el historial.
- L413–449: `enqueue` establece `#admitting` y lo elimina en `finally` al terminar admisión, aunque una falla puede dejar un estado durable ambiguo entre operaciones externas.
- L622–663: `#wakeStep` mantiene una `Promise` en `#waits` mientras la sesión está activa; la elimina en `finally` y reprograma `#wake`. L665–684 acota tiempo de espera, **no** la ejecución ni su memoria.
- L400–408 y L744–762: `#leases` retiene el host mientras exista uso o suscripción; `#closeStep` evita cerrarlo con leases, waits, admissions o trabajos wake; solo cierra cuando además `sessions.active()` está vacío. `idleCloseMs` en la documentación oficial es aproximadamente **30 s**, siempre condicionado a inactividad real, no garantía de liberar en 30 s exactos.
- L773–795: `#opening` conserva el host hasta `#closeStep` o `dispose`. La reentrada reutiliza el mismo host; el reinicio del DO vuelve a abrir desde SQLite y puede reanudar trabajos no terminados.
- L843–867: `#messagesAfter` crea un array `newer` y lo expande con páginas sucesivas hasta encontrar el mensaje objetivo. Esta ruta se usa al consultar estado de una operación (`#state`, L811–837 y `settled`, L502–550). Su límite de **página** no es límite de **acumulación**: es un **riesgo concreto de pico proporcional al historial posterior al mensaje**, sin atribución de OOM todavía.
- L947–970 y 1280–1295: `sessions.list` pagina pero agrega todas las sesiones en array, incluyendo `busy()` por sesión. Lectura completa evita “sin límite” solo si se sustituye por índice del propietario/consulta limitada; #94 ya acota rutas del supervisor, no todas las rutas auxiliares.
- L1097–1113: `session.history` carga el transcript completo, página a página, en un array. L1123–1253: `session.events` suscribe, retiene `early/pending` y crea snapshot que invoca `history()`; exige `stop()`. `session.log` con `follow` también mantiene lease hasta interrumpirse/agotarse.
- L280–286: `dispose` cierra host; no borra SQLite ni constituye recuperación de efectos externos.

**Mapeo al código de aplicación de #126:** [`src/sockets.ts`](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/1268ba22f26330d619b046fcf551ca846cb69d0f/src/sockets.ts) L111–119 crea cinco colecciones de actividad; L195–206 libera locks de submit; L579–590 `#snapshot` llama `handle.history()`; L594–610 difunde snapshots al terminar cada cambio y usa mapa de deduplicación; L621–625 elimina `#activeConfigurations` y `#watches` solo al confirmar idle; L628–653 abre/cierra el stream. L263–269 `reattach` invoca `sessions.list()` si hay sockets tras reinicio. Es otra **ruta no acotada de presentación** incluso después de integrar el bloqueo de transcripts de #106. El riesgo exige solución coordinada con T05/T09 antes de cualquier aceptación de estabilidad; no sustituirlo ciegamente por `messages()` sin decidir semántica de conversación histórica.

## 13. Memoria según evento de vida y garantías

| Estado | Referencias del Harness (evidencia SDK) | Estado durable | Lo que NO sabemos |
|---|---|---|---|
| Inicialización | `#opening` host y plugins, Lifecycle y sockets | Tabla `opencode_*` abierta, root session | Heap base real del host, catálogos/plugins |
| Ejecución | `#waits`, `#admitting` durante submit, `#opening`, streams/leases, snapshots | Inbox, eventos, mensajes y jobs | Heap por tarea, proveedor, MB por isolate |
| Finalización | `#waits` retira cuando acaba, admisión se libera; host permanece hasta idle | Session y transcript persisten | Si callbacks o SDK guardan referencias adicionales |
| Cancelación | `abort` interrumpe/retira, pero los efectos pueden ser ambiguos; liberar `#waits` depende del settlement | Historial, ledger, transiciones | Cancelación confirmada de `not_found` de #90 |
| Reinicio/OOM | Se pierden referencias V8; `onStart` abre host y despierta sesiones activas; socket reattach puede listar | SQLite/colas persisten en DO | Reconciliación completa de GitHub/Containers/sesión creada sin receipt |
| Hibernación/cierre idle | El host se cierra cuando no hay uso/trabajo/streams | SQLite sobrevive; contexto V8 reabrible | Tiempo exacto real y si existen leases colgadas |

El cierre de la sesión lógica **no significa borrado de datos** ni cierre inmediato del host. Para demostrar que libera heap hay que medir ambas fases con perfil del isolate y evento de `opencode.close()`. Un `busy=false` no prueba que ningún stream o tarea adyacente retenga el host.

## 14. Benchmark R2 reproducible: 1, 2, 4 y 10

**Código propuesto y probado por ChatGPT localmente:** [`scripts/f0-c10/harness-residency-bench.mjs`](../../scripts/f0-c10/harness-residency-bench.mjs) y [`harness-residency-bench.test.mjs`](../../scripts/f0-c10/harness-residency-bench.test.mjs). Sin dependencia, sin llamadas externas, 12 combinaciones en procesos Node separados con `--expose-gc`; cada sesión procesa 160 mensajes sintéticos de aproximadamente 2 KiB. Tres modos: retención del JSON completo, anillo máximo de 20 fragmentos de 40 caracteres, o ledger liviano de coordinación.

```sh
node --test scripts/f0-c10/harness-residency-bench.test.mjs
node --expose-gc scripts/f0-c10/harness-residency-bench.mjs
```

**Ejecutado efectivamente** en Node `v22.16.0`: tests de 3 casos (incluyen las 12 combinaciones, cancelaciones y entradas inválidas): **3/3 PASS, exit 0**. Una pasada local de benchmark, con GC al tomar las muestras:

| Sesiones sintéticas | Historial completo MiB | Cola 20 MiB | Coordinador MiB | Buffer completo / acotado / coordinador |
|---:|---:|---:|---:|---:|
| 1 | 0.34 | 0.06 | 0.02 | 160 / 20 / 0 |
| 2 | 0.66 | 0.11 | 0.03 | 320 / 40 / 0 |
| 4 | 1.31 | 0.19 | 0.03 | 640 / 80 / 0 |
| 10 | 3.23 | 0.44 | 0.03 | 1600 / 200 / 0 |

Las cifras son aumento de `heapUsed` respecto al baseline del **mismo proceso individual**, no MB reales del SDK. Al vaciar referencias de host, los deltas restantes de la fixture fueron aproximadamente 0.35 / 0.07 / 0.03 MiB en la corrida de diez. El ledger y estados sintéticos permanecen íntegros al “reinicio” simulado; **no se ha probado almacenamiento SQLite ni recuperación real**. El modo coordinator no procesa modelos/Containers ni reproduce el coste de ejecutores remotos.

**Limitaciones críticas:** benchmark en **Node**, no `workerd`; no instancia `OpenCodeWorkerd` ni `agents@0.33.0` reales; no reproduce el scheduler, resnapshot, GC compartido, colisión de isolates, inferencia, sockets ni memoria Container. El `round robin` es intercalado sintético, no verdadero solapamiento de diez agentes. Resultados de una corrida y diferencias pequeñas dependen de GC/JIT. **No usar ninguno de estos MiB para extrapolar el umbral de 128 MB de Cloudflare.** No hubo dependencias instaladas ni Bun/workerd local disponible; la ejecución de CI sobre rama R2 debe identificarse separadamente.

**Instrumento de comparación posterior real:** medir V8 isolate P50/P90/P99 (métrica por isolate, **no por DO**), perfiles del heap de `OpenCodeHarness` / `OpenCodeWorkerd`, ventanas de sesión activa, `#leases` y sesiones tras `close` (sin exponer transcript), y progreso real correlacionado 1→2→4→10. En un entorno descartable con permisos posteriores, comparar acceso a `history`, `events snapshot`, `wait` y `sessions.list`, antes/después de finalizar/cancelar y tras reinicio, con exactamente el mismo SHA, dataset y modo modelo. Relacionar salida de pruebas con DO ID/trace y ¨$workers.outcome¨, costos, eventos de alerta OOM. Evitar leer historial completo en la propia telemetría.

## 15. Comparación de decisiones y seguridad

| Criterio | A. Retención actual acotada | B. Coordinador ligero + ejecutores | C. Ejecutor por objeto/Container aislado |
|---|---|---|---|
| Memoria supervisor | Mantiene host único; elimina picos de lectura | Coordinator almacena receipts/índices, no host | Idem B, distribuye trabajo; aislamiento V8 **no garantizado** |
| Complejidad | Baja, reversible por PR | Alta: RPC, idempotencia y routing versionado | Más alta: replicación/routing/Containers o Workers separados |
| Coste | Bajo si bastan guardas; mantenimiento de transcripción paginada | Mayor duración DO/mensajería, pruebas | Mayor infraestructura, snapshots, coordinación |
| Recuperación | Reusar ledger histórico | Owner fijado por tarea; journal/outbox y fail-closed | Igual B + aislamiento de datos/credenciales y fallos parciales |
| Seguridad | No permitir transcripts no acotados ni scope transversal | Propagar autorización server-side en cada salto | Además proteger cross-task egress y estado compartido |
| Reversión | No merge / revertir parche sin tocar SQLite | No reescribir sesiones históricas; volver a routing legado | Migraciones no equivalen a rollback; requiere plan de almacenamiento |
| Límite conocido | Puede saturar un isolate por host único | Puede compartir isolate entre DO | Diferentes DO de misma clase **pueden compartir isolate** |

**Decisión basada en evidencia:** **mantener A como primer candidato**, pero no declararlo suficiente para diez activos. T01 identificó el método RPC `startSupervisedTask` en seis OOM de 22/11, **sin identificar el allocador** ([#116](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/116)); T03 tiene 13 tests offline de admisión y RED de carreras sin scheduler durable implantado ([#125](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/125)). La PR #126 limita algunas inspecciones, pero `src/sockets.ts #snapshot`, el `wait()` del SDK y `sessions.list` subsisten como focos de investigación. **No** iniciar migración `v5` ni sharding hasta un perfil del host real. Si el perfil demuestra que una sola instancia mantiene un baseline/pico insostenible **después** de eliminar inspecciones no acotadas, prototipar B con ejecutor por tarea y memoria/co-residencia medidas, sin migrar datos históricos.

## 16. Patrones externos anclados a commits y licencias

| Patrón examinado | Commit fijado, ruta concreta y licencia | Aplicación limitada |
|---|---|---|
| Cloudflare Agents SDK | `agents@0.33.0` commit [`5684e278e44abfb592a6ae6ef3e2f5250feacd8c`](https://github.com/cloudflare/agents/tree/5684e278e44abfb592a6ae6ef3e2f5250feacd8c/packages/agents/src/harness/opencode); [`harness.ts`](https://github.com/cloudflare/agents/blob/5684e278e44abfb592a6ae6ef3e2f5250feacd8c/packages/agents/src/harness/opencode/harness.ts), **MIT** | Reutilizar lifecycle/SQLite/leases, no crear duplicado de Harness |
| OpenHands Software Agent SDK | [`ebec01b3893696c2f5454762eb44796c71bb391a`](https://github.com/OpenHands/software-agent-sdk/tree/ebec01b3893696c2f5454762eb44796c71bb391a/openhands-agent-server/openhands/agent_server), [README](https://github.com/OpenHands/software-agent-sdk/blob/ebec01b3893696c2f5454762eb44796c71bb391a/openhands-agent-server/openhands/agent_server/README.md), **MIT** | Servidor REST/WebSocket y ejecución remota desacoplados; no trasplantar sin considerar recuperación/auth |
| DeepSeek Harness | [`4b399c39a6d1479cd84ca591b4d7c88e24d38a96`](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/terminal), [terminal service](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/terminal/terminal/README.md), **MIT** | Owner-scoped terminal, salida acotada y separación de backend; **sesiones PTY no sobreviven al reinicio del proceso**, no atribuir durabilidad de DO |

Licencias comprobadas leyendo `LICENSE` a estos commits; **no se copió código upstream** ni se cambió una dependencia. Contratos de referencia: [Cloudflare DO Memory](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Cloudflare OpenCode docs](https://developers.cloudflare.com/agents/harnesses/opencode/).

## 17. Autoría, integridad y siguiente gate

**Escritura R2:** solo este documento y dos scripts nuevos en `f0-c10/r2-t02-harness-residency-20261122`, **base exacta #126 HEAD**, con PR draft; nada sobre `src/server.ts`, `src/sockets.ts`, `src/dev-container.ts`, configuración, bindings, migraciones ni datos. Autor ChatGPT con Node local, no OpenCode. CI de la rama R2 debe ser leída después de crear la PR; CI verde de #126 no equivale a CI del nuevo HEAD.

**No Remote con efectos:** ni lease exclusivo demostrado ni corte de gasto integral verificado. 0 sesiones reales nuevas, 0 inferencias nuevas, 0 deploy, 0 merge; gasto de GitHub Actions/API puede ser marginal y no se midió.

**Biblioteca:** NO depositar como versión final hasta verificar publicación/aceptación del reporte y los fixtures: draft GitHub no es archivo aprobado ni sinónimo de publicación canónica. Copias futuras requieren verificación de destino y contenido.

**RESULTADO:** `PARTIAL` — el SDK revela mapas y rutas residentes, cierre condicional del host y rutas con asignaciones no acotadas; prueba sintética 1/2/4/10 pasa. La arquitectura A sigue siendo viable como hipótesis; NO hay demostración de 10 activos.  
**EVIDENCIA:** commits/SHAs/CI indicados, inspección de SDK pin y fuente #126, Worker #374/MCP #19, Node test exit 0, issue #90, T01 #116 y T03 #125.  
**BLOQUEANTE:** heap real del host V8, mapas en `@opencode/sdk@2.0.24`, leak/retención tras cancelación, workerd y co-residencia, lease y coste efectivo.  
**PRÓXIMA ACCIÓN:** T01+T05 perfilar `wait()/history()/events()/sockets.` y runtime bajo controles; T03 integrar admisión idempotente; T11 conciliar las PR; solo después instrumentar un experimento workerd/Stage autorizado 1→2→4→10 y decidir B por mediciones, nunca por intuición.


---

# Parte III — Coordinación operativa R2-T02 con T01, T03, T05 y T11

**Corte de lectura:** noche del 22-11-2026 BRT / 23-11-2026 UTC. **Autor:** ChatGPT mediante GitHub/Cloudflare/Remote de lectura y CI offline; **no hubo ejecución OpenCode Remote con efectos**. **Estado:** `PARTIAL / CROSS-PR_CONTRACT_RECORDED / DEPLOY_BLOCKED`. Esta sección no eleva autoridad sobre otras ramas.

## 18. Reconciliación puntual de las PR y los dos Workers

| Responsable | Fuente leída y SHA | Contribución demostrada | Pendiente específico; no atribuir PASS runtime |
|---|---|---|---|
| T01 | [PR R2 #129](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/129), `c8afb5302252d7edce18332b602d6d4e72755d58`, sobre #126 | 18 filas de observabilidad correlacionadas en **6 OOM reales**, RPC final `startSupervisedTask`, mismo DO, fase `supervisor.phase` con **0 registros**; fase sintética RED/GREEN Node y CI offline `45096090166` success | **No hay heap/isolate cuantitativo por fase ni método causal demostrado**; fase `create/fork/setModel/submit/status/alarm` requiere instrumentos antes del siguiente lote |
| T02 | [PR R2 #128](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/128), base exacta #126 SHA `1268ba22f26330d619b046fcf551ca846cb69d0f` | Auditoría pin `agents@0.33.0` y benchmark Node 1/2/4/10, CI de integración de la rama previo al nuevo workflow: `45095780432`, `45095780437`, `45095780433` success | Hasta workerd/SDK real no hay memoria verdadera por sesión ni prueba 10 activos. Nueva CI [workflow offline T02](../../.github/workflows/f0-c10-r2-t02-residency.yml) registra las 12 combinaciones y artefacto JSON con procedencia `node-synthetic` |
| T03 | [PR #125](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/125) `3d2a7927cf50087c710c66bf1d49e7fd7b8297e1` | 13 tests de ledger/claims **solo en memoria Node**, dos fallas RED sintéticas; contrato de `requestId` idempotente | NO hay admisión durable/fencing integrada con #126; no equivale a diez ejecutores reales ni sustituye journal T04 |
| T05 | [PR #114](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/114) `4d0ec61f35920dc015b85a8561d743bb2de40a3e`, contenido incluido en #126 con #106 | Progress limitado a 128 eventos crudos, 64 visibles y 8192 bytes de proyección; #106 bloquea lectura supervisor de transcript | **Evento individual / serialización previa** aún ilimitados, `src/sockets.ts#snapshot` y `sessions.list` fuera de la protección supervisor, y ruta legacy export sin límite |
| T11 | [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126) `1268ba22f26330d619b046fcf551ca846cb69d0f` | Integración previa draft CI verde ``45093134023`/`45093134014`/`45093134038` | Integrar la PR #128 **por comparación de 4 paths T02**, no importar toda la rama de nuevo. CI del nuevo HEAD conjunto y pruebas live siguen pendientes |

**Estado Cloudflare reconfirmado por GET:** principal `opencode-g1-staging` #374 `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` / deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, MCP `opencode-staging-control-mcp` #19 `196240c0-1052-47b3-aaa7-02cf5baa87f0` / deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, ambos 100%. `staging_status` devuelve `status=ok`, `ready=true`, índice de al menos 96 sesiones incompleto. Sin prueba E2E ni memoria. Issue [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) **OPEN**.

**Nota de alcance:** la PR #129 apareció después de iniciar el trabajo #128: es nueva evidencia T01, no prueba de que existan mediciones de heap que no se hayan leído. No cambiar ramas ajenas ni combinar instrumentaciones ficticias con runtime.

## 19. Interfaces que deben coordinarse antes de un arreglo real

### A — Fases y métricas: T01 ↔ T02

Los eventos `supervisor.phase` (propuesta **NO implementada**) deben contener exclusivamente: `experiment_id`, versión Worker y SHA asociado **con evidencia de build**, `phase` enum fijo (`admit/create/fork/setModel/submit/status/alarm/recover/idleClose`), `timestampUtc`, `durationMs`, `outcome`, `traceId` y correlación anonimizada por tarea. No registrar prompt, transcript, claves, herramientas con argumentos ni strings de errores sin saneamiento. **No inventar `process.memoryUsage()` en workerd**; obtener cuantiles reales de memoria del isolate de Cloudflare y unir por tiempo/trace. El cuantíl de memoria filtrado por DO sigue siendo del isolate, posiblemente compartido.

**Atribución mínima:** comparar baseline caliente, apertura de un host nuevo, 1/2/4/10 sesiones activas instrumentadas, settlement y reposo hasta cierre; aislar en el análisis la inicialización de plugins, las lecturas y las inferencias. Si la telemetría solo dice `startSupervisedTask` en OOM, reportar `cause=UNKNOWN`. No dar porcentajes de memoria por fase sin muestras reales de esa fase.

### B — Capacidad y admisión: T03 ↔ T02 ↔ T04

Un único ledger durable debe administrar `requestId→sessionId→operationId`, huella y cambio de estado; los claims tienen epoch/fencing y no se autoriza crear otra sesión para el mismo request tras `unknown`. El semáforo/capacidad es propiedad de T03; **T02 no introduce un segundo scheduler o lease**. Aceptar límites experimentales 1/2/4 con liberación de slot **solo al estado demostrado** y permitir 10 si y solo si se certifica memoria/coste. Un `busy=true` no acredita actividad de herramienta/inferencia. El journal para creación incierta pertenece a T04; `unknown/not_found` no autoriza replay ni libera automáticamente la reserva.

### C — Lecturas, snapshots y memoria: T05 ↔ T02

**Defecto de código verificable en #126 (no demostrado como causa del OOM):** [`src/sockets.ts`](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/1268ba22f26330d619b046fcf551ca846cb69d0f/src/sockets.ts) `#snapshot` L579–590 solicita `handle.history()`; `#broadcastSnapshot` L594–610 vuelve a materializar cada resnapshot, y `#settle` L617 usa `sessions.list()`. `#onConnect` L274 y `reattach` L265 también listan todas las sesiones. **Ni #106 ni #114 acotan estas vistas**, aunque el flujo del supervisor sin sockets puede no ejecutarlas. El SDK `agents@0.33.0` materializa `history()` y el snapshot de `events()` con historial total (fuente fijada en sección 12).

**Contrato de arreglo que corresponde a T05:** API de página/cursor de mensajes antes de materializar, límite de bytes de entrada y salida **por evento y por RPC**, preservación de orden/continuidad y estado de `hasMore`; fan-out sin un transcript completo por cada cambio; cerrar streams con `stop()` al desconectar/cancelar; para cliente Android, conservar historial mediante paginación, no sustituir silenciosamente por `messages()` (que excluye partes compactadas). La salida recortada después de `JSON.stringify` es **insuficiente**. Cualquier cambio debe incluir mock de mucha historia, evento individual enorme, dos conexiones a una misma sesión, reconnect e idleClose, sin borrar datos. No eliminar historial persistido para obtener un benchmark favorable. T02 **no editó** `src/sockets.ts` ni rutas T05.

### D — Handoff a T11

La PR #128 tiene como base **#126**, por lo que el diff es específico y no vuelve a importar #106/#114/#120. El nuevo workflow offline es de pruebas, no utiliza tokens, modelos, llamadas remotas, datos DO ni secretos. T11 revisa `git diff #126..#128`, compara únicamente los nuevos ficheros y el apéndice de T02, ejecuta `bun test`, `typecheck`, build y los 12 casos sintéticos en un nuevo HEAD propio. **El CI verde de #128 no certifica ninguna modificación de #126** ni puede convertirse en merge automático.

## 20. Protocolo de perfil real propuesto, bloqueado operativamente

**Antes de crear sesiones nuevas:** registrar versión binaria efectiva de ambos Workers, revalidar código/artefactos asociados, control de acceso y scopes, lease exclusivo atómico sobre el único supervisor, presupuesto con **corte ejecutable** (no solo valor escrito), coste/tokens/rate limits verificados y ventana de prueba limitada. Requerir parada segura y reconciliación de IDs `unknown`. Una lectura `staging_status=ok` **no** concede lease ni presupuesto. Sin esos prerrequisitos, el perfil real está **BLOCKED**; se permite solo Observability read-only.

**Instrumentación sin datos sensibles:** fase/trace/epoch, `active_execution_start/end` para intervalos reales de herramienta o inferencia, orden y número de eventos/bytes **antes** de serializar, estado de leases/streams y close/reopen, percentiles P50/P90/P99 memoria isolate, OOM por versión, estado terminal y confirmación recuperable de output. No deducir `memoryUsage` por sustracción de otros DO co-residentes.

**Secuencia posterior autorizable:** baseline sin sesiones nuevas; 1→2→4→10 solicitudes independientes; en cada nivel registrar `active_execution` de cada tarea con **intersección común positiva** y validar resultados bytes/acciones. Después de finalizar/cancelar, observar baseline caliente y muestras de reposo/close, con marcas correlacionadas. Tres rondas completas de diez tareas solo tras superar preflight; detenerse inmediatamente al primer OOM, corrupción de scope, pérdida de lease, coste sin corte, resultados `unknown` o pérdida de consistencia. Ninguna etapa de este contrato fue ejecutada en Staging.

**Decisión A/B con evidencia:** conservar A si, después de limitar todas las rutas de lectura relevantes y observar CPU/memoria real, diez intervalos activos independientes terminan sin OOM/huérfanos y con margen controlado. Elevar B (coordinador ligero + ejecutores) solo ante evidencia de límite de residencia del host o contención insalvable, con contrato de routing, rollback y aislamiento verificable; objetos DO diferentes pueden compartir isolate. No proponer bindings, migraciones ni Contenedores nuevos antes de un lote aparte.

## 21. Recibo y publicación

**Rama:** `f0-c10/r2-t02-harness-residency-20261122`, desde `1268ba22f26330d619b046fcf551ca846cb69d0f`; [PR #128](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/128) draft. **Cambios R2 de esta continuación:** informe `docs/f0-c10/02_DURABLE_OBJECTS.md`, instrumento previo 1/2/4/10, pruebas y workflow offline `f0-c10-r2-t02-residency.yml`. Sin cambios `src/server.ts`, `src/sockets.ts`, `src/supervisor-control.ts`, `wrangler*`, bindings, migraciones ni datos. No merge/deploy/Producción.

**Verificación CI:** ejecutar workflow en HEAD y registrar identificadores/resultados a posteriori. Los archivos de evidencia son JSON etiquetado explícitamente `node-synthetic` y retenidos siete días; **no** se publica reporte en Biblioteca personal hasta verificar recibo de publicación. Gastos marginales GitHub/Cloudflare por lectura/CI no cuantificados; ningún modelo externo ejecutado por este encargo. Los comentarios de coordinación a las PR deben enlazar este documento con su SHA definitivo.

**RESULTADO:** `PARTIAL / HANDOFF_READY`; coordinación de interfaces verificable, pero runtime 10-active no medido.  
**EVIDENCIA:** #129, #125, #114, #126 y #128; fuentes de código, WORKER #374/MCP #19; suite 1/2/4/10 bajo CI específico.  
**BLOQUEANTE:** métricas de isolate por fase, lease+corte real, observabilidad de verdadero solapamiento, reconciliación de sesión incierta, snapshots completos.  
**PRÓXIMA ACCIÓN:** T11 incorporar el contrato sin duplicar la integración; T01 y T05 medir/limitar rutas indicadas y T03 aportar claim durable, en PR propias y sin despliegue. Después solicitar autorización **separada** de preflight/Stage E2E bajo controles, no ejecutarlo automáticamente.

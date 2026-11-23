# F0-C10/T03 — Admisión, concurrencia y reconciliación

**Corte:** 2026-11-22, lectura en esta sesión (BRT). **Actor:** ChatGPT (GitHub/Cloudflare/OpenCode Remote lectura; Node offline). **Estado:** `PARTIAL`, no `PASS` del subsistema ni `COMPLETE PASS` global. **No desplegado / no merge.**

## 1. Evidencia, autoridad y versiones

- Fuente auditada: `aamvtrampa36-del/opencode-harness-example`, rama `staging/opencode-g1-rpc-safe-20261120`, **HEAD `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`**. Archivos leídos al SHA fijo: `src/server.ts`, `src/supervisor-control.ts`, `src/staging-control-mcp/server.ts`, `src/supervisor-workflow.ts`, pruebas, `src/github.ts` y `package.json`. No se usó `main` como fuente de Staging.
- Cloudflare GET deployments: principal `opencode-g1-staging`, deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` al 100 %. MCP `opencode-staging-control-mcp`, deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, versión `196240c0-1052-47b3-aaa7-02cf5baa87f0` al 100 %. Identidad de runtime, **no** demostración byte a byte de coincidencia con el source.
- Remote `staging_status`: `status=ok`, `ready=true`, `schema=opencode.staging-control.v2`, `supervisedSessions=96`, `supervisedCountComplete=false`; no implica 96 activos.
- [Issue #90: reproducción 22/11](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558): **10 solicitudes de inicio, 0/10 resultados verificados; 6 errores OOM de inicio; 4 en `preparing` canceladas; 2 sesiones `unknown/not_found`**. `a642be2611220007` y `a642be2611220009` obtuvieron sesión pese a fallar su RPC de inicio.
- Contexto documental: `F0_C10_PLAN_INTEGRAL.md`, `03_OPERACION_Y_PERMISOS.md`, `04_PRUEBAS_COSTES_Y_RIESGOS.md`. PR #91/#94 contienen lecturas acotadas; PR #106 es candidata no desplegada según cortes consultados.

## 2. Flujo exacto vigente: requestId → tarea → sesión → operación → resultado

1. MCP `staging_start_task`: ID hexadecimal de 16 caracteres; el supervisor fijo es `opencode-supervisor-v1`. Autenticación externa y guard server-side `OPENCODE_SUPERVISOR_ENABLED=true`.
2. `startSupervisedTask` valida repositorio en allowlist y modelo, normaliza el prompt. `supervisorFingerprint`: SHA-256 del repo normalizado, prompt, modelo o `economy` y sesión origen. Registro `supervisor:task:<id>`.
3. Reserva mediante `ctx.storage.transaction`: si existe con huella diferente rechaza; si coincide reutiliza. Nuevo registro `preparing`, proyecto `supervised-<id>`, rama `opencode/staging-<id>` para el propio repo. **No hay cola global durable ni contador de ejecutores en esta ruta.**
4. `withSupervisorStartLock`: lock por ID con token y caducidad **60 segundos**. Evita carreras dentro de ese plazo, pero no pone fencing sobre efectos externos que puedan seguir después.
5. `advanceSupervisedTask`: GitHub `ensureSupervisorBranch` → guarda SHA base → `harness.sessions.create()/fork()` → asocia scope → escribe `supervisor:session:<ses>` → escribe `job.session` → agente/modelo → almacena `operationId=rc-start-<id>` y `status=running` antes de `handle.submit(...,{operationId,whenBusy:'followUp'})`. Si la respuesta se pierde, marca `unknown`.
6. `staging_task_status` lee registro por ID, `handle.wait` con límite 120ms, `busy`, log incremental acotado y clasificación. Recibo nativo `done` → `finished`; `unanswered/not_found` → `unknown`. Devuelve `passed:false,verified:false`, por lo que `finished` no acredita resultado funcional.
7. `staging_cancel_task` actualmente confirma `cancelled` si no figura `job.session`. **No prueba** ausencia de sesión externa creada antes del commit durable.

```mermaid
flowchart TD
  A[RPC requestId y contenido] --> B[Validar y fingerprint]
  B --> C{¿Existe tarea?}
  C -->|Huella distinta| X[Rechazo por conflicto]
  C -->|Misma huella| R[Devolver tarea original y estado]
  C -->|Nueva| D[Reserva durable preparing]
  D --> E[Lock por ID 60 s]
  E --> F[GitHub ensure branch]
  F --> G[SDK create/fork session]
  G --> H[Guardar session ID y scope]
  H --> I[Guardar operationId nativo]
  I --> J[Submit]
  J --> K[Respuesta o pérdida]
  K --> L[Status/progress por requestId]
  L --> M{Recibo nativo y progreso}
  M -->|done| N[finished sin verificación]
  M -->|not_found| U[unknown sin auto reintento ciego]
```

## 3. Riesgos y carreras en el código

| Frontera | Riesgo | Invariante propuesto |
| --- | --- | --- |
| Reserva `preparing`/HTTP | La respuesta puede perderse tras guardar el registro | Reconsultar mismo `requestId`; no asumir rechazo |
| Lock de 60s / efecto externo | Un lock vence mientras otro starter sigue vivo | Fencing persistente o estado ambiguo; **no** solo ampliar TTL |
| `sessions.create/fork` → `job.session` | Sesión huérfana, posible segunda creación tras restart | ID determinista de sesión o journal `create_intent` y reconciliación SDK |
| `supervisor:session` y `job.session` | Dos commits separados: mapeo parcial | Commit coordinado de información bajo autoridad del supervisor |
| `running` antes de submit | `running` sin aceptación; `not_found` ambiguo | `submit_intent`, receipt nativo, sin auto reenvío |
| `catch` de init marca `failed` | Puede haber efecto parcial externo | `unknown` si existe efecto incierto |
| Cancel sin sesión guardada | Confirmación `cancelled` posiblemente falsa | Confirmar ausencia de efecto o dejar `unknown` |
| Directory `limit:101` / `busy` | Recuento incompleto y sin actividad demostrada | Telemetría de herramientas/inferencia por operación |

Son ventanas de carrera observables en el diseño actual y reproducibles en un modelo sintético, **no prueba de causalidad del OOM**. T04 debe resolver recuperación profunda, y T02 memoria/aislamiento.

## 4. Máquina de estados

**Actual:** `preparing`, `running`, `finished`, `unanswered`, `failed`, `cancel_requested`, `cancelled`, `unknown`. No fases `queued/claimed`.

**Propuesta, NO aplicada:**

```mermaid
stateDiagram-v2
  [*] --> received
  received --> queued: commit huella + secuencia
  received --> rejected: sin side effects
  queued --> claimed: slot + fencing
  claimed --> initializing: journal antes de efectos
  claimed --> unknown: efecto incierto
  initializing --> running: sesión/operation receipt
  initializing --> unknown: crash o timeout
  running --> unknown: respuesta perdida
  running --> finished: resultado verificado
  running --> failed: fallo confirmado
  queued --> cancelled: sin efecto externo
  running --> cancel_requested
  cancel_requested --> cancelled: abort confirmado
  unknown --> running: receipt autoritativo
  unknown --> finished: receipt + verificación
```

`unknown` debe sobrevivir al TTL y no liberar automáticamente un trabajo que pudo ejecutar efectos. `queued` es trabajo aceptado y persistido; `BACKPRESSURE` ocurre antes de admitirlo, nunca se disfraza de tarea aceptada.

## 5. Contrato idempotente y capacidad

- Clave: `(workspace supervisor, requestId)`. Misma huella normalizada devuelve misma tarea y progreso sin crear otra; huella diferente rechaza **antes de efectos**, también si cambia modelo o `sourceSession`. Distintos IDs permiten tareas distintas aunque el prompt coincida.
- `operationId=rc-start-<requestId>` se conserva. **No** equivale a exactly-once si SDK/native receipts se han perdido: `not_found` no autoriza otro submit.
- Admisión durable mínima: reserva de huella, orden FIFO y estado bajo transacción atómica del único owner. Un despachador acotado toma trabajos con leases/fencing; registra intento antes del efecto y exige recibo para confirmar ejecución. No añadir Cloudflare Queues ni Workflows como segundo scheduler sin benchmark.
- Capacidad es **dinámica y medible**, sin tope permanente de dos. El modelo offline usa `runningCapacity=10` y permite verificar que 10 claims son posibles, **no** que exista memoria/inferencia suficiente para ejecutarlos. Un límite 1/2/4 en ensayos es temporal; F0-C10 exige 10 activos observados.
- Fairness: orden FIFO por secuencia durable dentro del nivel de prioridad; evitar confiar en orden de `Promise.all`. Políticas multi-tenant y provider rate limit se tratan cuando haya medición. Un slot `unknown` puede mantenerse ocupado por seguridad hasta reconciliarse, con telemetría y intervención, no por siempre silenciosamente.
- La capacidad/cola controla aceptación, no memoria compartida de Durable Objects. Si diez sesiones SDK saturan un isolate, T02 debe distribuir ejecución sin duplicar el ledger de admisión.

**Comparación:** (A) ledger transaccional + dispatch limitado dentro del DO existente — coste/complexidad menor, primera opción sujeta a pruebas; (B) cola externa + workers propios — más componentes y doble reconciliación; considerar solo si se demuestra el límite estructural de A.

## 6. Pruebas RED/GREEN reproducibles

`scripts/f0-c10-t03/admission.mjs` es un **modelo de referencia offline in-memory**, no código usado por el supervisor. Serializa transacciones sintéticas, aplica fingerprint y conflictos, FIFO, backlog, claims con capacidad configurable (10 default), operación determinista, `unknown` sin autorreintento, progresos secuenciales y `finished` verificado. Token de claim `claim-N` es solo un fixture; **no fencing real para producción**.

`node --test scripts/f0-c10-t03/admission.test.mjs` (Node 22.16.0): **13 PASS / 0 FAIL / exit 0**. Cubre 10 admitidos concurrentes, 100 retries idénticos, huella diferente, FIFO, backlog completo, límites 2/10, pérdida de respuesta, OOM, `not_found`, conflicto de claim, recibo done no verificado, secuencia de progreso y escalera 1→2→4→10. Que 10 claim reciban progreso sintético NO es evidencia de diez procesos reales.

`node --test scripts/f0-c10-t03/known-red.red.mjs` (ejecución separada): **2 FAIL esperados / exit 1**. Simula (1) crash después de `sessions.create` y antes de guardar sesión: dos sesiones en vez de una; (2) lock vencido 60s con efecto anterior vivo: `peak=2` starters para un ID. **Son simulaciones source-shaped**, no pruebas del Durable Object. El fichero `.red.mjs` se ejecuta deliberadamente fuera de la suite verde.

**Estado del cambio:** se agregó instrumento de prueba aislado y documentación, **no adaptador durable**, sin modificaciones `src/server.ts`. No se ejecutaron Bun/typecheck/build localmente: Bun no está instalado en el entorno offline. CI del HEAD es gate separado. Se evita introducir una cola prematura y convertir falsamente F0-C10 en dos ejecutores.

## 7. Métricas para demostrar 10 ejecuciones reales

Separar `received`, `admitted`, `queued`, `claimed`, `running_receipt`, `busy_verified`, **`active_execution`**, `finished_verified`, `unknown`, `orphan_count`, `reconciled`, `OOM`, `capacity_rejected`, `retry/dedupe`. Cada evento debe portar `experiment_id,requestId,taskId,sessionId,operationId,executorId,branch,baseSHA,workerVersion,timestamp,seq,tool/inference kind,exitCode`, evitando salidas/secretos grandes.

Exigir diez intervalos de **actividad instrumentada real** de ejecutores distintos con intersección temporal positiva y avances correlacionados del log dentro de la ventana, seguidos de diez resultados recuperables y correctos. `peakRunning=10`, `busy=true`, diez MCP starts o diez filas en cola NO bastan. Medir también `queueWaitMs p50/p95`, ocupación, fairness, OOM, reconciliación, coste por tarea y entregas verificadas.

## 8. Validación progresiva y STOP

1. **Offline, hecho para modelo:** 13/13 GREEN, 2/2 RED esperados. A continuación tests de integración sobre DO real: inyectar fallo antes/después de cada `await` de branch/session/submit y verificar journal + unicidad tras restore sin segunda operación.
2. **PR/CI:** `bun test`, `bun run typecheck`, `bun run build`, invariantes del HEAD y revisión de cambios T02/T04. RED separado no se debe confundir con suite verde.
3. **Staging 1→2:** posterior lote que verifique reserva atómica exclusiva, coste con corte efectivo, SHA/source↔deployed, memoria; este T03 no realizó tareas Remote por falta de esas precondiciones.
4. **Staging 4→10:** solo en integración autorizada, instrumentar diez verdaderamente activos, tres rondas con 10/10 resultados, sin OOM/huérfanos/duplicados, incluyendo errores negativos y recuperación. El gate no admite limitación permanente a dos.
5. **STOP:** estado `unknown` sin ruta segura, OOM, SHA ambiguo, permiso/scope inválido, coste no acotable, pérdida del lease, nuevo side effect, output sin límite. Nunca reiniciar con requestId nuevo después de timeout.

No se llamó `staging_start_task`, `staging_agent_check` ni a modelos. No mutaciones Cloudflare, Production, main, migraciones, secrets, merge o deploy.

## 9. Investigación externa

- [Cloudflare Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/): `await` de red intercalable pese al thread único; transacción para read-modify-write.
- [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/): durabilidad y evicción.
- [Celery optimizing/prefetch](https://github.com/celery/celery/blob/main/docs/userguide/optimizing.rst): distinguir prefetch de slots reales.
- [SQS FIFO deduplication](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fifo-queue-message-identifiers.html) y [outage recovery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/designing-for-outage-recovery-scenarios.html): idempotencia y ventanas de visibilidad limitadas.
- [Temporal worker options](https://github.com/temporalio/sdk-typescript/blob/main/packages/worker/src/worker-options.ts): capacidad de worker distinta de backlog. No se adapta una plataforma completa.
No se copió código de terceros ni se agregaron dependencias.

## 10. Handoff y aceptación

**T04:** investigar ID determinista `sessions.create/fork`, `create_intent`, binding durable, receipt nativo y cancelaciones prematuras. **T02:** medir memoria con sesiones concurrentes y aislar ejecutores si es necesario. **T10:** no contar `busy` sin intervalos de actividad reales. Las PR de otros especialistas pueden coexistir; este T03 no modifica su código ni el registro común.

**PASS T03** solo con adaptador productivo durable y fencing real, pruebas de fallos RED→GREEN reproducibles de admisión/reconciliación, CI del HEAD, sin tareas inaccesibles o duplicadas. Actualmente **`PARTIAL`**. **`COMPLETE PASS` global** requiere además E2E autorizado diez actividades verdaderamente solapadas y outputs verificados, 3 rondas, métricas/costes e integridad.

**Recibo maestro:** `F0-C10/T03 | PARTIAL | Actor ChatGPT | Source 11161dd6f2c4b5237a2da59d7275ff693e0afdbe | Worker 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb | MCP 196240c0-1052-47b3-aaa7-02cf5baa87f0 | Node offline GREEN 13/13 exit0 | RED sintético 2/2 exit1 | Remote nuevos requestId/sessionId/operationId: ninguno | Inferencia nueva: ninguna | No deploy/merge | Próxima acción: coordinar T04 e integrar journal/claims reales bajo pruebas, antes de lote Stage`.


---

# R2-T03 — Admisión durable y fencing integrado en candidato (2026-11-22/23)

**Autor:** ChatGPT mediante GitHub. **Origen de comparación:** PR #126, HEAD `1268ba22f26330d619b046fcf551ca846cb69d0f` (draft/no desplegada). **Entrega R2:** [PR #135](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/135), rama propia `f0-c10/r2-t03-durable-admission-20261122`, apilada sobre #126 (no modificar su rama). **Estado:** candidato integrable, `PARTIAL / NOT RUNTIME VERIFIED`.

## R2-A. Decisión de diseño y superficie de código

Se implementa un **único registro de admisión**, `src/supervisor-admission.ts`, en `ctx.storage.transaction` del **mismo** Durable Object supervisor. No se añade Cloudflare Queues, otro DO scheduler, Workflow ni proveedor. El límite de protección del candidato es **10 reservas concurrentes** (constante local `DEFAULT_CAPACITY=10`), NO un límite permanente de dos y NO prueba de diez inferencias ejecutándose. La política de proveedor/presupuesto pertenece a T07 y debe consultar el mismo `requestId` y estado, sin reserva separada de trabajos.

Se extiende `src/server.ts` en los puntos de entrada: `reserveSupervisorAdmission` reemplaza la reserva sin contador; los cuatro efectos externos relevantes quedan protegidos con escritura de intención **anterior a RPC** y acuse explícito: `github_branch`, `session_create`, `configure`, `submit`. El lock local por ID existente continúa como exclusión de llamada; la **autoridad de fencing** es el registro persistido, no la vigencia de ese lock de 60 s. Se rechazan generaciones/tokens antiguos incluso si el lock se ha liberado o vencido. No se exponen tokens en recibos públicos.

El ledger `supervisor:admission:v1` es **acotado a diez slots**, mantiene solo solicitudes que ocupan capacidad; la identidad/digest permanente permanece en `supervisor:task:<id>`. La reserva transaccional guarda simultáneamente tarea y slot. Un onceavo ID recibe `accepted:false,status:capacity_rejected,reason:CAPACITY_EXHAUSTED,retryAfterMs:1000`, **sin crear** registro ni efecto; el cliente puede reintentar con el **mismo** ID. La capacidad solo se libera si un estado terminal ya está persistido y el slot no permanece `effect_unknown`. Los estados ambiguos consumen capacidad visiblemente: no se reciclan silenciosamente.

**Caveat:** esta primera integración **no** sustituye el trabajo pendiente de T04: un `session_create` que devolvió error tras crear una sesión puede permanecer `effect_unknown` hasta reconciliación externa. Una espera indefinite evita doble gasto pero puede bloquear capacidad; es intencional y se señala como incidente operativo, no se denomina recuperación completa. El candidato tampoco cuenta en su ledger inicial las tareas legacy anteriores: su reentrada queda conservadoramente bloqueada (`LEGACY_RECONCILE_REQUIRED`). Un rollout real exige plan de bootstrap/migración sin modificar DO existentes bajo esta autorización.

## R2-B. Contrato de identidad y flujo

```mermaid
flowchart TD
  A[staging_start_task requestId] --> B[Validación allowlist + SHA256 fingerprint]
  B --> C{Transacción ledger y task}
  C -->|mismo id huella distinta| X[Conflict sin efecto]
  C -->|mismo id existente| R[Receipt previo / UNKNOWN]
  C -->|slots 10| P[capacity_rejected sin tarea]
  C -->|slot libre| D[task preparing + grant token generation]
  D --> E[Start lock auxiliar]
  E --> F[beginEffect durable]
  F --> G[GitHub / session SDK / configure / submit]
  G -->|recibo positivo| H[ackEffect durable]
  G -->|crash timeout sin recibo| U[effect_unknown conservado]
  H --> I[Próxima etapa con el mismo grant]
  I --> F
  H --> J[submit confirmado - running]
  J --> K[status/progress y receipt nativo]
  K -->|done / respuesta real| L[terminal persistido; slot liberable]
  K -->|not_found| U
```

**Máquina del control de admisión:** `reserved → effect_unknown → reserved` para GitHub/session/configure acreditados; `effect_unknown(submit) → running` solo tras receipt de `submit` o `wait` nativo inequívoco, nunca con `not_found`. `running → terminal` se refleja en la tarea T04/supervisor y se recoge al admitir la siguiente solicitud. `reserved` no usado puede reclamarse al vencer lease con **generación aumentada**; el viejo actor pierde el derecho a comenzar nuevos efectos. `effect_unknown` **nunca se reclama por TTL**. El cierre de tarea observable sigue la máquina T04, no nace una máquina de resultados separada.

**Fingerprint (sin cambio):** SHA-256 de repositorio normalizado, prompt recortado, selección de modelo (`economy` por defecto) y sesión origen. Mismo `requestId`+huella devuelve registro anterior, nunca reenvía el submit si la operación es dudosa. Mismo ID con huella distinta = error. `operationId=rc-start-<requestId>` no reemplaza la prueba de recibo nativo.

**Interfaces propuestas a T04:** `reserveSupervisorAdmission(storage,task,now)`, `supervisorBeginExternalEffect(storage,grant,effect,now)`, `supervisorConfirmExternalEffect(storage,grant,effect,receipt,now)`, `reconcileSupervisorSubmittedEffect(storage,id,operationId,nativeReceipt)`, `hasSupervisorAdmissionSlot(tx,id)` y `supervisorAdmissionSlot(storage,id)`. El primer método mantiene `supervisor:task:<id>` como registro T04 autoritativo, el último devuelve copia de observación; los campos `token/generation` son **internos**, jamás instrucciones de cliente. T04 debe completar la conciliación del `sessionId` perdido y races continue/cancel con estas mismas transacciones, sin un segundo journal de capacidad.

**Interfaz a T07:** consulta de disponibilidad de inferencia y corte de gasto efectivo **antes** de permitir `submit` cuando exista un controlador efectivo. Un límite RPM del proveedor **no** debe cambiar retroactivamente `requestId` ni crear un segundo registro de trabajos. Hasta ese controlador, esta rama no permite validación live pagada.

## R2-C. Casos RED/GREEN

- **RED histórico reproducido, no reinterpretado:** `scripts/f0-c10-t03/known-red.red.mjs` contiene los dos fallos sintéticos originales (2 FAIL esperados): sesión duplicada tras crash entre creación y persistencia; dos starters activos por TTL del lock viejo. Siguen siendo tests de la ruta anterior y no se incluyen en la suite verde estándar.
- **GREEN de referencia R1:** `scripts/f0-c10-t03/admission.test.mjs` 13/13 PASS offline (in-memory; no DO).
- **GREEN de unidad R2 en candidata:** `src/supervisor-admission.test.ts` usa store sintético serializado con rollback de transacciones y ejercita 14 casos: 10 reservas + rechazo del 11.º, dos solicitantes del mismo ID, 100 retries y huella diferente, expiración sin efecto con nuevo fencing, TTL con efecto incierto inamovible, reinicio/restauración de storage, etapas con ack, acuse falso, liberación tras terminal, ausencia de slot legacy, cancelación, ledger corrupto, 1→2→4→10 y `not_found` sin reconciliación frente a `done` positivo. **La ejecución CI del HEAD debe verificarse aparte**: escribir estos tests no es afirmar que ya pasaron.
- **Limitación:** el test dobla la interfaz `DurableObjectStorage.transaction` pero **no** ejecuta workerd, SQL real, Harness ni diez operaciones de inferencia. La integración `src/server.ts` todavía necesita pruebas de fallo inyectado en la propia ruta de RPC y análisis de T04/T07. No se infiere la causa OOM.

## R2-D. Investigación de código abierto (código y licencia verificados)

Los siguientes repositorios fueron leídos en commits **anclados** con sus archivos de licencia; se **reutilizó el patrón**, no se copió su código ni se añadieron paquetes.

| Proyecto / commit y código | Licencia observada | Patrón y límites |
| --- | --- | --- |
| [BullMQ `20e2abb0daa434c3a56ad9b07b8a61d09a16bfe6`](https://github.com/taskforcesh/bullmq/tree/20e2abb0daa434c3a56ad9b07b8a61d09a16bfe6), `src/classes/worker.ts`, `src/commands/moveToActive-11.lua` | MIT, archivo `LICENSE` leído en ese SHA | Operación de mover a activo y lock en Lua/Redis; lock vencido no prueba exactly-once de GitHub/LLM. No incorporar Redis. |
| [Graphile Worker `b4f1b41c7abd747586879bf68a46a5a22897fa96`](https://github.com/graphile/worker/tree/b4f1b41c7abd747586879bf68a46a5a22897fa96), `src/runner.ts` | MIT, `LICENSE.md` leído | Worker pool con captura transaccional de jobs; depende de PostgreSQL/Node; no compatible directamente con DO. |
| [Temporal TypeScript `f5107ac96256c217cccf98cff278175bfa35b21e`](https://github.com/temporalio/sdk-typescript/tree/f5107ac96256c217cccf98cff278175bfa35b21e), `packages/worker/src/worker-options.ts` | MIT, `LICENSE` leído | Separa límites de tareas/workers, ejecución y pollers. Su worker Node nativo no se traslada a workerd sin una plataforma nueva. |
| [Cloudflare Durable Object transaction rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) | Documentación de plataforma, no código incorporado | Input/output gates y transacción; await de red permite intercalado y exige fencing antes de side effects. |

## R2-E. Riesgos restantes, gates y no autorización

1. **Typecheck/CI**: aceptación de esta rama solo con resultados de Actions cuyo `head_sha` coincida con la última revisión y pruebas focales nuevas. Un CI verde en #126 no valida automáticamente R2.
2. **E2E de fallos:** inyectar reinicios entre `beginEffect`/SDK/ack, comprobar el almacenamiento de la sesión y una única ejecución real; **no** efectuado en este encargo.
3. **T04:** reconciliar sesiones creadas sin identificador persistido, señal de aborto y `continue` bajo el mismo grant, evitar cancel falso, añadir limpieza/recuperación autorizada. `effect_unknown` consume slot hasta prueba positiva.
4. **T07:** límite de proveedor, presupuesto y corte efectivo; no se activó inferencia ni se gastó en Remote.
5. **Memoria T01/T02:** diez reservas técnicas no demuestran que diez SDK sessions quepan en el isolate. La observación de diez actividades reales y resultados finales pertenece a T10 y al gate E2E global.
6. **Integración T11:** revisar conflicto potencial con R2 T04/T05 y R2 T08 (fencing de PR en `src/github.ts`). No se alteraron esas ramas.

**Resultado a comunicar al maestro:** `R2-T03 PARTIAL; PR #135 draft desde #126; durable admission + fencing integrado en candidata; CI HEAD pendiente; Stage sin cambios; zero starts/remote inference; presupuesto sin corte; falta E2E/T04/T07`. **No MERGE / NO DEPLOY / NO COMPLETE PASS.**

**CI R2 focal:** workflow `.github/workflows/f0-c10-r2-t03-admission.yml`, permisos `contents:read`, solo Bun 1.4.4, suites de admisión/T04, typecheck/build e invariantes, sin Cloudflare/Remote. La PR puede apuntarse temporalmente a Staging para disparar CI de revisión, pero debe volver a base #126 antes de entregar; ningún resultado será declarado sin run y SHA exactos.

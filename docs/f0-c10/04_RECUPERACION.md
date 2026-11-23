# F0-C10/T04 — Recuperación e idempotencia del supervisor

**Corte de investigación:** 2026-11-22 (America/Sao_Paulo). **Veredicto:** PARTIAL / NO COMPLETE PASS.  
**Actor ejecutor de la reparación:** ChatGPT en esta conversación (edición mediante el conector GitHub + pruebas sintéticas offline). **OpenCode Stage:** solo lectura; no se inició una ejecución con efectos.  
**Repositorio:** [opencode-harness-example](https://github.com/aamvtrampa36-del/opencode-harness-example); **issue:** [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90); **PR draft:** [#120](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/120).  
**Rama candidata:** `f0-c10/t04-recovery-20261122`; **base:** `staging/opencode-g1-rpc-safe-20261120` @ `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`. El HEAD final y CI deben verificarse en #120. No se fusionó ni desplegó.  
**Staging leído:** Worker principal deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, version `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`; MCP deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, version `196240c0-1052-47b3-aaa7-02cf5baa87f0` (ambos al 100 %, lectura de Cloudflare). **La rama candidata no es ninguno de esos deployments.**

## 1. Resultado mínimo y frontera

Se corrigió de forma acotada la confirmación indebida de cancelación cuando **no existe `sessionId` persistido pero la creación de sesión pudo haber ocurrido**. El candidato registra `sessionCreationAttempted` **antes** de `sessions.create/fork`, prohíbe repetir ese RPC cuando falta el recibo, y confirma cancelación previa a la sesión solo si hay marcador explícito `false` y no existe un lock de arranque. Se mueve la persistencia de `sessionId` inmediatamente después de `create/fork`; además, `failed` con `operationId` pasa por conciliación nativa en status en vez de tratarse siempre como terminal.

**Garantía demostrable en el modelo local:** un intento de creación con respuesta perdida no se repite automáticamente; cancelar antes de crearlo exige evidencia durable, y `not_found` sigue siendo desconocido. **No demostrado:** recuperación de un identificador de sesión perdido, ausencia de sesiones huérfanas históricas, exactamente una ejecución de herramientas o GitHub, E2E tras OOM, ni diez tareas simultáneas. El compromiso deliberado es preferir `unknown` a inventar `cancelled` o gastar ejecutando dos veces.

## 2. Evidencia del incidente y correlación real

En el [ensayo de diez inicios del 22-11-2026](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558) hubo **0/10 resultados verificados**, seis errores de memoria en `staging_start_task`, cuatro tareas `preparing` posteriormente canceladas y dos solicitudes que sí crearon sesiones aunque devolvieron error. Las dos se mantuvieron ambiguas con `operationReason=not_found`.

Se releyeron, **sin modificar estado**, registros del mismo Staging:
- `requestId=taskId=a642be2611220007`, `sessionId=ses_dfb84a03fffe6UkLfquJbEzo45`, `operationId=rc-start-a642be2611220007`, estado `unknown`, reason `not_found`. Progreso: `session.agent.selected`, `session.model.selected`, `log.synced`; no recibo de operación final.
- `requestId=taskId=a642be2611220009`, `sessionId=ses_dfb8440c0ff8lpihvjExKr6NBg`, `operationId=rc-start-a642be2611220009`, estado `unknown`, reason `not_found`. Mismo patrón de tres eventos.
- `a642be2611220002`: estado `failed` y 53 eventos de progreso, incluyendo `session.inbox.enqueued`, `session.execution.started` y `session.tool.success`. Un fallo de tarea no implica que ninguna herramienta tuviera efecto.
- `a642be2611220005`: estado histórico `cancelled` sin `sessionId` consultable. No se usó esa respuesta anterior como prueba independiente de que `sessions.create` nunca ocurriera.

La evidencia de `Continuing after restart` corresponde a la exportación histórica registrada en #90. No se volvió a materializar el transcript completo: la ruta MCP activa conserva riesgos de carga de historial identificados en [PR #112](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/112), y una cadena de reinicio **no prueba por sí sola** que GitHub, Linux o la operación hayan sido recuperados exactamente una vez. Los eventos de progreso sí permiten acotar actividad y confirmar que no hay recibo final en #7 y #9.

## 3. Almacenamiento y transiciones observadas en código

Autoridad de esta reconstrucción: `src/server.ts`, `src/supervisor-control.ts`, `src/github.ts` en el SHA base indicado. Las claves viven en el storage del DO supervisor, no en una transacción entre Cloudflare, GitHub y el SDK.

- `supervisor:task:<requestId>`: recibo durable de tarea (fingerprint, proyecto, rama, estado, commit base, `session`, `operationId`).
- `supervisor:lock:<requestId>`: lock de arranque por token (TTL 60 s); su expiración **no acredita** que un RPC externo no siga ejecutándose.
- `supervisor:session:<sessionId>`: índice inverso a tarea; `scopeStorageKey(sessionId)`: alcance de proyecto/repositorio.
- `supervisor:turn:<requestId>:<turnId>`: hash de instrucción + `rc-turn-...` para deduplicación lógica.
- `supervisor:tool-counts-v1:<requestId>`: cursor y contadores del log incremental, transactional fold de hasta 256 eventos por lectura.
- Historial/inbox/receipt nativos del Harness: almacén separado desde la perspectiva del código; no existe una transacción distribuida que abarque todas estas escrituras y los efectos de GitHub/Container.

| Situación/transición | Evidencia durable previa | Operación externa | Resultado legítimo | Recuperación / cautela |
|---|---|---|---|---|
| HTTP recibido → `preparing` | Reserva `supervisor:task` + fingerprint transaccional | Ninguna aún | `preparing` | Repetir mismo `requestId`/payload retorna mismo registro; payload distinto rechazado |
| `preparing` → rama fijada | Task + lock de arranque | `ensureSupervisorBranch` en GitHub | `preparing` con `baseCommit` | Reconsultar rama de nombre fijo y SHA exacto; no forzar actualización |
| Rama fijada → creación solicitada | **Nuevo:** `sessionCreationAttempted=true` persistido | `sessions.create/fork` | `preparing` o `unknown` | Sin `sessionId` recibido: `unknown` y **no repetir create/fork** |
| Sesión creada → vinculada | Task guarda `sessionId` antes que scope/índice | `bindSessionScope`, índice inverso | Sesión vinculada | Hueco entre efecto y guardado aún posible; auditar si hay orphan |
| Configuración → `running` | `operationId=rc-start-<requestId>` guardado antes del submit | `session.submit` | `running` si recibo; `unknown` si se pierde | Conservar ID fijo. Contrato nativo de deduplicación requiere test de fallo real |
| `running` → `finished` | `operationId` y recibo `done` | Lectura `wait`/log/busy | `finished` | `passed=false` y `verified=false` hasta auditoría; NO éxito automático |
| `running` → `failed` | Recibo `unanswered(reason=failed)` | Lectura nativa | `failed` | Error terminal auténtico de esa operación; no repetir herramientas automáticamente |
| `running` → `unknown` | `unanswered(reason=not_found)` o espera inconclusa | Lectura nativa | `unknown` | No inferir que la operación nunca existió; usar IDs/progreso/efectos correlacionados |
| `running` → `cancel_requested` | `sessionId` + `operationId` + intención guardada | `abort(operationId)` | `cancel_requested` | `abortAccepted` no prueba cancelación terminal |
| `cancel_requested` → `cancelled` | Recibo `unanswered(reason=interrupted)` de esa operación | `wait` | `cancelled` confirmado | Si es `not_found` o error de consulta: `unknown`/no confirmado |
| Sin sesión → petición de cancelación | Marcador `sessionCreationAttempted=false` y **sin lock** en lectura transaccional | Ninguna | `cancelled` confirmado | Si marcador ausente/true o lock presente: `unknown`, sin confirmación ficticia |
| Nuevo `turnId` → continuación | Ledger `supervisor:turn:...` con hash/ID | `submit(..., whenBusy=steer)` | `submitted` o `unknown` | Ventana adicional: el task guarda nuevo `operationId` **después** de submit; pendiente hacer journaling y arbitraje de steers |

`cancelled` no se obtiene por traducir indiscriminadamente `unknown`, `not_found` o `busy=false`. El estado `unanswered` es un recibo nativo, no una afirmación de PASS.

## 4. Ventanas de fallo e idempotencia

| Punto de corte inyectable | Side effect antes de persistir respuesta | Duplicación / huérfano posible | Manejo actual/candidato |
|---|---|---|---|
| Reserva de tarea antes de HTTP response | Solo storage local | Respuesta perdida, no doble reserva | Transacción por `requestId` + fingerprint |
| GitHub branch POST antes de guardar `baseCommit` | Rama ya creada | Error/repetición de POST | `ensureSupervisorBranch`: get ref, comprobar SHA y reutilizar |
| `sessions.create/fork` después del marker, antes de guardar ID | Sesión creada sin referencia en task | **Sí**, antes se podía re-crear | **Candidato:** se bloquea replay, queda `unknown`; falta resolver orphan |
| `bindSessionScope` / índice inverso | Sesión creada, scope parcialmente escrito | Registro incompleto | Guardar `sessionId` primero disminuye ventana, sin atomicidad global |
| `submit(rc-start-ID)` antes de response | Inbox recibió instrucción, incluso con herramientas | Reejecutar modelo/herramientas si la dedupe nativa falla | Key estable antes de submit; requiere E2E de idempotencia del SDK |
| `continue(turnId)` tras ledger, antes de actualizar task | Steer admitido y task apunta a operación antigua | Pérdida de correlación/steers concurrentes | **Pendiente:** journal de turn + CAS/serialización |
| GitHub `write` POST/PUT con respuesta perdida | Commit creado | Commit duplicado si se reenvía distinto | Bridge lee antes de PUT y reutiliza contenido idéntico; no exactamente-once general |
| GitHub `pr` POST antes de respuesta | PR creada | PR duplicada en reintento | Preflight rechaza PR ya abierta en misma rama; consultar por head antes de reintentar |
| `cancel_requested` antes/tras `abort` | Abort puede ser aceptado o perdido | Cancelación ficticia o trabajo residual | Recibo `interrupted` confirma; otros resultados son inciertos |
| Status durante OOM | Métricas/historial parcial | Lectura equivocadamente terminal | Log incremental/cursor bounded de #91; candidato reevalúa `failed` con operationId |

**Clasificación:** reserva/branch son idempotentes bajo identidad y SHA fijos; `submit/continue` son *idempotencia declarada por operationId* que requiere prueba en el runtime real; `sessions.create/fork`, comandos Linux, llamadas de modelos y escrituras GitHub arbitrarias **no** son operaciones exactamente una vez por el mero hecho de que el supervisor tenga un ID. `busy=false` y `Continuing after restart` son observaciones, no receipts.

## 5. Reproducciones y pruebas

Pruebas sin Staging real ni mutaciones de DO:

| Caso sintético | Observación | Resultado |
|---|---|---|
| Sesión creada pero su respuesta se pierde; se solicita otra vez mismo task | Fuente anterior confirmaba cancelación si faltaba `sessionId` | **RED** local: assertion falla (exit code 1), antes del cambio |
| `sessionCreationAttempted=true` y respuesta perdida | No vuelve a invocar create; retorna `reconcile` | **GREEN** |
| Marker ausente en tarea antigua | Reconciliar, no crear automáticamente | GREEN |
| Marker false + sin lock | Confirmación pre-session permitida | GREEN |
| Marker false + lock vivo/varado | Confirmación bloqueada | GREEN |
| Marker true + sin lock / sesión vinculada | Confirmación bloqueada | GREEN |
| `not_found`, espera sin respuesta | `unknown` | GREEN |
| `interrupted` tras `cancel_requested` | `cancelled` confirmado | GREEN |
| `failed` guardado, recibo nativo `done` posterior | `finished` pero no PASS | GREEN |
| `requestId`/turnId estables | Mismo `rc-start`/`rc-turn` | GREEN |

**CI verificado en GitHub (HEAD del candidato antes de añadir esta nota):** SHA `31f7881864c9f46e922f1c77b1add62e88dd09a0`, [run 45091651887](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45091651887), job `137422327645`, **completed/success**; 427 tests pass, 0 fail, incluyendo las siete nuevas pruebas Bun de T04. Unit tests, vista previa, typecheck, build e invariantes finalizaron success. Este commit documental posterior exige su propio CI del HEAD; no presentar el run anterior como validación de un commit nuevo.\n\n**Ejecución offline:** `node --test /mnt/data/f0-c10-t04/recovery-synthetic.test.cjs` con Node v22.16.0, **10/10 PASS, exit 0**, SHA-256 del fixture `224e239e3ce8ee7b861d5e04e7c24b5fcb10a947a49a0318c2bd86d3b60650cb`. Este fixture local replica decisiones puras; **no** equivale a ejecución del código Worker ni a Bun. En el repositorio se añadió `src/supervisor-recovery.test.ts` con siete regresiones Bun dirigidas a los helpers reales; estado CI del HEAD en la PR.

**Próximos tests de interrupción necesarios (fixture DO descartable):** inyectar corte tras cada `storage.put`, `ensureSupervisorBranch`, `create/fork`, `bindSessionScope`, `submit`, `turn journal`, `abort`; simular pérdida de respuesta sin cancelar el efecto; reabrir el DO nuevo con el mismo storage; consultar ledger/inbox/GitHub; comprobar que cada efecto se ejecutó 0 o 1 vez cuando el contrato lo permita, que los ambiguos muestran `unknown` y que solo un recibo auténtico permite estado terminal. Reproducir simultaneidad `cancel ↔ start` y `continue ↔ cancel` en ambos órdenes y confirmar que ninguna escritura posterior revierte el estado de cancelación. Probar también expiración del lock, fallo permanente de GitHub 4xx, fallo 429/5xx y dos `turnId` distintos.

**No ejecutar** reinicios deliberados de Staging, restauraciones, OOM de carga ni manipular sesiones reales para reproducirlo.

## 6. Diseño de siguiente etapa: journal y outbox mínimos

No añadir un motor alternativo al Harness. Se propone un **ledger por fase** en el DO: `reserved` → `branch_requested/branch_bound` → `session_creation_requested/session_bound` → `operation_intent/operation_submitted` → `terminal_receipt`, con `requestId`, `turnId`, `sessionId`, `operationId`, hash de payload, epoch de fencing, revisiones CAS y timestamps. Una outbox durable solo puede reenviar acciones cuyo receptor acepta clave de idempotencia y puede consultar el recibo. Si el receptor no permite lookup/dedupe, el estado debe permanecer `unknown` o cerrarse con un fallo terminal explícito **tras demostrar que no hay efecto pendiente**, sin emitir otro side effect.

El lock de 60 segundos actual **no es fencing token externo**: el hecho de expirar no impide que un antiguo proceso complete un RPC. La creación de sesiones necesita API con ID proporcionado por el cliente, búsqueda por metadata de task, o una clave durable de SDK que permita resolver un create cuyo recibo se perdió. Hasta verificar el contrato, un `unknown` de esa fase no se puede conciliar automáticamente.

**Patrones contrastados:** [Temporal Activity Definition](https://docs.temporal.io/activity-definition) utiliza IDs estables para actividades reintentables y recuerda que las actividades pueden volver a ejecutarse; [Cloudflare Workflows — Rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) exige efectos idempotentes en pasos reintentables; [Durable Objects — Rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) recomienda transacciones para read-modify-write; [Restate — durable execution](https://github.com/restatedev/docs-restate) registra resultados en journal para replay. **No se copió código de esos proyectos**; solo se adoptaron ideas de diseño, por lo que no hay componente externo/licencia integrado.

## 7. Garantías, riesgos y plan de reversión

**Incluido en la rama candidata:** marker previo a creación, rechazo de re-creación ambigua, persistencia inmediata de `sessionId`, cancelación pre-session transaccional conservadora, conciliación de `failed` si tiene `operationId`, tests Bun de decisiones. Ningún registro histórico fue migrado ni transformado automáticamente: **marker ausente significa incierto**, no "aún no creado".

**Limitaciones abiertas de severidad alta:**
1. La ventana entre `sessions.create/fork` y el guardado de `sessionId` puede dejar una sesión sin referencia; este cambio evita crear otra, **no recupera la primera**.
2. El `submit` repetido con la misma clave depende de que la deduplicación del Harness sobreviva el reset; la seguridad de efectos internos Linux/inferencia/GitHub requiere prueba de fallos reales.
3. `continue` y la confirmación `cancel_requested` pueden competir por `operationId` y `status`; no se corrigió con un CAS completo en T04. Un stale write posterior al abort todavía necesita prueba y protección.
4. Un registro `unknown/not_found` como #7/#9 **no** constituye error terminal demostrado; falta un método de conciliación nativa de operaciones desaparecidas.
5. Migraciones y despliegues requieren compatibilidad de worker principal + MCP. Este cambio no reemplaza #106 ni corrige el OOM raíz.
6. La memoria de un único isolate y las otras nueve líneas de trabajo F0-C10 siguen fuera del alcance.

**Reversión:** PR #120 está en draft, por lo que cerrar la PR o revertir sus commits en la misma rama basta mientras no exista merge/deploy. Para una integración futura, registrar HEAD, diff, CI y versión actual antes del deploy y conservar versión anterior para rollback del Worker; el rollback de código **no revierte registros de SQLite DO, Container, GitHub ni crea de vuelta respuestas perdidas**. La nueva propiedad del marker es opcional: código anterior puede ignorarla, pero al revertir se recuperaría el riesgo de duplicar sesiones. No ejecutar rollback real en este lote.

**Coste:** pruebas offline sin inferencia ni Container real; consumo de herramientas de lectura/GitHub/CI no cuantificado como importe. No existe evidencia de reserva exclusiva ni corte efectivo de presupuesto para `staging_start_task`; por eso no se llamó ninguna herramienta Remote con efectos.

## 8. Criterio de cierre y próxima acción

**T04 parcial:** hay una guarda concreta contra duplicación de creación de sesión tras respuesta perdida, pero **no** una garantía universal de conciliación ni un terminal seguro para todos los `not_found`. El cierre de T04 requiere pruebas del código real, CI del HEAD, fixture DO de interrupciones y cancelación cruzada, correlación unívoca de `requestId/sessionId/operationId`, resolución o fallo auténtico de sesiones sin recibo, y cobertura de GitHub/continuaciones.

**Próximo paso sin permisos adicionales de despliegue:** revisar CI y el diff de [PR #120](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/120); añadir CAS/journal de `turnId` y pruebas de carreras de `continue/cancel` sobre almacenamiento simulado, manteniendo la PR draft. Un E2E autenticado en Stage y la promoción deben quedar para otro lote, después del gate de memoria y presupuesto.

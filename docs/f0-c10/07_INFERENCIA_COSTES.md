# F0-C10/T07 — Inferencia concurrente, límites, costes e idempotencia

**Corte:** 22-11-2026 (America/Sao_Paulo). **Actor:** ChatGPT; no fue ejecutado por OpenCode. **Estado:** PARTIAL / OFFLINE ONLY. **Vinculación:** [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), plan maestro F0_C10_PLAN_INTEGRAL.md (T07).

Este informe separa (a) lo documentado por el proveedor; (b) lo observado en Staging; (c) lo probado con un proveedor determinista falso; y (d) los controles propuestos. Ninguna medición del mock prueba capacidad, cuotas o facturación real de Cloudflare.

## 1. Identidad de la versión y situación real

- Cloudflare read-only GET (22-11): Worker principal opencode-g1-staging, deployment 36ef84b3-0f99-4dd4-ab8e-c11ee450dd23, versión #374 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb (100%). Worker MCP opencode-staging-control-mcp, deployment 9fdaf22d-beeb-44a0-ab68-77ecd5745fa1, versión #19 196240c0-1052-47b3-aaa7-02cf5baa87f0 (100%). **La atribución fuente/binario** se basa en auditorías previas, no en comparación byte a byte hecha en T07.
- Código examinado de la fuente atribuida al binario: SHA 74632f75db010223cc90d99ba4a801ce0e6414e5. No confundir con el candidato F0-OOM-02 SHA 19bba24d81be5b0673acbf2a56b500aed4fa0b66, no verificado como desplegado. La rama documental presente parte de la base staging/opencode-g1-20261118; el mock **no** cambia el Worker ni su configuración.
- Remote staging_status: ok, supervisor ready, defaultModel=economy y al menos 96 sesiones supervisadas, recuento incompleto. Remote staging_models: preset economy → proveedor cloudflare, modelo @cf/deepseek-ai/deepseek-v4.1-flash-1017. Baseline cloudflare → @cf/zai-org/glm-4.7-flash. OpenRouter configurado; opciones de reasoning, creative, review y catálogo dinámico truncado. Un precio mostrado o modelo selectable no demuestra cuota disponible, herramientas compatibles ni saldo.
- Issue #90, reproducción 22-11-2026: diez inicios emitidos concurrentemente, cero flujos completos y verificados. Seis excepciones de memoria del Durable Object; cuatro tareas fallidas, dos registros con operationReason=not_found y cuatro preparing canceladas. No se probó que hubiera diez inferencias simultáneas y no hay 429 observados en ese lote. OOM del DO no es rate limit de modelo.

**Alcance de permiso:** solo lecturas y mock offline, branch y PR draft. No inferencia facturable, remote start, despliegue, merge, cambio de secretos, modelos globales o recursos Cloudflare.

## 2. Trazado de selección, ejecución y reintentos

1. src/model-presets.ts resuelve el identificador solicitado con resolveModelSelection. La selección economy fija Cloudflare y el DeepSeek anterior. Los presets OpenRouter exigen proveedor configurado y capacidades; el supervisor no efectúa un fallback dinámico por fallo de inferencia. Existe una función usableModelSelection para determinados contextos; no debe confundirse con un fallback automático autorizado.
2. src/server.ts, OpenCodeAgent.startSupervisedTask: valida input, repositorio y modelo, persiste fingerprint transaccional por requestId bajo supervisor:task:, prepara rama/sesión y ejecuta setAgent('build'), setModel y harness.session(...).submit con operationId estable. El lock supervisor:lock: es **por tarea**, no un semáforo global por cuenta/proveedor.
3. remoteSupervisorContinue usa turnId/operationId estables, rechaza reuso con prompt diferente y conserva estado unknown cuando no confirma el envío. selectModel no cambia una inferencia ocupada. Estas protecciones reducen duplicados de **operación del Harness**, pero no prueban que la petición upstream al proveedor sea idempotente o recuperable.
4. src/sockets.ts y src/protocol.ts guardan la selección/model-run (operationId, model, providerID, id, at), no un ledger duradero por inferencia, tokens y coste. src/token-economizer-adapter.ts observa cost y tokens de eventos session.step.ended si está instalado/habilitado: observación opcional, no corte contable. src/personal-settings.ts consulta el uso global de la clave OpenRouter, no un balance atómico por tarea y conjunto.
5. En las rutas revisadas (server.ts, model-presets.ts, sockets.ts, supervisor-control.ts, protocol.ts, personal-settings.ts), no se encontró un rate gate durable y compartido por cuenta/proveedor/modelo, ni reserva económica previa a cada inferencia, ni un límite backend por generación. **No se auditaron todas las dependencias del Harness/SDK**; requiere confirmación antes de intervenir su pipeline.

## 3. Matriz de límites

| Capa | Dato / error | Calidad de evidencia | Implicación |
|---|---|---|---|
| Cloudflare Workers AI DeepSeek V4.1 Flash 1017 | **20 peticiones/min por cuenta y modelo** con facturación estándar | **Documentación** [Cloudflare](https://developers.cloudflare.com/changelog/post/2026-10-19-deepseek-v4.1-flash-workers-ai/) | 10 × 3 turnos podrían demandar 30 peticiones dentro de 60 s, superior al tope |
| Mismo modelo usando AI Gateway de créditos prepagados y Unified Billing | **50 RPM** en modalidad específica | Documentado; **NO verificado en la cuenta** | No usar 50 como capacidad disponible ni cambiar modalidad |
| Cloudflare Workers AI | Concurrencia física/tokens por segundo/TTFT/TPM para esta cuenta | **Desconocidos** | 20 RPM no implica 20 ejecuciones físicas simultáneas |
| DeepSeek V4.1 Flash 1017 | Contexto máximo 1.048.576 tokens, function calling, visión | Documentación del modelo, no prueba de carga | Ventana de contexto no equivale a presupuesto ni capacidad de concurrencia |
| Workers AI | 429 por cuota; 429 con error interno 3040 al utilizar rejectIfBusy ante capacidad llena | [Límites](https://developers.cloudflare.com/workers-ai/platform/limits/), [Reject if busy](https://developers.cloudflare.com/workers-ai/features/reject-if-busy/) | Distinguir rechazo antes de generar de fallo ambiguo |
| OpenRouter | 402 balance/crédito, 429 por cuota, errores en streaming y límites específicos de upstream | [OpenRouter](https://openrouter.ai/docs/api-reference/limits); cuota de esta clave desconocida | Catálogo con modelos free no garantiza disponibilidad/costo total cero |
| Durable Object supervisor | Reinicio por límite de memoria del isolate, SQL/reportes incompletos | **Observación real** issue #90 | No atribuir OOM a modelos sin trazas de proveedor |
| Containers | CPU, memoria, duración, calentamiento, estado de Linux | F0-C10 relacionado, sin dimensionar T07 | Cuello independiente de RPM de inferencia |
| Harness/SDK | Límite interno, retry, abort, tool streams, callback de usage | No auditado exhaustivamente | No introducir retries duplicados sin conocer su semántica |
| Facturación | Tokens, Workers, DO, Containers, herramientas y reintentos | Cloudflare pricing documentado, factura no observada por tarea | Un prompt con US$ máximo no es un límite aplicable |

**Determinación:** 20 RPM es una restricción real **documentada** bajo la modalidad estándar, pero la modalidad de esta cuenta y la concurrencia efectiva no han sido certificadas. La prueba C10 exige diez trabajos activos con solapamiento útil, no necesariamente diez llamadas AI simultáneas; admitir diez tareas dejando nueve indefinidamente en cola tampoco cumple la finalidad.

## 4. Coste: precio, medición y límite vinculante

Según [precios Workers AI de DeepSeek 1017](https://developers.cloudflare.com/workers-ai/platform/pricing/), referencia al corte: **US$0,30/1M input no cacheado; US$1,20/1M output; US$0,006/1M input cacheado, cuando aplique**.

Coste calculado por petición: (input_no_cache × P_in + input_cache × P_cache + output × P_out) / 1.000.000. Ejemplo **hipotético** 500.000 input y 200.000 output = US$0,39 por tokens (no incluye Workers, Durable Objects, Containers, egreso, registros, CI, reintentos ni otros servicios). Nunca etiquetar estimación como cargo real.

Mínimo recibo por petición: taskId, turnId, operationId, inferenceAttemptId, provider, model, timestamp de admisión/inicio/fin, tokens input/output/cache (observados vs estimados), cargo reportado, tarifa/version de tarifa, respuesta final o unknown, Retry-After, herramienta invocada y billable status. Agregar por tarea y lote; conciliar con uso y factura del proveedor antes de afirmar un gasto final.

Para un **corte aplicable** se necesita un coordinador transaccional server-side con ledger de spentConfirmed, reservedWorstCase y unknownLiability por tarea y lote. Antes de enviar nueva generación, reservar el peor coste posible según max_output_tokens y estimación de input; rechazar si confirmed + reserved + unknown + nuevaReserva excede el cap. En errores ambiguos no liberar reserva sin conciliación, porque la generación pudo cobrarse. Deben limitarse cantidad de intentos, tokens de salida, cola y duración. Para gastos realmente acotados, verificar además que el upstream permite límites duros/prepagos/corte del saldo en la clave separada correspondiente, y considerar el gasto ya en vuelo. **No** se comprobó en esta sesión que tales límites estén configurados o que cubran Containers/Workers.

## 5. Solución recomendada: admisión durable y backpressure

**Punto de control correcto**: una puerta compartida por cuenta/proveedor/modelo en cada llamada real al modelo, con recibos duraderos, no simplemente al crear cada tarea. Reutilizar un Durable Object coordinador/almacenamiento disponible y el pipeline existente solo después de probar un punto de enganche fiable. En varios DO/isolate, un semáforo local NO mantiene exclusión global.

- Ventana deslizante de RPM durable, permisos simultáneos con lease/TTL y fencing para evitar duplicados tras reinicio. Empezar con objetivo **de prueba** 16 RPM y 2 inferencias simultáneas, por debajo de 20 documentados, **no** declarar esos números como ajuste instalado ni como capacidad certificada.
- Cola duradera finita, fairness round-robin entre tareas, estado visible queued_rate_limit, deadline, retryAt y cancelación. No confundir cola con trabajo efectivo: durante espera, las otras tareas pueden adelantar Linux y herramientas sin hacer nuevas inferencias.
- 429 confirmado antes de generar: respetar Retry-After y aplicar backoff acotado; 3040 de capacidad: backoff/circuit breaker según incidencia; 402: corte inmediato sin fallback; EOF/timeout/5xx tras envío: estado UNKNOWN_CHARGE y conciliación, **sin retry ciego**. Un error de memoria DO/Container debe mantener clasificación separada.
- requestId + turnId y operationId existentes siguen siendo IDs estables del Harness; se necesita otra identidad por **inferencia upstream** y persistencia de resultado/usage. Idempotency-Key enviado sin soporte contractual del proveedor **no** garantiza deduplicación ni ausencia de doble cobro.
- Ningún cambio automático de proveedor o modelo por defecto. Solo fallback explícito permitido por tarea, compatible con herramientas, precio y presupuesto, y con auditoría del cambio.
- Telemetría: maxActiveTasks, inFlightByModel, requestsInRollingMinute, queueDepth/latency, 429, 3040, 402, timeout, unknown liability, tokens, coste confirmado/reservado, y correlación trace/task/session/DO/Container. Detener y reportar PARTIAL si una tarea falla y no puede reconciliarse.

### Estrategias alternativas

| Alternativa | Beneficio | Limitación / veredicto |
|---|---|---|
| Semáforo en supervisor | Menor cambio y reduce picos | No controla RPM ni otras instancias de DO; mitigación local temporal |
| Gate durable por proveedor/modelo | Garantiza decisión de admisión común entre rutas, ledger y cola | Complejidad de persistencia; **preferido** si se demuestra punto de enganche |
| Retry con jitter sin admisión | Puede resolver 429 aislado | Tormentas y coste ambiguo; **no recomendado** |
| Circuit breaker solo | Cortes cuando upstream falla | No impone cuota ni presupuesto; complemento |
| Batching | Ventaja para inferencia independiente offline | Tool loops interactivos necesitan respuesta en cada etapa; no cambiar por defecto |
| Fallback a OpenRouter | Podría proporcionar continuidad | Coste/permiso/calidad cambiantes; **no habilitar sin autorización** |

## 6. Implementaciones abiertas consultadas

- [Cockatiel](https://github.com/connor4312/cockatiel): políticas de bulkhead, retry y circuit breaker. Referencia útil para límites **locales**, no sustituye coordinador duradero multi-DO; no se agregó dependencia.
- [opencode-ratelimit](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/packages/opencode-ratelimit/README.md): proyecto abierto con control de errores, Retry-After y hooks de proveedor. Sus cuotas en memoria no demuestran aislamiento multi-DO; compatibilidad con Workers AI native binding/Harness **no verificada**. No instalarlo sin pruebas.
- [Cloudflare rejectIfBusy](https://developers.cloudflare.com/workers-ai/features/reject-if-busy/): rechazo de capacidad mediante API, no rate gate global ni presupuesto. No activado.

## 7. Reproducción sintética y pruebas

Archivos propuestos y incluidos en esta rama:

- scripts/f0-c10/inference-sim.mjs
- scripts/f0-c10/inference-sim.test.mjs

Comandos sin inferencia/red: **node --test scripts/f0-c10/inference-sim.test.mjs** y **node scripts/f0-c10/inference-sim.mjs**. Tests escritos en Node.js estándar; no dependen de Bun, credenciales, Cloudflare ni OpenRouter.

Escenario 10 tareas independientes × 3 inferencias, latencias variables, herramientas *simuladas* con tiempos finitos, límite global de 20 peticiones por ventana deslizante de 60 s, concurrencia 2, presupuesto sintético US$0,10, 429 con espera 23 s, 3040 con espera 9 s, pérdida de una respuesta y timeout después de otra generación. FakeProvider recuerda sus llamadas generadas para poder simular reconciliación.

**Ejecución local observada:** 8 tests PASS, 0 FAIL. Con readback **que solo existe en el fake**: 10 DONE, 30 generaciones, 32 solicitudes, 2 rechazos, 2 reconciliaciones, máximo dos inferencias en vuelo, hasta diez actividades simuladas solapadas (inferencia/herramientas), duración virtual 88.261 ms, cargo simulado US$0,02709. Sin readback: **8 DONE y 2 UNKNOWN**, ninguno con generación duplicada; el test prioriza integridad y coste sobre éxito aparente. Con presupuesto bajo (US$0,004): bloquea solicitudes antes de exceder el límite sintético.

**Limitación crucial:** ninguna API real de los dos proveedores demostró permitir inspect(key) después de un timeout; 10 DONE del fake NO implica recuperabilidad de una respuesta real. Las herramientas son simuladas, no ejecución Linux; las 10 actividades virtuales tampoco prueban diez Containers en paralelo.

## 8. Puertas RED/GREEN antes de tocar Staging

1. Localizar y auditar fuente exacta del adaptador de inferencia y los retries internos SDK/Harness. Inyectar 429, 3040, EOF, timeout y pérdida de recibo **en el punto real del adapter**, no solo en el API REST del supervisor.
2. RED: diez sesiones en dos DO distintos en prueba aislada, reserva monetaria atómica, límites globales, expiración de lease, reinicio, redispatch y cancelación; demostrar no doble petición facturable. Preservar control de permisos, rama y origen SHA.
3. GREEN: integrar gate duradero con operación atómica, backpressure recuperable, límites de input/output tokens, contabilidad observada y fallback solo autorizado. CI Node/Bun, typecheck, build, invariantes, y fault injection; sin publicación automática.
4. Preflight operativo separado: modelo, modalidad/balance reales, cuota asignada, presupuesto de gasto para el lote, **corte efectivo verificado**, reserva exclusiva para prueba Remote, SHA de los dos Workers, rollback y tolerancia de infraestructura. Si falla una condición, **STOP** sin inferencia.
5. Aceptación C10: diez tareas verdaderamente activas con intervalos de trabajo solapados y entregables independientes, bajo límites instrumentados, memoria/Containers estables y coste reconciliado; no basta con 10 recibos accepted, estado busy o tests de mock.

## 9. Cierre

**RESULTADO:** PARTIAL — investigación contrastada y reproducción determinista offline; no cambio operativo de gate.

**EVIDENCIA:** código del SHA atribuido 74632f75db010223cc90d99ba4a801ce0e6414e5; Cloudflare versiones #374/#19; catálogo Remote; issue #90; 8 tests locales y scripts de esta rama. **Bloqueante:** capacidad real concurrente y saldo/corte upstream no observados, idempotencia de llamada upstream por verificar, OOM del DO #90 abierto.

**PRÓXIMA ACCIÓN:** revisión del mock y del contrato del adaptador Harness; implementar una prueba RED/GREEN sin gasto, seguida de preflight explícito antes de inferencia real. No merge ni deploy autorizados.

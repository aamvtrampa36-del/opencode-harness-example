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


---

# R2-T07 — Contrato de inferencia y gasto condicionado (continuación de segunda ronda)

**Corte:** 2026-11-22 BRT. **Autoría:** ChatGPT, mediante lecturas autorizadas GitHub/Cloudflare/Remote y desarrollo con Node offline. **Estado:** PARTIAL / CONTRACT_CANDIDATE / NO RUNTIME ENFORCEMENT. Este apartado complementa el informe inicial, no lo sustituye.

## R2.1 Autoridad y estado revalidado

- Primera integración: PR https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126, rama f0-c10/t11-integration-20261122, HEAD 1268ba22f26330d619b046fcf551ca846cb69d0f; abierta, draft, no merged al corte. Workflows 45093134023 (OpenCode validation), 45093134014 (offline harness) y 45093134038 (T09 output) completados con success en ese SHA. Contiene los tres archivos anteriores de PR #117 y los fixtures de T03 (#125): NO repetirlos ni modificarlos en #126.
- Base R2-T07: rama propia f0-c10/r2-t07-inference-budget-20261122 creada desde el HEAD inmutable 1268ba22f26330d619b046fcf551ca846cb69d0f. Solo se añaden módulos locales de contrato/contraprueba y esta documentación. Ni main ni #126 ni ramas ajenas sufrieron escrituras.
- El documento de coordinación y el plan adjuntos del proyecto están titulados F0_C10_COORDINACION_R2.md y F0_C10_PLAN_INTEGRAL.md; la consulta a docs/f0-c10/00_COORDINACION.md y docs/f0-c10/F0_C10_PLAN_INTEGRAL.md en #126 devolvió 404. No convertir un archivo adjunto en una supuesta versión del repositorio.
- GET de Cloudflare revalidado: opencode-g1-staging, deployment 36ef84b3-0f99-4dd4-ab8e-c11ee450dd23, versión #374 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb al 100%; opencode-staging-control-mcp, deployment 9fdaf22d-beeb-44a0-ab68-77ecd5745fa1, versión #19 196240c0-1052-47b3-aaa7-02cf5baa87f0 al 100%. El candidato #126 no está demostrado desplegado. Remote: status ok, preset economy todavía DeepSeek @cf/deepseek-ai/deepseek-v4.1-flash-1017, OpenRouter configurado, catálogo truncado; no prueba cuota ni capacidad real.
- Issue #90 sigue siendo RED histórico: 10 starts no equivalen a diez trabajos simultáneos; 0/10 verificados, OOM DO, operaciones unknown/not_found y preparing. No hay evidencia de que límites de inferencia hayan causado ese incidente.

## R2.2 Ruta SDK y matriz de límites

**Código inspeccionado en #126:** src/model-presets.ts resuelve economy a proveedor cloudflare y el modelo DeepSeek indicado; src/server.ts reserva supervisor:task:requestId, fija modelo con handle.setModel y crea operación con handle.submit(operationId). src/sockets.ts persiste ModelRun con operationId, selección y fecha, no cada llamada interna del SDK. src/token-economizer-adapter.ts observa eventos session.step.ended con tokens/cost en conector opcional, pero no hace preflight vinculante. src/personal-settings.ts consulta consumo OpenRouter a nivel de clave. No se verificó en código de terceros el punto de interceptación por generación, el número de reintentos que el Harness puede efectuar por debajo de submit ni una API de lectura de respuesta facturable previamente perdida; por ello NO se implantó una guarda alrededor de submit que fingiera proteger todas las inferencias.

| Control | Dato verificado | No demostrado / criterio |
|---|---|---|
| Cloudflare DeepSeek 1017 RPM | 20 peticiones/min modelo/cuenta con facturación Workers AI estándar, según anuncio oficial 19/10/2026 | Modalidad y cuota efectiva de esta cuenta, y tokens/minute |
| Cloudflare AI Gateway prepagado | 50 RPM solo en ruta elegible de créditos y Unified Billing | No asumir aplicado ni cambiar configuración |
| Concurrencia upstream | No se obtuvo un número de inferencias simultáneas garantizado | RPM no es semáforo, TPM ni capacidad física |
| Contexto | 1.048.576 tokens máximos de ventana nominal del modelo | Contexto no implica presupuesto ni max-output acordado |
| Workers AI 429 / 3040 | RejectIfBusy puede producir HTTP 429, código 3040 por capacidad | No equivale a OOM del isolate ni a 429 de presupuesto |
| DO/Container | Límite físico de isolate y Container independiente del proveedor | Sin demostración 10 activos, sin correlación causal OOM→inferencia |
| OpenRouter | Catálogo actualmente habilitado, sin cambio de preset | 402/429, límites por cuenta/proveedor, dedupe, cuota/modelo y facturación reales desconocidos |
| Precio de referencia | DeepSeek USD 0,30/1M input ordinario, USD 0,006/1M cached input y USD 1,20/1M output en Cloudflare | Precio de fixture no constituye un recibo de facturación ni cubre compute/herramientas |

Fuentes oficiales: https://developers.cloudflare.com/changelog/post/2026-10-19-deepseek-v4.1-flash-workers-ai/ ; https://developers.cloudflare.com/workers-ai/platform/pricing/ ; https://developers.cloudflare.com/workers-ai/features/reject-if-busy/ ; https://developers.cloudflare.com/ai-gateway/features/spend-limits/ ; https://developers.cloudflare.com/changelog/post/2026-11-13-spend-management/ .

## R2.3 Corrección mínima implementada: contrato OFFLINE

Archivos nuevos:

- scripts/f0-c10/inference-budget.mjs
- scripts/f0-c10/inference-budget.test.mjs
- scripts/f0-c10/inference-known-red.red.mjs (RED esperado, no forma parte de CI)

InferenceBudgetReference es una referencia sin red ni invocación del modelo. Cada generación lógica se identifica por (requestId, callId), vinculada a operationId de Harness, attemptId, proveedor/modelo, precio revisionado y topes de input/output. Recibe verifyT03Claim como dependencia: solo el owner T03 puede verificar un claim durable/fenced real. El valor lease-verified empleado en los tests es un marcador sintético, NO una prueba de autorización en runtime.

El ciclo probado es reserve → dispatch (permiso de envío solo una vez por intento) → settle con recibo y tokens observados; los fallos pueden pasar a rejected solo con prueba interna autoritativa de rechazo **antes** de generación, o a unknown cuando el efecto upstream es ambiguo. En unknown se conserva responsabilidad potencial y se rechaza la creación de un nuevo intento para la misma llamada. El contrato permite un nuevo attemptId únicamente después de rechazo pre-generación confirmado y dentro de maxAttempts. 402 bloquea reintentos. El modelo/ proveedor no cambia silenciosamente para otras llamadas del mismo requestId, incluso cuando ambos modelos figuran en precios autorizados.

La contabilidad del mock usa micro-US$ enteros, redondeo conservador hacia arriba, coste máximo reservado según tokens máximos y tarifas inmutables capturadas en cada registro. La exposición agregada es confirmed + reserved + unknownLiability; no admite reservas que excedan el límite por tarea o por lote. Los resultados duplicados idénticos son idempotentes, pero un mismo receiptId con tokens diferentes falla. Si el uso informado supera el techo reservado, se conserva la obligación y se genera error sin afirmar que el proveedor haya obedecido el presupuesto.

No hay scheduler, cola, mecanismo RPM, Durable Object nuevo ni retry policy temporal en este cambio; esos contratos deben conectarse a **T03, no duplicarse**. La serialización Promise local de la clase no sirve entre isolates, instancias ni reinicios; snapshot en JSON es una FIJACIÓN DE ESTADO PARA TEST, no persistencia. No se debe exportar la clase tal cual al runtime como límite de gasto.

## R2.4 Interfaz de integración propuesta con T03, NO instalada

1. T03 emite/valida claim asociado a requestId, operationId, capacidad de trabajo y fencing generation, bajo autoridad duradera. T07 verifica ese claim **antes** de reservar y otra vez justo antes del dispatch. NO emitir permisos desde prompts ni desde el navegador.
2. El mismo owner duradero y transaccional registra (requestId, callId, attemptId) y el importe worst-case en presupuesto GLOBAL y por tarea, antes de cualquier llamada real a modelo. Si las llamadas pueden ejecutarse en varios DO, la transacción debe residir en un único owner para esa cuenta y presupuesto: nunca Map/semáforo local. Al fallar commit se prohíbe el despacho.
3. El adaptador SDK/Harness necesita un punto de enganche por generación real, que adjunte bounded input/output y usage/receipt nativo al registro; ninguna llamada lateral (subagentes, imágenes, reintentos internos, selección manual) debe eludirlo. Un permiso T03 para iniciar tarea **no** cubre por sí solo varias generaciones.
4. Tras commit de sent y antes de obtener recibo, pérdida de respuesta → unknown; no suponer que un requestId/operationId del Harness deduplica solicitudes facturables upstream. Solo prueba del proveedor o auditoría autoritativa puede liberar esa reserva. El tiempo vencido no equivale a efecto ausente.
5. T03 decide fairness, admisión de tareas, 1→2→4→10 y cola; la política por proveedor/modelo debe contar RPM en ventana móvil y capacidad de proveedor por ruta, pero no imponer permanentemente dos ejecutores de trabajos. InferenceBudgetReference NO hace rate limiting ni monitoriza ten concurrent physical agents.

**Punto de parada:** hasta disponer de hook real, contabilidad transaccional duradera, protección de todas las rutas de inferencia y corte upstream verificable, ninguna cifra de presupuesto en este fichero protege dinero real.

## R2.5 Reproducción y pruebas RED→GREEN

Entorno local aislado: Node v22.16.0. Comandos sin servicios externos:

- node --test scripts/f0-c10/inference-known-red.red.mjs ⇒ **2 fallos esperados / exit 1**: duplicación con reenvío ciego tras timeout y overbooking de diez solicitudes que solo consultan gasto confirmado; ambos son modelos inseguros, no fallos del SDK desplegado.
- node --test scripts/f0-c10/inference-budget.test.mjs ⇒ **15 PASS / 0 FAIL / exit 0**: misma petición concurrente, reserva y settle idempotentes, límites globales/per-task, 429/3040 pre-generación, retry acotado, 402, timeout desconocido tras restore, recibo duplicado incompatible, techo de tokens, precio fijado ante cambio de catálogo, rechazo de claim vencido, prohibición de fallback autorizado solo por catálogo y operación ID exacta.
- Los 15 GREEN no ejecutan ningún proveedor: tokens y tarifas de fixtures; no coste externo de inferencia. Tampoco sustituyen bun test/typecheck/build/invariantes y CI del HEAD de PR draft.

Evidencia local de SHA-1 Git blob (debe coincidir con GitHub): inference-budget.mjs 736e25a45df30eeeb96aefaafd147982c965d3ac, inference-budget.test.mjs f11a6050a52a4b4dc51e4d252ee380f020190e74, inference-known-red.red.mjs 321cd36739f1e8f445efb6ee1018e9b73a2a25b9. El enlace GitHub de PR R2 y su HEAD exacto se registran en el recibo de PR, no como un SHA supuesto al escribir el documento.

## R2.6 Controles externos de gasto: corte NO comprobado

**Consulta Cloudflare read-only en R2:** GET account AI Gateway billing spending-limit devolvió success=true, enabled=false. Esto solo describe **ese control de gasto de AI Gateway**; no prueba presencia/ausencia de reglas específicas de gateways ni que OpenCode enrute su binding AI por Gateway. GET billing spend-policies devolvió HTTP 403: alcance insuficiente para confirmar reglas generales de Workers/DO. No se inspeccionaron ni modificaron importes, tarjetas, credenciales, secretos, billing ni configuración.

Cloudflare documenta desde noviembre de 2026 controles de bloqueo de gasto para Workers y Durable Objects por producto; AI Gateway ofrece reglas que bloquean al superar cuota (HTTP 429), pero su cómputo de coste se basa en estimaciones y solo cubre las solicitudes que efectivamente lo atraviesan. No hay demostración de stop duro de Workers AI + OpenRouter + Workers + Durable Objects + Containers en conjunto, ni del crédito prepago aislado con corte no eludible. Por ello **NO es seguro empezar ensayo real** y está prohibido en este lote.

Preflight vinculante para una futura autorización separada: identificar la ruta de cada modelo/proveedor, límite efectivo real y coste por token; comprobar un control upstream de rechazo por gasto y de cuota por modelo, un balance aislado con corte máximo incluyendo in-flight, bloqueos Worker/DO/Container y gastos externos, y registrar receipt de configuración sin secretos. Debe demostrarse con un test autorizado no facturable o simulado en el mismo punto de salida (no solo leer settings) y conciliar uso. Si el proveedor no admite hard cutoff o las peticiones eluden la ruta protegida, STOP.

## R2.7 Alternativas abiertas verificadas y decisión

- Cockatiel: https://github.com/connor4312/cockatiel, commit master 7d53faff11ebe4d892b17b85135f7dbeb86cfd78, licencia MIT comprobada desde LICENSE del repositorio. Ofrece bulkhead/retry/circuit breaker útiles dentro de un proceso, pero **NO sustituye transacción Durable Object ni deduplicación pagada del upstream**; introducir dependencia sería más complejidad que el contrato local.
- Bottleneck: https://github.com/SGrondin/bottleneck, commit master b83528333ba4d27cf70b81cc2be12e09d7ff692f, licencia MIT comprobada. Puede coordinar tasas en runtimes Node/Redis; requiere servicios y compatibilidad Cloudflare Workers/Harness no probada, y duplicaría T03. No usar por defecto.
- No se copió código de terceros, ni se introdujo proveedor, modelo, dependencia o servicio nuevo.

## R2.8 Estado y entrega

**RESULTADO:** PARTIAL — corrección offline determinista y contrato listo para revisión por T03/T11; no está en producción ni desplegado en Stage.

**EVIDENCIA:** PR base #126 HEAD 1268ba22f26330d619b046fcf551ca846cb69d0f; Worker #374, MCP #19; Remote economy nativo; 2/2 RED esperados exit1 y 15/15 GREEN exit0 locales; tres archivos nuevos; git blob SHA cotejable; no llamadas pagadas.

**BLOQUEANTE:** integración con punto real del SDK por generación; claim/fence duradero T03; persistencia global transaccional; validación de límites efectivos y corte de gasto upstream (AI Gateway account spend-limit disabled, billing spend-policies 403); OOM #90 no resuelto.

**PRÓXIMA ACCIÓN:** T03/T11 integran, con pruebas de fault injection en proveedor simulado y memoria/recuperación bajo el mismo DO, el ledger de inferencia duradero sin otro scheduler. Hasta verificar los cortes reales y obtener lote de despliegue/gasto expresamente autorizado, no ejecutar Remote con efectos ni ensayos 10×.


## R2.9 Recibo de PR de revisión

La continuación está publicada como [PR draft #142](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/142) desde una rama exclusiva T07; no introduce cambios en recursos ejecutivos. La CI de la rama debe comprobarse contra su HEAD exacto (no el SHA de #126) y el PASS de sus jobs no prueba integración con un proveedor real.

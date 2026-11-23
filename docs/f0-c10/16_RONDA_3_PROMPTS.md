# OpenCode Cloud — F0-C10, tercera ronda: prompts íntegros T01–T11

**Uso:** un botón por T; T01–T10 en el mismo chat especialista, T11 en el chat maestro al recibir handoffs. **Estado inicial:** #145 candidata NO desplegada. Cada bloque es autocontenido; no simula permisos de ejecución fuera del lote.

<!-- BEGIN T01 -->
# F0-C10/R3-T01 — OOM y memoria

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T01 (OOM y memoria). **PR anteriores:** #116, #129 y #134. **Informe principal:** `docs/f0-c10/01_DIAGNOSTICO.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

El problema abierto no es la lectura ilimitada que ya se mitigó: es determinar qué reserva/retiene memoria en la ruta real del supervisor posterior a #145. El incidente #90 produjo reinicios `exceededMemory`, pero todavía no hay perfil causal del isolate durante diez ejecuciones activas. El instrumento T01 R2 #129 es offline y la instrumentación #134 no se integró por depender de un flujo de inicio anterior.

1. Reconstruye sin tocar datos reales el ciclo `admission → github_branch → session_create/reconcile → configure → submit → continue/status → cleanup` sobre el HEAD vigente. Coloca puntos de medición **antes y después** de SDK, Harness, buffers de MCP y lectura de artefactos, sin cargar `history()` ni crear un allocador de logs.
2. Adapta #134 a los bloques reescritos en #144/#145; conserva bandera apagada por defecto, datos acotados, sin texto de usuario/secretos y sin alta cardinalidad.
3. Construye RED/GREEN de retención y límites de logs; registra baseline para 1/2/4/10 sesiones sintéticas con mismo instrumento, separando heap V8, memoria Container y memoria isolate cuando la fuente la proporcione.
4. Compara fuentes Cloudflare Observability y comportamientos de SDK con referencias/versiones exactas. Identifica hipótesis corroboradas, descartadas y sin evidencia, no atribuyas los OOM al RPC que los manifiesta.
5. Entrega al T11 métricas reproducibles y umbrales STOP para T02/T05; si el profiling Cloudflare exige un lote operativo nuevo, déjalo explícitamente pendiente sin iniciar carga.

**Criterio del área:** instrumentación compilable y RED/GREEN de límites, más hipótesis falsables; root cause `PARTIAL` hasta obtener muestras runtime. No confundir benchmark Node con memoria workerd.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T01 -->

---

<!-- BEGIN T02 -->
# F0-C10/R3-T02 — DO e aislamiento

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T02 (DO e aislamiento). **PR anteriores:** #115 y #128. **Informe principal:** `docs/f0-c10/02_DURABLE_OBJECTS.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

T02 documentó la concentración de un Harness residente en `OpenCodeAgent` y la diferencia entre un DO lógico y un isolate físico. Faltan mediciones que distingan contención suficiente de necesidad de separar responsabilidades.

1. Revalida bindings/clases, Supervisor DO, Session/Container, SDK `agents@0.33.0`, ciclo de vida y estado de las PR #143–#145. Dibuja las referencias persistentes (sesiones, leases, cachés, sockets, `lifecycle`, retransmisiones) con archivo y funciones.
2. Extiende el benchmark #128 a creación/reconciliación/continuación de 1,2,4,10 con liberación al terminar. No simules múltiples isolates físicos usando solo múltiples IDs de DO.
3. Define prueba workerd/Miniflare descartable para medir memoria/CPU/restarts, timeout y supervivencia al reinicio; si requiere entorno no disponible o recursos reales, produce fixture y plan, sin desplegar.
4. Compara (A) retención acotada, (B) coordinador ligero+ejecutores por sesión y (C) contención de admisión con costes, state migration, ACL, interleaving y rollback. Ninguna migración efectiva en este lote.
5. Cruza T01 memoria con T03 slots; demuestra qué parte de diez activos sigue sin garantía. Recomienda una sola opción mínima para integración de T11 con gatillos medidos para escalar.

**Criterio del área:** decisión arquitectónica falsable y pruebas del componente reutilizable; declarar `PARTIAL` si falta perfil real del isolate.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T02 -->

---

<!-- BEGIN T03 -->
# F0-C10/R3-T03 — Admisión y legado

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T03 (Admisión y legado). **PR anteriores:** #125, #135, #138 y #145. **Informe principal:** `docs/f0-c10/03_CONCURRENCIA.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

La PR #145 amplía T03 con un único ledger de diez slots, readmisión y `turn_submit` write-ahead. Su límite más importante es que **sesiones legacy pueden ejecutar fuera del ledger**, y un slot de 10 no prueba límite físico de diez operaciones.

1. Audita todas las rutas de `start/continue/status/cancel/review/agent_check/legacy` y el estado de `supervisor:admission:v1`; clasifica sesiones con y sin `sessionIdPolicy`. No leas registros privados ni alteres datos DO.
2. Implementa y prueba política fail-closed para rutas legacy con trabajo real: cuota conservadora/contador reservado o procedimiento explícito de migración con pruebas offline y sin mutaciones productivas. No contabilices erróneamente un legacy sin slot como si fuese cero carga.
3. Prueba 11.º inicio, un terminal reclaimed, readmisión simultánea con nuevo start, timeout/retry, token+generation viejo, operación `effect_unknown`, TTL expirado y cancel que compite con un turno.
4. Revisa que solo T03 controle capacity/fencing y que T04 conserve sus journals; coordina con T07 una interfaz única de presupuesto y con T08 el gate GitHub sin otro scheduler.
5. Prepara evidencia cuantitativa de `activeSlots`, `activeNativeOperations` y condiciones para admitir diez activos cuando sea seguro, distinguiendo simulación de ejecución real.

**Criterio del área:** no sobreasignación en todas las rutas bajo control, pruebas negativas de legado y readmisión y contrato de capacidad para T11. Si hay legado no gobernable, entregar STOP verificable.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T03 -->

---

<!-- BEGIN T04 -->
# F0-C10/R3-T04 — SDK y recuperación

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T04 (SDK y recuperación). **PR anteriores:** #120, #136, #144 y #145. **Informe principal:** `docs/f0-c10/04_RECUPERACION.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

La PR #145 consulta `opencode.sessions.get({sessionID})` para un `ses_r2_<requestId>` persistente, transfiere fencing y readmite tareas terminadas. Los tests son mocks; falta probar que el creador original no produce efectos incompatibles tras la transferencia y que la identidad SDK persiste tras una interrupción.

1. Fija e inspecciona `agents@0.33.0`, `@opencode/sdk@2.0.24`, `OpenCodeHarness.create({id})`, `opencode.sessions.get`, error etiquetado `SessionNotFoundError`, y garantías reales de tabla SQLite/DO. No infieras que `sessions.get(id)` consulta realmente almacenamiento: el handle no lo hace.
2. Construye una prueba con DO/workerd **local y descartable** si es posible, forzando crash/pérdida de respuesta antes/después de `session_create`, `sessionCreationAttempted`, commit bajo token original y transferencia al nuevo propietario. Si no está disponible, fixture offline y bloqueo claro.
3. Prueba dos reconciliadores a la vez, GET positivo y negativo, scope inverso cruzado, original tardío, fencing antiguo, `not_found`, operación nativa duplicada y readmisión tras `finished`.
4. Investiga si `create({id})` puede repetir cambios secundarios aun con el mismo ID; no repitas un `create` ambiguo sin prueba de unicidad y sin transferencia segura. Mantén `effect_unknown` cuando falte evidencia.
5. Examina nuevas `fork` bloqueadas, cancel/continue y transacciones obsoletas con T03. Implementa corrección mínima y pruebas RED/GREEN de cualquier defecto demostrado.

**Criterio del área:** evidencia ejecutada de fallos en storage/harness real o `PARTIAL` explícito; nunca presentar simulación como recuperación DO probada. Entrega condiciones de integración a T11.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T04 -->

---

<!-- BEGIN T05 -->
# F0-C10/R3-T05 — Remote, MCP y progreso

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T05 (Remote, MCP y progreso). **PR anteriores:** #106, #114 y #139. **Informe principal:** `docs/f0-c10/05_REMOTE_MCP.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

#139 dejó paginación/guardas candidatas, pero el SDK puede cargar un evento enorme antes de `next()` y los errores del protocolo R2 requieren representación segura en ambos Workers.

1. Traza `staging_task_status/progress/inspect/transcript/continue/cancel` desde MCP hasta DO usando el código de #145 y ambos Workers; separa llamadas verdaderamente de solo lectura de las que mutan storage o disparan trabajo.
2. Prueba `progress` con evento individual gigante, todos los eventos filtrados, cursor con huecos, consumidores concurrentes, `unknown/not_found/effect_unknown/turn_submit`, restart y entradas truncadas. Rechaza `passed:true` sin prueba nativa.
3. Comprueba límites **antes** de serializar `JSON.stringify`, textos y logs; evita `history()`/enumeraciones sin cota. Implementa salida paginada o `UNAVAILABLE_LEGACY` cuando SDK no permita un cursor real.
4. Verifica coherencia de request/response MCP entre Worker principal y MCP, incluyendo errores, blobs de artefactos y compatibilidad móvil, con tests negativos y builds.
5. Coordina con T01 las mediciones de memoria y T09/T10 los identificadores y recibos; no despliegues un Worker MCP aislado fuera de su par.

**Criterio del área:** tests de límites y contratos en ambos lados con API fail-closed, sin afirmar memoria de isolate medida por CI.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T05 -->

---

<!-- BEGIN T06 -->
# F0-C10/R3-T06 — Linux y procesos

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T06 (Linux y procesos). **PR anteriores:** #121, #132, #140 y #137. **Informe principal:** `docs/f0-c10/06_LINUX_CONTAINERS.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

Las PR Linux introdujeron PGID/timeout/EPIPE; los procesos que escapan con `setsid`, el cgroup del Container y su memoria real siguen sin pruebas de limpieza integral.

1. Revalida `DevContainer.run`, `LINUX_RUNNER_SOURCE`, configuración de Containers, `ctx.container.start`, grupos/PGID, señales y captura acotada. Separa Node test local de runtime Container.
2. Construye fixtures **descartables** con shells/nietos, setsid, doble fork, cierre de stdout/stderr, stderr masivo, timeout, kill, exitCode y directorios de diez proyectos. Registra solo PIDs propios y limpia en `finally`; no usar `pkill` global.
3. Demuestra si Container scope/cgroup puede matar procesos detached y bajo qué runtime; si no, entrega RED y STOP explícitos. No relajes aislamiento ni intentes arreglarlo con comandos globales.
4. Verifica `O_NOFOLLOW`, paths de artefactos, archivos compartidos y no mezcla de resultados. Contrasta código real y licencia/commit de DeepSeek Harness sin asumir que Bash local es sandbox.
5. Propón o implementa la mínima corrección segura, manteniendo códigos de salida, timeout, bounded pipes y compatibilidad Cloudflare; pruebas de 1/2/4/10 procesos **solo locales**.

**Criterio del área:** ausencia de huérfanos en el alcance probado, límites demostrables y lista verificable de pruebas Container pendientes para T11.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T06 -->

---

<!-- BEGIN T07 -->
# F0-C10/R3-T07 — Inferencia y presupuestos

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T07 (Inferencia y presupuestos). **PR anteriores:** #117 y #142. **Informe principal:** `docs/f0-c10/07_INFERENCIA_COSTES.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

#142 solo implementó un contrato de presupuestos offline: no interrumpe todas las inferencias ni aplica un corte duro en Workers/Containers. Un preset `economy` o una estimación de AI Gateway no equivalen a gasto cero.

1. Revalida modelo/proveedor vigente, SDK calls de Workers AI y OpenRouter, reintentos, fallback, tokens y límites documentados; identifica cada camino de coste que escapa al controlador actual.
2. Diseña e implementa, **sin activar cuentas ni desplegar**, una capa de reserva/settle idempotente ligada a los mismos IDs/fencing de T03, distinguida de una segunda cola; declara qué rutas quedan sin interceptor.
3. Prueba 10 solicitudes simultáneas, presupuesto agotado, rate limits 429/3040, retry, timeout después de efecto, doble liquidación, saldo desconocido y fallback no permitido, más coste de CI/Containers por separado.
4. Diseña preflight operativo binario `GO/STOP` con límites efectivos medidos y corte técnico verificado por servicio, no solo límite escrito en Markdown; no invoques modelos reales sin permiso adicional.
5. Entrega a T11 contrato de presupuesto y evidencia de si es verificable el uso de un entorno descartable; documenta fuentes de tarifas y su fecha.

**Criterio del área:** no sobre-reserva en tests y política fail-closed que pruebe que NO se puede iniciar prueba pagada cuando los cortes necesarios siguen desconocidos.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T07 -->

---

<!-- BEGIN T08 -->
# F0-C10/R3-T08 — GitHub multiwriter

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T08 (GitHub multiwriter). **PR anteriores:** #122, #124, #130 y #138. **Informe principal:** `docs/f0-c10/08_GITHUB_INTEGRIDAD.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

El publicador GitHub durable ya integrado guarda intención/fencing; falta probar diez escritores reales aislados, cambios de HEAD concurrentes y respuestas perdidas a los mutadores.

1. Inspecciona puente GitHub, `github-publication-durable.ts`, guards de scope y cada operación `branch/write/commit/pr`, con permisos server-side; no sustituyas el puente de OpenCode por el conector ChatGPT.
2. Inyecta dos escritores para mismo destino, diez para destinos independientes, dos PR que toquen el mismo path, CAS con HEAD cambiado, respuesta HTTP perdida después de POST, duplicado de `requestId` y autorización cruzada.
3. Exige transacciones/fencing verificables para efectos mutantes, nunca un mero preflight booleano seguido de dos POST. Mide número exacto de efectos, rutas, commits y recibos en un mock stateful.
4. Implementa reparación focal si el modelo encuentra doble escritura; verifica diff con #145 y permisos `main`, Staging y ramas ajenas denegados.
5. Entrega a T11 reglas mecánicas de orden de integración y conflictos de archivos, incluyendo cómo no mezclar PR de diez ramas sin volver a probar el HEAD.

**Criterio del área:** cero doble POST ciego en la suite, diez ramas/PR separadas y errores de conflicto explícitos; sin afirmar publicación live de diez agentes.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T08 -->

---

<!-- BEGIN T09 -->
# F0-C10/R3-T09 — Artefactos y Android

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T09 (Artefactos y Android). **PR anteriores:** #100, #123 y #133. **Informe principal:** `docs/f0-c10/09_OUTPUTS_ARCHIVOS.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

T09 tiene endpoints de artefactos y lecturas byte-exact candidatas, pero no hay garantía probada de ACL multitenant, retención, Android ni compatibilidad real entre ambos Workers.

1. Reconstruye `capture → storage → manifest → GET` y verifica requestId/projectId/sessionId/artifactId, owner/Access/bearer, Content-Disposition, MIME, tamaño, hash y expiración con código actual.
2. Prueba negativas: ID ajeno, proyecto cruzado, token caducado, path traversal, symlink/hardlink, URLs internas, HTML/SVG activo, bytes cambiados después del manifest y nombre Unicode. No exponer secretos o rutas internas.
3. Revalida límite candidato de 32 KiB y política de archivos grandes; diferenciar `file part` seguro, URL autenticada y ruta interna "/bundle". No inventar enlaces descargables.
4. Comprueba la experiencia Android a través de emulación **solo como preflight**; la aceptación de descarga Android real requerirá dispositivo autenticado y otro lote permitido. No asumir usuario/dispositivo disponible.
5. Implementa corrección focal y pruebas de diez entregas desordenadas con readback independiente, verificando hash y aislamiento; coordina colector con T10.

**Criterio del área:** negativos ACL y bytes verdes offline, contratos de endpoints íntegros y una lista verificable de pruebas Android/live aún no realizadas.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T09 -->

---

<!-- BEGIN T10 -->
# F0-C10/R3-T10 — E2E real y criterios

Continúa tu trabajo anterior en este mismo chat. Recupera las entregas, pruebas y PR que ya produjiste, revalida su estado y trabaja desde el candidato integrado más reciente. No repitas investigaciones cerradas.

**Tu especialidad:** T10 (E2E real y criterios). **PR anteriores:** #118, #119 y #141. **Informe principal:** `docs/f0-c10/10_PRUEBAS_E2E.md`. Debes dejar una sola entrega final hacia T11; no generar una continuación propia.

## Problema focal y trabajo verificable

#141 verificó atestaciones y readback de fixtures, pero NO existe aún un colector runtime autenticado que demuestre diez intervalos realmente solapados de inferencia/herramientas.

1. Inspecciona `scripts/f0-c10/evaluate.mjs`, trazas Ed25519, identidades y oráculos de bytes; impide que datos mock con `source=runtime` pasen por evidencia live. No inventes claves de producción ni registros de infraestructura.
2. Define y si es viable implementa un colector/adaptador **offline y verificable** para eventos observados de DO/Container/inferencia, con experimentId/requestId/sessionId/operationId/fence/worker SHA/deployment y reloj; debe resistir reinicios e interleaving.
3. Reproduce RED del issue #90, 10 starts sin ejecución, intervalos falsos, clock skew, output de otra tarea, respuesta perdida, OOM, cancel, coste desconocido y firma del propio modelo; no aceptar ">=10 busy" como evidencia.
4. Prepara receta 1→2→4→10 y tres campañas con ventana de solapamiento, 10 outputs/readback, memoria/costes y abort por incidente. Define preflight explícito de T01/T02/T03/T07/T09 antes de una sola inferencia pagada.
5. Ejecuta exclusivamente CI offline; entrega a T11 un test/contrato capaz de rechazar falsos PASS y qué infraestructura real falta para aceptarlo.

**Criterio del área:** oráculo negativo robusto y checklist de campaña real, sin ejecutar ni anunciar COMPLETE PASS.

## Continuidad y autoridad

Repositorio: `aamvtrampa36-del/opencode-harness-example`; issue maestro [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Base inicial verificable**, no necesariamente vigente: PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, apilada sobre #144, #143 y #126. Recupera `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md`, `00_COORDINACION.md`, `14_SESSION_RECOVERY_READMISSION.md`, la retrospectiva R3 y tu informe canónico. Revalida PR, SHA, CI, bases, límites de Staging y solapamientos antes de modificar. CI verde offline ≠ runtime PASS; el incidente #90 tuvo diez solicitudes pero 0/10 resultados verificados y OOM.

## Lote, ejecución y límites

Autorizo lecturas pertinentes de GitHub, Cloudflare y OpenCode Remote, investigación pública focal, pruebas offline y locales descartables, **rama R3 propia desde base exacta verificada**, commits solo de esta especialidad, PR draft, CI en el HEAD y documentación en GitHub. Después de probar, guarda copia del informe/fixtures no sensibles en Biblioteca personal **si está disponible y verifica recibo**; si no, entrega archivo descargable y declara pendiente. Evita microaprobaciones dentro de este lote. OpenCode es ejecutor preferente únicamente cuando disponga de un lease exclusivo comprobado, preflight y corte de gasto aplicable; sin ellos, desarrolla offline y declara autoría real de ChatGPT. **No usar Codex.** No merge, deploy, `main`, Producción, cambios a Workers, Access, secretos, bindings, migraciones, datos DO, recursos ajenos, cancelaciones ajenas, carga real 1→2→4→10 ni inferencia pagada. Una herramienta Remote aparentemente de lectura puede tener efectos: comprueba el contrato antes de usarla. No repitas operaciones ambiguas ni afirmes un coste total de cero si no está medido.

## Pruebas, publicación y cierre

Antes del parche, identifica defecto y criterio RED; reutiliza la solución mínima del código existente y comprueba commits/licencias de cualquier referencia externa realmente usada. Comprueba tests positivos, negativos y de carreras; ejecuta Bun, typecheck, builds, invariantes y CI pertinentes **del HEAD final**. Verifica exit codes, diff, actor, coste, alcance, base y dependencias. Evita workflows/commits redundantes. Documenta en `docs/f0-c10/` el resultado, fuente y SHA, pruebas, riesgos y conflictos, registra evidencias/PR en GitHub. **Cierra esta especialidad sin generar nuevo prompt ni otra ronda propia.** Produce exactamente un bloque titulado `HANDOFF A F0-C10/R3-T11`: RESULTADO (`PASS/PARTIAL/BLOCKED/FAIL`), base/HEAD, rama/PR, archivos, actor, cambios, tests/exit codes, CI exacto, métricas, costes conocidos/desconocidos, bloqueo, conflictos de integración, criterios de aceptación, ubicación/recibo de Biblioteca y **una recomendación concreta para T11**. PASS de tu área no significa COMPLETE PASS global.
<!-- END T10 -->

---

<!-- BEGIN T11 -->
# F0-C10/R3-T11 — Consolidación única de la tercera ronda y decisión de gate

Continúa **en este mismo chat maestro**, pero solo después de los handoffs R3-T01 a R3-T10, incluidos `PARTIAL/BLOCKED`. No solicites que el propietario copie diez informes: recupéralos de las PR, documentos y copias confirmadas en Biblioteca.

## Fuentes e identidad

Repositorio `aamvtrampa36-del/opencode-harness-example`, issue #90, plan integral R3, coordinación R3, retrospectiva, `docs/f0-c10/14_SESSION_RECOVERY_READMISSION.md`, PR #126/#143/#144/#145 y PR nuevas de cada especialista. Base histórica #145 HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`; **revalida ahora** rama, HEAD, CI, estado de ambas versiones Worker y estado Remote. GitHub manda sobre código; Cloudflare sobre binarios/despliegues; Remote sobre su runtime, nunca sobre la autoría de cambios de ChatGPT. No usar Codex.

## Lote de integración autorizado

Autorizo GitHub/Cloudflare/Remote **lecturas seguras**, investigación focal, pruebas offline/descartables, una **rama nueva propia de integración** desde el SHA verificado, commits acotados, PR draft, documentación GitHub, CI y copias no sensibles en Biblioteca con recibo. OpenCode puede ejecutar desarrollo solo con scope/lease exclusivo y corte técnico real de gastos demostrados; de otro modo implementa ChatGPT offline con autoría correcta. No usar herramientas Remote con efectos solo porque estén conectadas. **No merge, deploy, main, Producción, Access, secretos, bindings, migraciones, DO/Containers reales, cancelaciones ajenas, inferencia pagada ni campaña 1→2→4→10 sin un lote operativo posterior separado.**

## Trabajo obligatorio

1. Obtén todos los HANDOFF A F0-C10/R3-T11 desde GitHub/Biblioteca, incluso parciales, y construye matriz por área: PR, base/HEAD, actor, archivos, pruebas y exit codes, coste, CI del último SHA, runtime comprobado, riesgo y gate.
2. Audita que los diez aplicaron las correcciones de proceso de `docs/f0-c10/15_RETROSPECTIVA_Y_CONTROLES_R3.md`: lectura de contratos, identidad SHA, RED/GREEN, límite de ramas, no falsear runtime, coordinación de presupuesto y copy/UI. Marca desviaciones con consecuencias medibles.
3. Revalida la cadena apilada #126 → #143 → #144 → #145. Evita fusionar PR superpuestas dos veces. Compara conflictos semánticos de `src/server.ts`, `supervisor-admission.ts`, `supervisor-r2.ts`, `github-publication-durable.ts`, `dev-container.ts`, MCP y outputs. Selecciona la combinación mínima por funcionalidad/riesgo/CI, no por número de commits.
4. Crea una rama de integración aislada y PR draft; incorpora cambios compatibles con tests de comportamiento de efectos perdidos, doble start, readmisión slot 11, cancel/continue, legacy, fuga de memoria, procesos detached, doble POST GitHub, ACL y artefactos, budgeting y firmas E2E. No fuerces un hunk por contexto textual si contradice un estado transaccional nuevo.
5. Ejecuta Bun tests, preview, typecheck, build **de ambos Workers y web**, invariantes y harness E2E offline con negativos. Verifica en GitHub Actions todos los checks del **HEAD final exacto**. Registra cada fallo antes de repararlo, sin reintentos de CI inalterado.
6. Revalida por lecturas las versiones Staging; determina si el artefacto probado y los binding/assets coinciden o no con binarios publicados. NO publiques. No presentar PR, CI o mocks como autonomía OpenCode ni E2E de diez tareas.
7. Construye decisión `GO/STOP` documentada para futuro despliegue: reserva exclusiva con fencing, separación de staging/Prod, memoria aislamiento y limpieza, controles de proveedores/CI/Container medidos con **corte efectivo**, observador runtime independiente, rollback completo por Worker/DO/Container, integración Android y byte-readback.
8. Si y solo si existe **un lote de autorización posterior** de despliegue y carga y un preflight `GO` medido, podrá iniciarse 1→2→4→10 y tres rondas independientes de **diez tareas con intervalos reales simultáneos, diez respuestas íntegras y trazas firmadas**. Sin ese lote, cierra el gate de preparación como `PARTIAL/STOP`, no inicies ninguna tarea live.
9. Actualiza `docs/f0-c10/11_CONSOLIDACION_R3.md`, plan maestro y coordinación si cambia el estado; conserva informes y recibos verificados en GitHub y Biblioteca. Entrega PR/HEAD/CI/actores/estado runtime/costes y solo una siguiente decisión imprescindible; no generes automáticamente una cuarta ronda o diez prompts nuevos.

## Cierre

`RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`. `COMPLETE PASS` solamente con tres rondas autenticadas de diez ejecuciones realmente solapadas, sin OOM ni tareas huérfanas, con diez outputs recuperados/hasheados, aislamiento por proyecto, recuperaciones, límites de presupuesto y aceptación móvil cuando aplique. CI offline verde es `PASS` de integración fuente, **nunca** `COMPLETE PASS`.
<!-- END T11 -->

---


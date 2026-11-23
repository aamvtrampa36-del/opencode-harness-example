# F0-C10/R2-T11 — Reconciliación de session_create y readmisión durable de turnos

**Estado:** candidato de fuente aislado; los resultados de CI deben validarse en el HEAD final antes de aceptar. **No E2E live**, no despliegue ni merge. **Autoría:** ChatGPT mediante GitHub, no OpenCode Remote ni Codex.

**Origen:** [PR #144](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/144) en `baebc30a71dbaa8abca722c0780d4d658e2192c8`; incluye [#143](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/143), T03 #135 y T04 #136. Repositorio `aamvtrampa36-del/opencode-harness-example`, [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).

## Contratos y fuentes comprobadas

- `agents@0.33.0` en [cloudflare/agents/packages/agents/src/harness/opencode/harness.ts](https://github.com/cloudflare/agents/blob/agents@0.33.0/packages/agents/src/harness/opencode/harness.ts) declara `OpenCodeHarness.use(...)`, `OpenCodeHarness.create({id?})`, y llama a `opencode.sessions.get({sessionID})` en `#info`. `OpenCodeSessions.get(id)` **solo devuelve un handle, sin I/O** y no es prueba de existencia; `OpenCodeSessions.list()` enumera todo y no debe usarse aquí.
- `@opencode/sdk@2.0.24`, `@opencode/plugin@2.0.24`, `agents@0.33.0` fijados en `package.json`. La consulta `sessions.get({sessionID})` tiene semántica de lectura por clave; `SessionNotFoundError` es un error etiquetado `_tag` según el harness fijado. Los valores exactos de `Session.id` se comprueban.
- Las [reglas de Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) indican que `await` sobre efectos externos permite interleaving; las transacciones de storage protegen los read-modify-write y el fencing. No se usa `blockConcurrencyWhile` global ni se supone que un único DO tenga aislamiento físico de memoria.
- Estos contratos de fuente **no sustituyen** un ensayo con SDK/workerd real y fallo inyectado. La seguridad de `create({id})` con el mismo ID bajo ejecuciones externas simultáneas no se ha validado mediante E2E aquí; por eso **no** se repite `create` al recuperar una respuesta perdida.

## A. Session create con recibo perdido

1. T03 escribe `effect_unknown / session_create` bajo `token+generation` antes de invocar `harness.create({id:ses_r2_<requestId>})`, y persiste `sessionCreationAttempted=true`. No se permite hacer fork nuevo sin ID idempotente.
2. En el **reintento del mismo requestId y fingerprint**, solo si el ledger marca exactamente `effect_unknown/session_create` y la tarea es R2 determinista sin sesión vinculada, OpenCode hace **una lectura única y acotada** `harness.use(opencode => opencode.sessions.get({sessionID}))`. No hay `sessions.list()`, `history()` ni una segunda creación.
3. Si la sesión NO existe, si el SDK devuelve not-found, si hay timeout/error o se desconoce su propiedad, se mantiene `unknown/effect_unknown`, `confirmed=false`, sin liberar slot, sin reejecutar side effects.
4. Si la sesión existe con ID exacto, `reconcileSupervisorCreatedSession` verifica **en una sola transacción** el token/generation previo, estado de tarea, marker, `forkedFrom`, identidad determinista, mapeo inverso y `g8-scope`. Cualquier discrepancia queda `stale` o falla por conflicto de scope.
5. La transacción transfiere a `generation+1` con nuevo token, registra `task.session` y `supervisor:session:<id>` y deja el slot `reserved`. El original ya no puede confirmar su recibo con su token anterior. `supervisorCommitCreatedSession` sustituye la escritura no cercada del creador original y hace la confirmación de sesión y ledger **atómicas**.
6. El nuevo propietario intenta continuar `configure/submit` solo con el nuevo grant y lock de inicio. Si el lock antiguo persiste, se devuelve receipt para reintentar; el ledger no se degrada a `PASS` por ello. El marcador legacy sin identidad determinista jamás se reconcilia así.

**Límite:** una consulta positiva de existencia prueba la fila de sesión, no que todas las actividades del SDK hayan terminado. La corrección cerca los escritores del supervisor; no promete que un RPC externo todavía ejecutándose no tenga efectos adicionales. No hay reconciliación automática si no aparece la sesión por ID exacto.

## B. Readmisión de tareas terminadas sin exceder diez slots

- `reserveSupervisorContinuation` es una **única transacción** sobre `supervisor:admission:v1`, el registro `supervisor:task:<id>` y `supervisor:turn:<task>:<turn>`. No hay una segunda cola global.
- Solo para tareas R2, un nuevo turno de una tarea `finished`, con sesión y operationId estables, sin `pendingTurn` ni `cancelAmbiguous`, puede reocupar un slot. Se eliminan exclusivamente slots terminales sin efectos ambiguos, y se niega la readmisión con `CAPACITY_EXHAUSTED` cuando ya hay diez residentes. El antiguo `requestId` mantiene su fingerprint: un nuevo `turnId` produce un operationId distinto y su journal durable.
- Un turno recién reservado cambia su slot a `effect_unknown / turn_submit` **antes** de enviar el input nativo. No se libera por TTL si la respuesta se pierde; duplicar `turnId` solo devuelve el journal existente.
- Un recibo booleano `accepted` confirma la admisión y vuelve el slot a `running`, **pero el `pendingTurn` persiste** hasta recibo nativo terminal. Un error queda `unknown`, no dispara reenvío ni libera capacidad.
- `supervisedTaskStatus` reconcilia ese `turn_submit` exclusivamente con una finalización nativa válida `done` o `unanswered` terminal; `not_found`/timeout mantienen reserva y estado no verificado. La recuperación respeta cancelación concurrente.
- El código anterior que limpiaba slots terminales se endurece para **no** liberar tareas con `pendingTurn` o `cancelAmbiguous`. Un turno nuevo tras `failed`, `unanswered`, `cancel_requested` o `cancelled` permanece denegado, por diseño conservador.
- Compatibilidad legacy: tareas antiguas sin `sessionIdPolicy` conservan contrato anterior, y no se contabilizan falsamente como si estuvieran dentro del ledger nuevo. Una migración posterior es un gate separado.

## Evidencia y pruebas requeridas

`src/supervisor-t03-t04-integration.test.ts` amplía el test double transaccional: (a) GET exacto positivo y transferencia de token, (b) rechazo de commit tardío, (c) IDs/ownership incorrectos, (d) 10 slots + undécima tarea, (e) readmisión de la terminada, (f) dos HTTP simultáneos de igual turno, (g) overflow de slot reclamado, (h) submit ambiguo, not_found y native done. `src/supervisor-admission.test.ts`, `scripts/f0-c10-r2-t04-fault.test.mjs` y la suite global deben seguir verdes.

El workflow `.github/workflows/f0-c10-t03-t04-reconcile.yml` ejecuta `bun install --frozen-lockfile`, Bun focal + suite general, Node fault-injection, preview, typecheck, build Workers/web, invariantes, con comprobación del HEAD de la PR. Registrar ID, conclusión y exit codes **del último SHA**, no del antecesor. Toda esta suite usa mocks/fixtures y no prueba Cloudflare DO/SDK live.

## Bloqueos y gates

1. Validar la consulta `sessions.get` y el evento `SessionNotFoundError` con `agents@0.33.0`/`@opencode/sdk@2.0.24` instalados en DO local descartable, además de la carrera exacta pérdida de respuesta → reconcilia → original finaliza.
2. Revisar si la readmisión requiere separar `whenBusy:steer` y `whenBusy:followUp` según si la tarea ya terminó; mantener journal.
3. Aclarar cómo garantizar al **100 %** capacidad si las tareas legacy pueden seguir ejecutándose sin un slot T03.
4. Acreditar control real de gasto y límite de inferencia T07, perfilar OOM, auditar aislamiento y downloads Android.
5. Solo bajo autorización posterior y preflight, promover a Stage y ejecutar 1→2→4→10, tres rondas de diez activos y diez respuestas independientes. Nada de esto forma parte del encargo actual.

**Resultado del gate actual:** candidato de código + CI offline si verde. F0-C10 sigue `PARTIAL`. No merge, deploy, Producción, main, secretos, datos DO reales ni inferencia.

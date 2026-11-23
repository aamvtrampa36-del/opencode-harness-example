# F0-C10/R2-T11 — Conciliación focal T03 + T04

**Estado de este documento:** candidato de código, pruebas y CI pendientes al crearlo; actualizar recibo tras verificar el HEAD final.  
**Actor de implementación:** ChatGPT mediante GitHub; no OpenCode Remote, no Codex.  
**Issue:** [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).  
**Base exacta:** [PR #143](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/143) @ `160eafbb0e4842063e37c71425f1a5c2e08b18b2`.  
**Origen de recuperación:** [PR #136](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/136) @ `521257b214632d723a00e1efa9fad83f4c976ab8`.  
**Autoridad de capacidad:** [PR #135](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/135) incorporada en #143 a través de #138.  
**Rama aislada:** `f0-c10/r2-t11-t03-t04-reconcile-20261123`. Sin cambios en #143 ni ramas originales.

## 1. Conflicto y propiedad de contratos

| Responsabilidad | Autoridad seleccionada | Política preservada |
|---|---|---|
| Capacidad 10, identidad `requestId`, fingerprint, grant `token+generation` | T03 `supervisor-admission.ts` | Solo un ledger, ninguna segunda cola |
| Efectos externos `github_branch/session_create/configure/submit` | T03 `supervisorBeginExternalEffect/Confirm` | `effect_unknown` no expira ni reenvía automáticamente |
| Identidad de nueva sesión normal | T04 `r2SessionId()`, ID `ses_r2_<requestId>` | SDK/Harness fijado; `fork` NUEVO se rechaza antes de efectos |
| Continuaciones `turnId` y journal por sesión | T04 `supervisor-r2.ts` | Una continuación pendiente por tarea; operación nativa estable |
| Cancelación y polling | T04 transacción sobre `supervisor:task:` | Un poll/submit tardío no borra intent/cancel; nunca PASS ficticio |
| Publicación GitHub | T08, ya incluida en #143 | No sustituir su ledger, guardas de rama ni fencing |

## 2. Implementación

- `src/supervisor-control.ts`: suma `sessionIdPolicy`, `revision`, `pendingTurn` y `cancelAmbiguous`; no migra registros previos.
- `src/supervisor-r2.ts`: conserva helpers/contratos de T04, no añade un scheduler paralelo.
- `src/server.ts`: conserva las reservas T03; bloquea nuevos forks sin ID idempotente antes de efectos; crea sesión normal con `harness.create({ id: r2SessionId(job.id) })` **solo después** de la reserva write-ahead T03. El registro vinculado y el scope se persisten; el recibo perdido deja `effect_unknown` y jamás inicia un segundo create ciego. Para sesiones viejas se mantiene la política fail-closed.
- `remoteSupervisorContinue`: integra journal de T04, idempotencia por `turnId+hash`, rechazo de reintentos divergentes y un gate T03 **en la misma transacción del journal**: ninguna continuación si el slot está `reserved`/`effect_unknown`; una tarea nueva administrada por T03 tampoco puede reactivarse después de que su slot terminal haya sido liberado. Los registros legacy sin slot mantienen la compatibilidad histórica, pero no se consideran prueba de capacidad limitada. Esto cierra la carrera entre preflight de continuación y reclamación del slot por otra tarea.
- `supervisedTaskStatus`: fusiona lectura acotada de herramientas y `reconcileSupervisorSubmittedEffect` T03 con la reconciliación transaccional T04. `not_found` no equivale a finalización, y la actualización se protege contra un cursor nuevo o cancel.
- `cancelSupervisedTask`: conserva `hasSupervisorAdmissionSlot` al cancelar antes de sesión, y adopta las transacciones de turno/cancel de T04; sin operación nativa verificable el resultado es `unknown`, jamás `confirmed=true`.
- Los caminos configure/submit guardan respuestas mediante transacciones que consultan el registro vigente, no sobrescrituras ciegas con un objeto `job` obsoleto.
- Tests offline: `src/supervisor-t03-t04-integration.test.ts` combina T03 y T04; fixtures originales T04 se conservan; workflow focal ejecuta Bun, Node fault injection, typecheck, builds e invariantes.

## 3. Decisiones deliberadamente conservadoras

**No se implementó un reintento de `session_create` sobre `effect_unknown`.** Aunque T04 demuestra que el Harness actual acepta un ID fijado y el SDK reutiliza la identidad, no se ha demostrado que reiniciar una llamada externa después de una interrupción sea seguro frente a un invocador anterior aún ejecutándose bajo otro token. El identificador determinista elimina la ambigüedad del ID creado, **no constituye por sí mismo un recibo nativo ni cierre de la carrera**. El próximo gate requiere reconciliar la existencia exacta de ese ID de forma autenticada y una regla explícita de transferencia de fencing; jamás liberar un slot `effect_unknown` por TTL.

**Los `fork` nuevos quedan bloqueados.** Es un cambio visible de funcionalidad, limitado a R2, que exige revisión antes de promoción; las sesiones previas no se migran ni eliminan. Si el producto necesita forks, se requiere soporte idempotente real del SDK o protocolo aparte.

**No se prometen garantías de Cloudflare Durable Objects reales** desde un test double de transacciones. La suite es offline; no hay campaña Stage, costo de inferencia ni migración.

## 4. Evidencia requerida

Registrar en PR:
- HEAD exacto y base SHA; archivos y diff.
- Focal Bun T03+T04 y tests de fallos Node con exit 0.
- `bun test`, preview, `bun run typecheck`, `bun run build`, invariantes, exit 0 en GitHub Actions **del mismo HEAD**.
- Contrapruebas `scripts/f0-c10-r2-t04-known-red.red.mjs` con exit !=0 **esperado**; no agregarlas a suite verde.
- No despliegue, no inferencia y ausencia de prueba E2E Cloudflare.

## 5. Gating siguiente

1. Revisar semántica real de `harness.create({id})` en el SDK/Harness fijados y el rechazo de `fork` como decisión de compatibilidad.
2. Validar comportamiento con un DO aislado descartable y pérdida de respuesta, sin tocar sesiones históricas.
3. Resolver reconexión/operación una vez que el ID determinista exista pero el slot permanezca `effect_unknown`; si no se puede, conservar estado `unknown` y reportarlo.
4. Sumar control efectivo de costes de T07, perfil real de OOM y pruebas completas de aislamiento antes de pedir un lote de despliegue.
5. Solo tras autorización separada de operación real, ejecutar 1→2→4→10 con observabilidad independiente y tres rondas.

**F0-C10 = PARTIAL / NO COMPLETE PASS.** No modificar Workers/DO existentes, no merge, deploy ni carga real.

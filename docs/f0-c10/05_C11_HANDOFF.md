# F0-C10/R2-T05 → C11/T11 — Traspaso de integración verificado

**Preparado:** 2026-11-22/23 (America/Sao_Paulo). **Autoría:** ChatGPT, GitHub y Cloudflare **solo lecturas** salvo commits/documentación en la rama propia T05. **Estado:** `READY_FOR_C11_REVIEW / PARTIAL`. **No equivale a CI del futuro HEAD integrado, despliegue ni E2E.**

## 1. Recibo de continuidad e identidad

- Issue abierto: [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), OOM/concurrencia, sin COMPLETE PASS.
- Integración primera ronda: [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126) **draft, sin merge**, rama `f0-c10/t11-integration-20261122`, HEAD `1268ba22f26330d619b046fcf551ca846cb69d0f`. No se tocó.
- R2-T05: [PR #139](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/139), **draft** contra #126, rama `f0-c10/r2-t05-remote-mcp-20261122`; HEAD de partida (verde) `a907dd7fc34398e641386431521d6abcd723b495`; **revalidar HEAD final** de esta entrega después de añadir pruebas/handoff.
- T09 primera ronda: [PR #123](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/123), fixtures offline ya incluidos en #126.
- T09 R2: [PR #133](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/133), draft, HEAD `50742abdad67d9dc605bbd955693756eae371da5`, basada en la rama #123, **no** sobre #126. Su CI `45097584349` terminó `success` para el job `test-artifacts`; no es CI combinado de ambos Workers. No existe integración en #126 de esos endpoints.
- T10: primer instrumento seleccionado en #126 procede de [PR #119](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/119); no apareció una PR específica **R2-T10** entre las PR abiertas consultadas en este corte. Revalidar al integrar.
- Fuente de coordinación: archivo adjunto `F0_C10_COORDINACION_R2.md` (no mutar el maestro desde este especialista); referencia de integración en [`11_CONSOLIDACION.md`](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/f0-c10/t11-integration-20261122/docs/f0-c10/11_CONSOLIDACION.md).

### Entorno publicado (lecturas GET de esta entrega)

| Worker | Deployment | Versión activa | Tráfico |
|---|---|---|---|
| `opencode-g1-staging` | `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23` | `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` | 100% |
| `opencode-staging-control-mcp` | `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1` | `196240c0-1052-47b3-aaa7-02cf5baa87f0` | 100% |

Remote solo lectura: `status=ok`, `ready=true`, `supervisedCountAtLeast=96`, `supervisedCountComplete=false`. Los 96 son **cota inferior de sesiones indexadas**, no tareas activas.

## 2. Decisión para C11: seleccionar cambios por función, no fusionar toda la rama T09

**Motivo verificable:** `compare(126 HEAD ... 133 HEAD)` devolvió `diverged`, merge-base `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`, 31 commits ahead/40 behind. La rama #133 hereda `src/server.ts` y `src/staging-control-mcp/server.ts` **anteriores a las guardas de #106/#114**. En su fuente aún aparecen:
- `remoteSupervisorInspect` con `supervisedTaskTranscript` más `remoteSupervisorProgress(id,0)`;
- `supervisedTaskTranscript(id)` que deriva a `exportSessionData(session)`;
- `exportSessionData` que materializa `sessions.list/history/JSON.stringify`;
- `staging_task_transcript` que llama status, recupera el transcript y lo recorta **después**.

**STOP si un merge/port cancela la contención #106 o la protección R2 de #139.** No aceptar “git merge sin conflictos” como evidencia de integridad funcional.

### Composición mínima

1. Partir del **HEAD vigente #126** o del candidato C11 que lo contenga. Incorporar diff selectivo de #139 conservando: `projectSupervisorProgress` con pausa ante gap; `boundedMcpJsonText` en `result/callTask`; rechazo temprano `SESSION_EXPORT_PAGINATION_UNAVAILABLE_LEGACY`; pruebas y documento. No sobreescribir `supervisedTaskStatus/continue/cancel` de T03/T04.
2. Desde #133 incorporar solamente imports, módulos y operaciones T09 **nuevas**: `src/task-output-artifacts.ts`, `src/task-artifact-source.ts`, tests, `DevContainer.readTaskArtifact` revisado, RPC `scopedArtifactTask`/`supervisedArtifactCapture`/`supervisedTaskArtifacts`/`supervisedTaskArtifactDownload`, handlers REST `/tasks/:requestId/artifacts[/:artifactId]`, MCP `staging_task_artifacts` y `staging_capture_task_artifact`. NO copiar funciones legacy completas.
3. Mantener el orden del router: **Access + bearer server-side**, luego rutas `/artifacts` y solo después la expresión general `/tasks/:requestId`. Nunca aceptar `/bundle` ni tokens en URL. La captura `POST` y el tool MCP `staging_capture_task_artifact` **son mutaciones**; no tratarlas como lecturas, aunque `staging_task_artifacts` sea consulta.
4. El nuevo helper de serialización R2 de #139 conserva el manifiesto acotado de T09 (8 entradas con `requestId/artifactId/name/mime/byteSize/sha256/delivery`). Tests añadidos en T05 cubren el caso normal y el truncado. **No prueban el ensamblado efectivo** con #133; C11 debe correr pruebas conjuntas.
5. Reconciliar además `src/dev-container.ts` entre #133 (lector de bytes T09) y T06 [#132](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/132) / revisión T11 [#137](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/137). No permitir que un cambio de proceso restaure rutas Linux inseguras o que el lector ejecute fuera de Container autorizado.

### Riesgo de lectura bajo carga que T09 debe cerrar

En #133, `supervisedTaskArtifacts(id)` invoca `supervisedTaskStatus(id)` para construir el manifiesto. Esta lectura puede ejecutar `wait(operationId)`, `busy()`, `log()` y escrituras de estado/métricas en #126; **no es un snapshot O(1) demostrado**. Una lista de artefactos leída diez veces durante carga puede amplificar trabajo. Recomendación C11/T05/T09: obtener `status`/ID de operación del ledger durable con semántica explícita de `snapshot/asOf`, no invocar `wait()` ni `history()` para un simple GET de manifiesto. Para captura puntual, exigir recibo terminal legítimo antes de persistir bytes y mantener operación explícita de efecto. No modificar esta función de otra rama sin seleccionar/auditar el diff en C11.

## 3. Contrato T10: no transformar observación incompleta en PASS

En el `scripts/f0-c10/evaluate.mjs` de #126, `status_probe` se acepta para lectura bajo carga si `e.underLoad && e.status==="ok"` y cae dentro de un intervalo; el bucle registra latencia y detecta `unknown/not_found`, **pero no inspecciona explícitamente `_responseTruncated`, `gapDetected`, `truncated` o `toolCountsComplete`**. Por tanto, es posible construir una traza sintética con `status:"ok"` y `gapDetected:true` que el evaluador no invalide por ese atributo. Eso **no demuestra** una vulnerabilidad del Worker, sí una condición insuficiente del validador.

**Requisito mínimo de C11/T10 para live:**
- Rechazar `status_probe` con `_responseTruncated===true`, `gapDetected===true`, estado desconocido, cobertura incompleta si se afirma completa, cursor regresivo o fuera de tarea; codificar falla explícita `UNTRUSTED_STATUS_PROBE` / `PROGRESS_GAP` / `CURSOR_REGRESSION`.
- Los tests negativos deben añadir `status_probe.status="ok", gapDetected=true` y `_responseTruncated=true`, y exigir `pass=false` aun con diez intervalos y artefactos sintéticos correctos.
- Una lectura normal de progreso puede tener `truncated:true` porque **hay siguiente página**; no tratar automáticamente eso como fallo irrevocable: recuperar páginas con `after`, comprobar ausencia de gaps hasta estado terminal, límites de visitas/presupuesto y que `nextAfter` sea monotónico. Un `truncated` sin recuperación completa **no** puede confirmar resultado.
- La respuesta MCP `verified:false`/ `passed:false` del supervisor no equivale a fallo de toda la tarea, pero exige **evidencia independiente** antes de que el evaluador certifique 10/10. `finished` no es `verified`.
- Para T09 R2, el `byteReadback:"captured"` y `collectorVerification:"pending"` del manifiesto **no constituyen** descarga verificada. T10 debe obtener el GET autenticado completo por `artifactId`, validar bytes/hash y correlación `requestId/sessionId/operationId`. No anunciar 10/10 desde el manifiesto.

El fixture T10 de #119 verifica readback mock, pero **no demuestra** que el backend nuevo de #133 esté desplegado, ni que Android pueda obtener el bearer. C11 debe conservar la condición de NO LIVE hasta autorización, lease atómico y corte efectivo del gasto.

## 4. Pruebas y control de riesgo para C11 (sin despliegue)

| Gate | Prueba exigida en HEAD integrado | Resultado actual T05 |
|---|---|---|
| Rutas peligrosas | `src/supervisor-transcript-containment.test.ts` y nuevas negativas `exportSessionData` | PASS en CI #139 previo; no ejecutado sobre la combinación |
| Cursor / eventos enormes | `src/supervisor-progress.test.ts`: gap, reasoning, duplicados, 8 MiB sintéticos, 10 lectores | PASS anterior #139 |
| MCP | `src/staging-control-mcp/bounded-response.test.ts` y `server.test.ts`: manifest T09, truncado, claves sensibles, `isError`, 10 consultas | Fixture T09 nuevo en PR #139; CI nuevo pendiente |
| T09 | `node --test src/task-output-artifacts.test.mjs src/task-artifact-http.test.mjs src/task-artifact-source.test.mjs`; `src/staging-control-mcp/server.test.ts` con las tools nuevas | PASS separado #133, no combinado |
| T10 | `node --test scripts/f0-c10/evaluate.test.mjs` + negativos `gap/truncated` y `node scripts/f0-c10/run-offline.mjs --suite` | PASS anterior en #126; nuevos negativos pendientes |
| Regressions | `bun test`, `bun run typecheck`, `bun run build`, `bun scripts/check-invariants.mjs`, preview, CI del HEAD exacto | PASS separado #139, HEAD combinado futuro desconocido |
| Runtime / Android | versión y bytes publicados de ambos Workers, lectura bajo carga, errores de auth y GET completos desde Android | NO PROBADO / autorización separada |

**No declarar contrato seguro porque un output de `tools/call` cabe en 16 KiB.** El límite del MCP se aplica *después de recibir* el objeto RPC, no protege memoria del Worker principal. SDK `agents@0.33.0` todavía no ofrece, de forma verificada, proyección de contenido antes de materializar un evento crudo. No simular transcript con `history().slice()`; las sesiones heredadas responden `SESSION_EXPORT_PAGINATION_UNAVAILABLE_LEGACY`, sin borrado de datos.

### Orden sugerido de integración en C11 (reversible)

1. Congelar refs de #126/#139/#133/#132/#137 y latest CI, detectar nueva R2-T10. Auditar diff por ruta en rama **nueva de C11**; no escribir las ramas originales.
2. Aplicar T05 #139 y asegurar tests. Seleccionar solo funciones T09 nuevas; cruzar Linux con T06. Implementar snapshot barato para `GET artifacts` o dejar endpoint bloqueado para carga live.
3. Añadir negativos T10 para status gap/truncado y colector de bytes; garantizar error conservador y hashes reales.
4. Ejecutar CI completo y fixtures por HEAD (sin Staging). Registrar actor, SHA, diff, exit codes y reporte C11. Si hay fallo, **PARTIAL/FAIL**; no promover.
5. Preparar preflight runtime posterior: lease global + fencing, gastos medidos con corte, fuente→deploy SHA, dos Workers compatibles, rollback sin tocar DO persistent de forma accidental. Requiere lote nuevo antes de cualquier deploy/inferencia.
6. Solo después, con autorización aparte, pruebas progresivas 1→2→4→10 y tres rondas de 10/10 verdaderamente activas, archivos auténticos y 0 OOM/huérfanos; no cerrar #90 prematuramente.

## 5. Autoría, efectos, coste, STOP y fuentes

- **Autoría T05:** ChatGPT (código/fixtures/handoff). `OpenCode Remote` usado exclusivamente para `staging_status` y consultas no mutativas históricas. No se invocó `staging_start_task/continue/cancel`, `staging_mcp_call`, ni pruebas masivas.
- **GitHub:** lectura PR #126/#139/#133/#119/#132/#137, fuentes y CI; escrituras exclusivamente en rama T05 y texto de su PR. No merge.
- **Cloudflare:** GET para versiones y despliegues; ninguna operación POST/PUT/DELETE, tráfico, binding, secreto, Access, migración ni Container modificado.
- **Coste:** 0 llamadas de inferencia iniciadas en este trabajo, 0 despliegues, 0 pruebas vivas; minutos/factura GitHub Actions no medidos. No afirmar costo monetario cero.
- **STOP:** lectura de historial completo no acotado, retroceso/salto de cursor sin reconciliar, resultados solo de texto no verificables, transición de `passed/verified` por clipping, mezcla de proyecto/artefacto, lease o control de coste ausente, SHA/no coincidencia de versión, OOM, cambio de permisos, fallo de tests o fuente incierta.
- **Fuentes directas:** [#139](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/139), [#126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126), [#133](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/133), [#119](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/119), [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) y `F0_C10_COORDINACION_R2.md` adjunto al proyecto.

**Resultado:** `HANDOFF_C11_READY` cuando la PR T05 contenga este archivo y los tests de compatibilidad pasen CI del HEAD exacto. **F0-C10 global:** `PARTIAL / NO COMPLETE PASS`.

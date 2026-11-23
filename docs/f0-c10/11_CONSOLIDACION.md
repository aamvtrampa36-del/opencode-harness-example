# F0-C10/T11 — Consolidación y candidato integrado (sin despliegue)

**Fecha:** 2026-11-22 (America/Sao_Paulo). **Actor de esta integración:** ChatGPT mediante GitHub; **no** OpenCode Remote, **no** Codex. **Estado:** `PARTIAL / INTEGRATION_CANDIDATE / NO LIVE ACCEPTANCE`.

**Base canónica de integración:** `staging/opencode-g1-rpc-safe-20261120` @ `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`, comprobada idéntica por GitHub Compare. Rama de trabajo aislada `f0-c10/t11-integration-20261122`. No merge, deploy, ni escritura en Producción, Cloudflare o DO.

## 1. Matriz de las diez líneas de trabajo

| Área | PR | Resultado propio | Acción T11 |
|---|---|---|---|
| T01 diagnóstico OOM | [#116](../../pull/116) | Observabilidad histórica y RED/GREEN sintético; raíz total no probada | Incorporar informe, no duplicar la guarda #106 |
| T02 memoria/DO | [#115](../../pull/115) | Prototipo de retención; aislamiento físico no demostrado | Incorporar benchmark offline; no migrar DO |
| T03 admisión | [#125](../../pull/125) | Modelo offline; no scheduler durable productivo | Integrar fixtures, dejar implementación real pendiente |
| T04 recuperación | [#120](../../pull/120) | Journal conservador de session creation, tests y CI | Candidato en `src/server.ts` y `src/supervisor-control.ts`; requiere fault injection real |
| T05 Remote/MCP | [#114](../../pull/114) | Paginación de progreso acotada, tests y CI | Candidato de cursor sobre log; no soluciona todo transcript |
| T06 Linux | [#121](../../pull/121) | Timeout kill-after, fixture local; CI | Importar cambio y tests sin tocar #105 |
| T07 inferencia | [#117](../../pull/117) | Simulador offline; 10 tareas no equivale a 10 inferencias simultáneas | Solo pruebas/documentación, sin nuevo rate gate |
| T08 GitHub | [#122](../../pull/122), [#124](../../pull/124) | Reconciliación de PR + contraprueba de race; dos PR alternativas | Elegir código/informe de #122 y prueba independiente de #124; **lease global NO implementado** |
| T09 outputs | [#123](../../pull/123) | Contrato de artifact y readback real en loopback | Integrar fixtures; endpoint autenticado real pendiente |
| T10 harness | [#118](../../pull/118), [#119](../../pull/119) | Harness offline; #119 agrega comprobación de bytes recuperados | Elegir #119, reemplaza archivos duplicados de #118 |

**Antecedente obligatorio:** [#106](../../pull/106) F0-OOM-02 agrega contención fail-closed de transcript en el Worker principal y MCP. Es candidato, **no** está desplegado. Sus piezas complementan #114 y #120.

## 2. Cambios integrados en esta rama

- `src/server.ts`: aplicación por hunks verificados de #106, #114 y #120 desde el mismo baseline. **Aplicación textual sin conflictos NO es verificación funcional**. Se incorporan guards de transcript, proyección de progreso acotada y persistencia conservadora de intento de creación de sesión.
- `src/staging-control-mcp/server.ts` y tests de #106: protección del MCP antes de leer historial completo.
- `src/supervisor-progress.ts`, su test, `src/supervisor-control.ts`, `src/supervisor-recovery.test.ts`: auxiliares #114/#120.
- `src/dev-container.ts`, fixture T06: manejo de timeout #121.
- `src/github.ts`, prueba de conflictos #122 y test de auditoría alterno #124.
- Harness offline T10 seleccionado de #119; fixtures T09 de #123; fixtures de admisión T03, inferencia T07 y memoria T02; informes propios T01–T10.

Todos los archivos en los demás PR se conservaron sin alterarlos. Este candidato no toca bindings, migraciones, tokens, permisos, Assets ni rutas de Producción.

## 3. Conflictos y decisiones

1. **#118/#119** cambian exactamente los mismos siete paths: integrar solamente **#119**, que ya se apoya en #118 y añade lectura/verificación de bytes. No fusionar ambos.
2. **#122/#124** colisionan en `docs/f0-c10/08_GITHUB_INTEGRIDAD.md`: usar informe y código de **#122**, más prueba independiente `scripts/f0-c10-t08-integrity.test.mjs` de **#124**. La carrera TOCTOU de dos POST no está reparada.
3. **#106/#114/#120** modifican `src/server.ts`: se aplicaron hunks sobre la misma base sin ambigüedad y se requiere CI combinado + pruebas reales. No usar como comprobante de seguridad una simple coincidencia textual.
4. **#117** apunta a una base histórica diferente, pero sus tres paths son nuevos y se integraron como fixtures aislados. No seleccionar proveedor de pago por defecto.
5. #106 bloquea transcripts completos de forma temporal; #114 permite progreso paginado, **no restauración segura de transcripts**. El requisito de archivos descargables reales sigue pendiente.
6. T03 propone control durable de admisión; no se ha instalado. No poner límite artificial de dos ejecutores como prueba de diez activos.
7. El cambio T04 reconoce un límite: una sesión creada sin confirmación del SDK puede quedar huérfana. El journal impide un replay ciego, **no permite necesariamente reconciliación completa**.

## 4. Verificaciones y límites

Cada PR #114–#125 declaró o presentó un run GitHub Actions con `completed/success` en su HEAD exacto, cotejado en T11 a través del conector GitHub. **Esto no certifica la combinación**. La CI de esta rama se debe ejecutar en una PR draft y su resultado debe registrarse para el HEAD de integración.

Consulta directa de Cloudflare (lectura T11): `opencode-g1-staging` deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` al 100%; MCP deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, versión `196240c0-1052-47b3-aaa7-02cf5baa87f0` al 100%. Ninguno fue modificado por esta integración. Remote read-only `status=ok`, `supervisor.ready=true`, `supervisedSessions>=96` y `supervisedCountComplete=false`: no prueba sesiones activas ni diez tareas.

**No se hicieron pruebas de carga**, invocaciones de `staging_start_task` ni inferencia. No hay un lease atómico con fencing ni corte efectivo del coste integral demostrado. Detener cualquier prueba viva que requiera esas precondiciones.

## 5. Gate pendiente antes de cualquier despliegue o prueba masiva

1. CI del **HEAD integrado**: Bun tests, typecheck, build, invariantes y harness offline. Corregir solamente en rama de integración, sin afectar PR de especialistas.
2. Auditoría técnica del cambio combinado de `src/server.ts`, coherencia con #106 en ambos Workers y revisión del origen binario.
3. Implementar y probar admisión durable con límite de capacidad **sin reducir para siempre los diez activos**, reconciliación journal y exclusión con fencing para escritor GitHub y ejecución Remote.
4. Medir heap en workerd/SDK y demostrar límite antes de considerar sharding arquitectónico.
5. Añadir telemetría independiente para intervalos reales de herramientas/inferencia y readback de artefactos auténticos (no solo marcas de JSON).
6. Probar endpoints de descarga autenticados y Android, no confundir rutas `/bundle` con enlaces.
7. Preflight de ambos Workers, tokens/scopes, assets, Workflow/Containers/DO, rollback y presupuesto con corte técnico efectivo: los bloqueos previos de #113 siguen vigentes.
8. Sólo tras nuevo lote de despliegue y carga autorizado, escalar 1→2→4→10 con **tres rondas de 10/10 verificadas**, 0 OOM/huérfanos/mezclas y 10 intervalos simultáneos genuinos. El harness #119 es instrumento, no evidencia de capacidad instalada.

## 6. Decisión

**F0-C10 = PARTIAL / NO COMPLETE PASS.** El candidato integrado es material para revisión y CI, **NO despliegue aprobado ni aceptación E2E**. No cerrar [issue #90](../../issues/90). Conservar PR originales y no fusionarlas automáticamente. El siguiente lote debe resolver primero validación combinada, lease/costes y riesgo de sesión huérfana; después plantear un despliegue controlado por autorización separada.

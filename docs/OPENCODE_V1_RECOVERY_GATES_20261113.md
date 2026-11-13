# OpenCode Cloud V1 — Estado comprobable de recuperación y publicación

## Corte de Producción V1 publicada — 13 noviembre 2026 UTC

**ESTADO VERIFICADO:** Publicación técnica de OpenCode Cloud V1 efectuada, **sin declarar aún PASS funcional autenticado en Producción**. Se conservó el riesgo residual de pérdida de historiales prescindibles aceptado expresamente por el propietario. Esta sección prevalece sobre la matriz histórica de publicación pendiente y sobre los bloqueos B2 integral/RPO-RTO anteriores.

| Gate | Resultado | Evidencia |
| --- | --- | --- |
| Autorización del titular | **APROBADA** | Permiso expreso para fusionar PR #47, desplegar y revertir ante fallo crítico; afirmó no tener trabajo importante sin respaldo GitHub |
| PR #47 → `main` | **PASS** | PR fusionada, SHA de merge `9549448fc627b367cb22db4617261a50b6f56983`; HEAD candidato previo `31f794238eecd679ca38993914a8c03e4d9f1115` |
| CI de candidata | **PASS** | GitHub Actions `43367568532`: tests, preview, TS, build e invariantes |
| Build + deploy producto | **PASS** | Cloudflare Build `25e5e8bf-f6b7-437c-983e-8eef1d038f44` `stopped/success`, commit `9549448fc627b367cb22db4617261a50b6f56983`; Worker Prod `3a908ed2-8e54-400d-a071-fd49d665a36c` 100% del tráfico |
| Configuración / control de acceso | **PASS configuración** | Migración DO `v3`; bindings OpenCodeAgent, DEV, SETTINGS y AI/LOADER; variable `OPENCODE_SUPERVISOR_ENABLED` false. Cloudflare Access para hostname Prod `self_hosted`, una política, sin debilitar autenticación |
| Reversión disponible | **PASS referencia de versión** | Worker previo `1d70eb77-316e-408d-bd14-5f19b171dedf` sigue en historial; ensayo conjunto en Staging PASS. No se ha ejecutado rollback productivo destructivo |
| Test E2E autenticado de Producción | **PENDIENTE** | La interfaz privada tras Access requiere sesión autenticada del titular. No existe evidencia independiente del flujo sesión → herramienta → proyecto real en Prod |
| Pérdida de historiales SQL/KV | **ACEPTADA/NO BLOQUEA** | El titular acepta pérdida de conversaciones recientes y estado interno prescindible. B2 ampliado cancelado, evidencia SQL de ensayo preservada |

**Configuración de Builds antes de la publicación:** se corrigió la configuración ya existente del Worker Prod (rama `main`) para ejecutar `bun install --frozen-lockfile && bun test && bun run typecheck && bun scripts/test-preview.mjs && bun scripts/check-invariants.mjs && bun run build` y `bunx wrangler deploy`. Se conservaron token, repositorio y auto-build; sin nuevos servicios.

**Evidencias limitadas:** el despliegue de Worker y los metadatos de Access prueban instalación y configuración, **no** que un usuario autenticado pueda interactuar correctamente. No confundir test de Stage ni HTTP de CI con smoke productivo. Los mecanismos GitHub respaldan commits y proyectos confirmados, no historial prescindible ni archivos Linux no confirmados. El propietario confirmó aceptar este alcance.

**Único cierre pendiente:** prueba manual mínima desde Android sobre `https://opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev`: ingresar por Cloudflare Access, abrir una sesión nueva, ejecutar una herramienta y comprobar que los cambios de prueba permanecen en una rama autorizada. Sin evidencia de esa interacción no declarar G9 cerrado integralmente. Si surge error funcional crítico, reevaluar reversión a versión anterior según controles reales (el rollback de Worker no revierte DO ni otros datos).

**Nota de trazabilidad:** futuras ediciones puramente documentales de `main` pueden originar nuevas builds del mismo código. Verificar la versión productiva efectiva antes de registrar cierre final.

---



## Contrato de aceptación vigente: V1 personal pragmática (13 de noviembre de 2026)

**DECISIÓN DEL PROPIETARIO: recuperar lo suficiente, no recuperar todo.** Este proyecto es privado, no comercial y de uso individual. El propietario **acepta expresamente** perder conversaciones recientes, historiales y estado interno prescindible de OpenCode ante fallos graves, siempre que se preserven los proyectos, archivos importantes y cambios de código confirmados. Esa aceptación **sustituye el anterior requisito de B2 integral como gate obligatorio de publicación**. Los apartados B2 y «Decisiones y protección» históricos más abajo conservan su valor de auditoría, pero NO representan los criterios vigentes.

### Matriz de cierre actual y evidencias

| Requisito vigente | Estado verificable | Decisión |
| --- | --- | --- |
| UI Android utilizable y autodesarrollo real con herramientas y PR | PASS histórico en Staging | Acta G9 §12, matriz E2E 12/12, PR #30 y CI #300; sin regresión observada |
| Aislamiento, permisos y bloqueo de ramas/repos indebidos | PASS para escenario probado en Staging | Guards del repositorio, supervisión y tests; mantener Access/credenciales |
| Persistencia de código confirmado en GitHub | PASS mecanismo | Commits/ramas/PR verificables; **NO** confundir con protección de archivos locales no confirmados |
| Restauración práctica de Container y reversión Worker/Container/DO | PASS en fixture descartable, no en datos productivos | `g9_joint_fix_verify_20261113_01`, `oc_v1_external_r2_real_drill_20261113_01` |
| Recuperar todos los KV, SQL e historiales y RPO/RTO formal | **ACEPTACIÓN DE RIESGO / NO BLOQUEA** | `g9_session_cacheexcluded_real_20261113_01` pasó SQL, pero no se necesita restauración total |
| Archivos irrecuperables fuera de GitHub | **PENDIENTE COMPROBACIÓN PREPUBLICACIÓN** | Verificar si existen en proyectos reales; respaldar solo los indispensables o confirmar que no los hay |
| Candidata exacta, CI de código, configuración y reversión compatible | **PARCIAL** | PR #47 está draft; los principales archivos compartidos con Staging coincidían en SHA de GitHub al verificar; integración de las herramientas de B2 SQL exclusivas de Staging NO es obligatoria |
| Producción V1 operativa: autorización, despliegue y pruebas funcionales | **PENDIENTE** | Worker productivo observado `1d70eb77-316e-408d-bd14-5f19b171dedf` al inicio de este corte; comprobar versión otra vez antes de actuar |

**Trabajo descartado por rendimiento marginal:** el agente de B2 integral `b2fda8136e4c902a` fue cancelado ordenadamente por Workflow `g9_pragmatic_cancel_b2_20261113_01` con `status:cancelled`. Su rama `opencode/staging-b2fda8136e4c902a` no contenía commits nuevos al compararla; 62 herramientas, una fallida al último seguimiento. No se elimina el código SQL/R2 ya ensayado ni la evidencia de CI.

**Respaldo/configuración de referencia:** recibo privado R2 `evidence/g9-production-readonly-preflight-20261113.json` (3051 bytes, SHA-256 `7a348a50f6c9e809b745eebe30538f9e0a442b7286eafd27f2ee7386f771b749`, releído y cotejado). Solo contiene versiones y bindings, **no un respaldo de datos de Producción**. Producción aún carecía de `RECOVERY_R2`, `SESSION_BK` y Workflow; mantener el esquema v1-v3 de `wrangler.jsonc` y evitar migraciones de clases exclusivamente de Staging en Producción.

**Bloqueo restante real:** comprobar/proteger los archivos únicos que pudieran existir fuera de GitHub; congelar el commit exacto de la candidata #47 y validar CI pertinente; confirmar alcance de cambios de configuración y autorización productiva específica; desplegar y verificar el flujo autenticado real de acceso/sesión/herramientas/proyecto. No exigir recuperación completa de sesiones ni RPO/RTO formal. No declarar publicación antes de smoke en Producción.

**Después del cierre:** uso estable de OpenCode Cloud para CDF Cloud/WorkBench, mantenimiento correctivo y mejoras de recuperación solo si aparecen problemas reales.

---



## Corte independiente posterior — B2 SQL y C aprobados (13 noviembre 2026 UTC)

**La matriz histórica que sigue corresponde a un corte anterior y se mantiene como trazabilidad; ESTE apartado prevalece para los resultados comprobados más recientes. G9 sigue ABIERTO: no se ha ejecutado publicación productiva.**

| Gate | Estado real | Evidencia |
| --- | --- | --- |
| Autodesarrollo y CI recuperable | PASS Staging | PR #39, #53; [Actions #43361777201](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/43361777201), 273 tests, 0 fallos |
| A/B1: Container + R2 sintético | PASS fixture | Workflows `oc_v1_full_snapshot_drill_20261112_02` y `oc_v1_external_r2_real_drill_20261113_01` |
| C: Worker+Container+DO rollback conjunto | PASS fixture real Staging | `g9_joint_fix_prepare_20261113_01` + `g9_joint_fix_verify_20261113_01`, Worker revertido y restablecido; `passed:true` |
| B2: SQL sesiones reales de prueba | PASS Staging, alcance SQL | `g9_session_cacheexcluded_real_20261113_01`: `passed:true`, 20 tablas, 3 sesiones; `sqlDigestsMatch:true`, `normalReadsMatch:true`, `cleanupOk:true`, origen y destino DO distintos |
| B2 integral: metadatos KV+archivos+asociaciones | **BLOQUEA CIERRE** | SQL `opencode_*` no contiene `supervisor:task:*`, `supervisor:session:*`, `g8-scope:*` ni el estado de archivos Container |
| D: preparación, backup y publicación productiva | **NO REALIZADO** | No hay preflight completo ni CI/E2E de una candidata exacta que incorpore todos los cambios ni pruebas prod |

**Versiones comprobadas:** Staging commit `b0b7fae2058f500a42064827cd2443f34964f343` / Worker `3036b35a-f00d-4a82-9d94-ccd86b8c0e19` (100%); Producción Worker `1d70eb77-316e-408d-bd14-5f19b171dedf` (100%, intacto). La PR #47 continúa draft; su rama de lanzamiento todavía no coincide con el HEAD de Staging. No atribuir al nuevo corte evidencia de producción.

**Bloqueo arquitectónico de publicación:** `wrangler.jsonc` de Producción conserva `main: src/server.ts`, DO bindings `OpenCodeAgent`, `DEV`, `SETTINGS` y migraciones v1–v3, **sin R2 RECOVERY_R2**. La configuración `wrangler.g1.jsonc` de Staging utiliza `src/entrypoint.ts`, clase `SessionBackupDrillAgent` en `SESSION_BK` (migración v4), R2 y Workflow privado. La clase y Workflow del drill están diseñados únicamente para Staging. **No copiar ciegamente la configuración Staging a Producción**: las migraciones de clase DO pueden impedir rollback. Antes de promover, se requiere un procedimiento genuino de respaldar/restaurar los datos productivos conservando la compatibilidad, y una configuración apta para Production explícitamente revisada.

**Recuperación técnica:** usar `ctx.storage.list/get/put/transaction` (KV de DO no es legible mediante `sql.exec` de su tabla interna); preservar relaciones entre sesiones, tareas, ámbito del proyecto, rama/commit Git y archivos. Exportación consistente a R2 con hashes y rechazo de manifiestos corruptos; restauración íntegra en entidades de ensayo nuevas. No reabrir C ni B2 SQL sin regresión. Medir RPO y RTO representativos: los ~2,23 s de restauración de un fixture pequeño NO son RTO productivo.

**Intervención actual:** OpenCode supervisor tarea `b2fda8136e4c902a`, rama aislada `opencode/staging-b2fda8136e4c902a`, aborda la parte pendiente de B2. Su trabajo requiere PR borrador, CI independiente y prueba real de RESTAURACIÓN INTEGRAL antes de integrarse. No es una prueba aprobada ni autorización de lanzamiento.

**Siguiente paso tras B2:** congelar candidata exacta, evaluar enlaces/bindings productivos, CI + recuperación negativa y funcional, generar backup de Producción recuperable, verificar compatibilidad de rollback, ejecutar publicación solo con autorización aplicable, realizar smoke real y registrar el resultado. No inventar G10; el próximo tramo es operación estable y mantenimiento de OpenCode para CDF Cloud y WorkBench.

---


**Corte:** 2026-11-13 UTC. **Autoridad:** evidencias independientes GitHub Actions, Cloudflare Worker Deployments, Workflows y R2 privado. **Objeto:** OpenCode Cloud, no CDF Cloud ni WorkBench.

**Dictamen:** todavía NO apto para promoción a Producción. El autodesarrollo, las pruebas recuperables y la recuperación de un Container descartable tienen evidencias positivas. El backup externo real de prueba también ha pasado. **NO** se ha verificado la restauración de archivos/sesiones reales ni la recuperación conjunta final Worker+Container+DO.

## Versiones y protección de datos

- Candidato de **Staging**, fuente `feat/staging-supervisor-control-20261111`, commit de aplicación `7edac1089b75983d41c76c8fb8d8a26df70ea0c1`, Worker desplegado `292dfe34-c55b-487c-99ed-f84c4797bb2c` al 100%.
- **Producción** `opencode-harness-example` versión `1d70eb77-316e-408d-bd14-5f19b171dedf` al 100%, SIN despliegues nuevos ni datos modificados durante estos ensayos.
- Release PR #47 es **borrador**, no fusionar hasta demostrar recuperación íntegra y autorizaciones.
- R2 privado `opencode-v1-recovery-20261112` con binding **solo** de Staging `RECOVERY_R2`. Sin rutas públicas ni ampliación de ACL. La configuración de Producción NO incluye este binding.
- Cloudflare Build `e6f33ee4-765a-4da7-9c53-92c1d785eb55`: SUCCESS, **245 pass / 0 fail**. Fijado `packageManager=bun@1.4.4` porque el build anterior escogió Bun 1.2.15, incompatible con el lockfile v2. GitHub PR #50 CI `43349543927` SUCCESS; PR #47 sobre commit candidato `43350973670` SUCCESS.

## Puertas y pruebas

| Criterio | Dictamen | Prueba verificable |
| --- | --- | --- |
| Autodesarrollo remoto, aislamiento de tareas y PR | PASS Staging | Supervisor privado, PR #39–#49, Workflow status, branch propia y CI |
| E2E recuperable tras interrupción | PASS | Actions [#43261446743](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/43261446743), 8 etapas, HTTP 200/200/404/403/405, hash de recibos |
| A. Container destruido y restaurado | **PASS en fixture** | Workflow `oc_v1_full_snapshot_drill_20261112_02`: mismo DO y otro DO, snapshot real, 7 checks de cada restauración, cleanup verificado, recibo R2 `evidence/live-snapshot-drill-20261112-02.json` |
| B1. Respaldo EXTERNO R2 y restauración desde otro DO | **PASS con fixture sintético** | Workflow `oc_v1_external_r2_real_drill_20261113_01`, `passed:true`, origen destruido, `crossRestorePassed:true`, controles de bytes alterados/ausentes, `cleanupOk:true`; recibo R2 `evidence/real-external-r2-drill-20261113-01.json` |
| B2. Archivos reales, sesiones, DO y estado aplicativo completos | **PENDIENTE** | B1 respalda SOLO el proyecto sintético `extbkc-*` y metadatos `ses_extbk_*`; ninguna restauración integral de datos reales demostrada |
| C1. Rollback de Worker de Staging | **PASS** | Cambió 100% `292dfe34` → `8fe0f537` (deployment `977a9d56`) → `292dfe34` (deployment `db78a519`). Workflow supervisor confirmó persistencia de sesión previa después del rollback |
| C2. Rollback CONJUNTO Worker+Container+DO+archivos | **NO PASS / verificación bloqueada** | `joint_prepare` PASS, nonce `871ea5456848`, snapshot `56a36205-4bee-4b07-b5f8-95ba55634d90`; la llamada `joint_verify_cleanup` fue bloqueada por controles de seguridad de la plataforma. NO se ejecutó. |
| D. Publicación de V1 y smoke test productivo | **NO REALIZADO** | Depende de B2/C2, respaldo productivo previo y recuperación verificable. Versión de Producción intacta. |

### Evidencia independiente del ensayo B1

- Origen: `extbkc-a-f7115519dda8`; destino: `extbkc-b-f7115519dda8`; origen **destruido** antes de restauración.
- Archivo `archive.tar.gz`, SHA256 `49b2f4ffbccc6447aa519d0a732937b5d4547d1de3c3c25106322fbed50b006e`.
- Manifiesto, SHA256 `eed1f9b409348d8750aa91452e43b2b8ff1a63d55ca3765b69611750ab390067`.
- Se ejecutaron 6 checks de restauración y los negativos de corrupción/ausencia; se borraron SOLO 3 claves del prefijo sintético.
- Recibo privado R2 `evidence/real-external-r2-drill-20261113-01.json`, leído de vuelta byte a byte: SHA256 `d7828eaf0a72bbc8c4583a0dc373a2ce7a3ee612c3ea76d701a04f68ad674da7`. **El recibo no sustituye copia de datos de usuario.**

### Evidencia independiente del ensayo C parcial

- Preparación del ensayo: `oc_v1_joint_prepare_staging_20261113_01`, `passed:true`, DO descartable `project-v1:snaprec-a-871ea5456848`.
- Deployments del Worker antiguo y nuevo confirmados vía API; tras revertir y restaurar, el Workflow `oc_v1_postrollback_supervisor_read_20261113_01` recuperó una sesión anterior `ad42c8f71e905b63` con 101 llamadas a herramientas y estado `finished`.
- Intento de invocar la verificación terminal rechazado por controles de seguridad. No reintentar por rutas alternativas para eludirlos. La última inspección de Containers confirmó `project-v1:snaprec-a-871ea5456848` en estado `stopped` (exit 0) mediante apagado de ciclo de vida normal, **no** mediante verificación/cleanup terminal.
- No se accedió a los datos de DO al margen de su API: la consulta SQL a la tabla interna `_cf_KV` devolvió `SQLITE_AUTH`. No hay evidencia de igualdad de hashes después de la reversión.

## Decisiones y protección

1. **Mantener Producción inalterada** mientras B2/C2 no estén demostrados.
2. Documentar objetivos de recuperación: RPO (máxima pérdida temporal tolerada) y RTO (tiempo para recuperación), con medición real sobre tamaño y carga representativos. Hoy no están demostrados.
3. Implementar respaldo verificable de archivos y sesiones *reales* con un destino privado y un procedimiento de recuperación en una entidad aislada, preservando secretos y la integridad de permisos; nunca usar datos productivos para pruebas destructivas.
4. Resolver la restricción de verificación del ensayo C de manera autorizada, no mediante herramientas alternativas para evadir controles. No confundir rollback de Worker ni conservación de sesión con recuperación conjunta.
5. Preparar snapshot de configuración e integridad de las dependencias antes de cualquier publicación; conservar un mecanismo para volver a la versión anterior y restaurar estado.
6. Solo después de B2/C2 y aprobación independiente, evaluar promoción de la cadena de PR #32–#50 a `main` y despliegue verificado de la V1, preservando secretos, bindings, DO y demás recursos productivos.

**Nota:** los artefactos GitHub de algunas pruebas tienen caducidad de 7 días; los recibos privados R2 conservan hashes y resultados, pero no los ZIP ni las bases de datos originales.

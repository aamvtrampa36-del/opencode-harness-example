# OpenCode Cloud V1 — Estado comprobable de recuperación y publicación

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

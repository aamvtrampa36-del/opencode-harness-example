# F0-OOM-02/T06 — preflight y procedimiento de carga autenticada (SIN EJECUTAR)

**Corte de auditoría:** 2026-11-22/23 UTC. **Actor:** ChatGPT, lecturas autorizadas de GitHub y Cloudflare. **Estado:** `PREPARADO / BLOCKED PARA CLOUDFLARE WRITE`. **No existe versión candidata subida o desplegada por T06**. El alcance de este documento es preparar una decisión y una operación futura limitada; no autoriza upload, despliegue, cambio de tráfico, merge, token, secreto, Access ni gasto nuevo.

## 1. Reconciliación de gates T02–T05

| Gate | Fuente real | Resultado |
| --- | --- | --- |
| T02 principal | [PR #111](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/111), `docs/f0-oom-02/recovery/02-binario-principal.md`; [CI 45070892923](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45070892923) success sobre SHA `87cbd07a06cfcc9eb5c4e3e1d9989943d78dfe84` | PASS de auditoría; 207/228 módulos activos coinciden con candidato, 21/228 divergen. No promovido |
| T03 MCP | Documento hermano `03-binario-mcp.md`: ZIP y manifiestos SHA verificados, Cloudflare GET `content/v2` y digest del cuerpo activo | PASS de auditoría; activo #19 `3c7ef3c9…` vs candidato `4b9323d8…`, sin guard publicado. No promovido |
| T04 transporte | [PR #109](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/109), [CI final 45066206624](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45066206624) success sobre `2d96d35286e3190287708fce752123afb3983c88` | PASS de descarga autenticada GitHub Actions, verificación y `--dry-run --no-bundle` principal y MCP; NO se subieron versiones |
| T05 compatibilidad | [PR #110](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/110), 30 invariantes; [CI 45070504642](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45070504642) success sobre `a14511f5e31209e7d715a3c6cfc63b08f893df33` | PASS estructural limitado; identidad de assets, efectos sobre Workflow/Containers y persistencia no certificados |

Candidato **único**: PR [#106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106), SHA fuente `19bba24d81be5b0673acbf2a56b500aed4fa0b66`, CI [45028680557](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45028680557) success. No cambiar SHA en silencio. Base Staging `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`. PR #106–#111 siguen draft donde proceda; ninguno demuestra reparación integral de la OOM.

## 2. Fotografía actual y referencias de reversión

Dos consultas de Cloudflare GET sobre deployments/versions/settings, y otra consulta posterior al análisis del MCP, confirmaron **sin cambios en el intervalo consultado**:

- **Principal:** `opencode-g1-staging`; deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`; versión **#374** `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`; **100 %**; main compatibility date `2026-06-11`.
- **MCP:** `opencode-staging-control-mcp`; deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`; versión **#19** `196240c0-1052-47b3-aaa7-02cf5baa87f0`; **100 %**; compatibility date `2026-11-17`.
- **MCP bindings publicados:** `STAGING_HEALTH` service hacia principal y `STAGING_SUPERVISOR` DO `OpenCodeAgent` del principal. Principal conserva `OpenCodeAgent`, `DEV/DevContainer`, `SETTINGS/PersonalSettings`, `SESSION_BK/SessionBackupDrillAgent`, `SUPERVISOR_WORKFLOW`, `RECOVERY_R2`, `AI`, `LOADER`.
- Los deployments anteriores son **referencias de configuración/código**, no backups de datos. No hay garantía de restaurar estado Durable Object, R2, Containers o Workflow al retroceder una versión. Un upload inactivo **no debe** modificar porcentajes, recursos compartidos ni datos persistidos.

Antes de T06, verificar otra vez los IDs y el estado actual. Si cambian respecto del snapshot acordado, **STOP y reconciliar; nunca sobrescribir por inercia**.

## 3. Paquetes y carga sin rebuild

| Worker | Artifact ID | ZIP SHA-256 | Payload SHA-256 | Contenido principal |
| --- | --- | --- | --- | --- |
| `opencode-g1-staging` | `14760462966` | `707afab14232ea867eed4de187069f2514bbc8c4ceacce50a6a538a619d84a59` | `c3a74f98a9d50697cac0a2c95b58b2e2199543e2bc00e2661de040b30f9f8b4b` | 543/543 entradas, 228/228 módulos JS, assets cliente |
| `opencode-staging-control-mcp` | `14760378207` | `4c268d686cb0bdb60ef790da20525e287627fcc1df128b511a1974e2cf41563d` | `ce2e9befb78020261836c53d9781041d2b616d90a15cb3daa5580577d375c5b9` | 4/4 entradas; `worker.js` `4b9323d8df60605132521bb0075045e7d75445f0dc898a8ec358ade5ce836a50` |

**Expiración:** alrededor de 2026-11-29T15:28:27–31Z. Cloudflare no debe intentar descargar estos archivos externamente: el conector Cloudflare devolvió HTTP 403 históricamente. La ruta ya probada es **GitHub Actions runner → artifacts exactos → SHA256 → extracción segura → empaquetado precompilado → dry-run offline**. T04 no publica archivos nuevos; el workflow de transferencia se encuentra en `.github/workflows/f0-oom02-staging-transfer.yml` de PR #109 y el verificador en `scripts/f0-oom02-transfer-verify.py`. No usar `bun run deploy` ni recompilar desde otra rama.

**Contrato de bytes para una carga futura:** usar las mismas rutas restauradas y configs derivadas **sin cambiar JS**; el `wrangler versions upload --dry-run --no-bundle` ya reprodujo **228/228** hashes principal y **1/1** MCP. Reconciliar hashes del contenido efectivo que Wrangler subirá (incluidos assets) después de preparar upload; si no se puede asegurar identidad exacta de JS y rutas, detenerse.

## 4. Autenticación — hallazgo comprobado y bloqueo preciso

La conexión GitHub utilizada dispone de acceso autenticado de lectura a los dos artifacts y escritura en rama permitida, **pero no expone el inventario de GitHub Actions secrets**. Por ello **no hay evidencia de que exista ni esté disponible `CLOUDFLARE_API_TOKEN` en GitHub Actions** ni que esté restringido a estos Workers. No leer ni imprimir valores, introducir token desde chat, crear token o modificar secreto.

Cloudflare GET `/user/tokens`, realizado una sola vez para inspeccionar metadatos sin valores, devolvió **HTTP 403 / code 9109 Unauthorized**. Este error demuestra falta de permiso de lectura del inventario mediante la conexión actual; **no demuestra inexistencia del token** ni prueba el alcance de un token que eventualmente esté configurado en GitHub.

La [documentación Cloudflare](https://developers.cloudflare.com/workers/authorization/) permite API tokens con permisos de Workers y scope de recurso cuando está disponible; [GitHub Actions CI/CD](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) requiere token Cloudflare y account ID sin exponerlos. El OpenAPI declara `Workers Scripts Write` (o rol Editor apropiado) para `POST /accounts/{account_id}/workers/scripts/{script_name}/versions`; Assets Upload Session también requiere `Workers Scripts Write`. **No inferir alcance mínimo real únicamente del nombre de permiso**: hay que comprobar que el token existente no pueda escribir Production ni otros scripts y que permita assets/bindings previstos.

**Gate auténtico:** únicamente un runner de confianza, después de revisar el código que usa secrets y el entorno de ejecución protegido, podrá comprobar en su proceso que ambos valores existen y que el token está habilitado para la operación concreta, sin volcarlos en logs. No referenciar secrets en un workflow PR de código no revisado. No hacer una escritura Cloudflare como prueba de autorización.

## 5. Protocolo T06 propuesto (sin activación)

**Lote único futuro — aún NO autorizado para Cloudflare writes:** creación de **versiones inactivas** de `opencode-g1-staging` y `opencode-staging-control-mcp`; no enviar tráfico, no cambiar DNS/Access/secretos, no nuevas migraciones, sin tocar Production, no merge ni rollout. El propietario debe aprobar esta operación sensible sobre un commit y procedimiento concretos una vez superados los gates.

**Preflight de solo lectura:**

1. Fijar HEAD rama técnica, SHA candidato, CI verde del HEAD y nombre de actor. Bloquear cualquier rama `main`/Producción, `push` accidental o ref dinámica. Desactivar cualquier automatismo de deploy.
2. Obtener inventario sanitizado de deployments/versions, assets y rutas, settings, bindings, migraciones DO v1–v4, namespace IDs, Container app/policy, versión Workflow, R2, schedules y Workers Build; comparar 30 invariantes del informe T05. Guardar valores públicos/verificables, **no** secretos ni datos persistentes.
3. Revalidar ZIP originals y `SHA256SUMS`, expiración y descompresión segura. Con Bun 1.4.4 y Wrangler 4.158.0, dry-run `versions upload --dry-run --no-bundle` sin credencial; verificar salida y hashes 228/228 + 1/1 y los assets del cliente. No usar builds nuevos silenciosos.
4. Inspeccionar presencia/privilegios efectivos del token existente en entorno protegido por mecanismo autorizado que no imprima valor; bloquear si es inexistente, de scope excesivo, expirado o no demostrable. No cambiar permisos.
5. Comprobar coste aplicable por llamadas Workers, assets y versiones, y existencia real de control de corte. El límite de un workflow/archivo YAML **no** es límite monetario. Falta evidencia de presupuesto aplicado: mantener BLOCKED para writes hasta acotar gasto.
6. Verificar que la operación `versions upload` no tocará Workflow/Container/DO/Assets fuera del contrato. Una operación en staging puede alterar recursos aun sin despliegue de tráfico: si no se puede predecir/observar razonablemente ese efecto, suspender.

**Operación autorizada futura (NO realizada):** preparar primero los dos payloads autenticados exactos, observar snapshot preflight, cargar como **versiones no desplegadas** si la API/CLI y permisos lo permiten, guardar IDs/ETags/hashes, comprobar postflight inmediatamente. **No usar** `wrangler deploy` ni `bun run deploy`. De ser necesario crear assets, tratar su upload como operación Cloudflare con efectos separada; no asumir inmutabilidad automática.

**Postflight obligatorio:** los dos deployments y porcentajes siguen **exactamente** como antes; solo se añadieron las dos versiones inactivas esperadas; hash de Worker JS, assets y routing corresponden a candidato, sin regeneración; bindings/migraciones v4 correctos; DO namespaces, Workflow versión y settings, Container/R2 y schedules sin cambios fuera de alcance. Registrar timestamps, IDs y hashes sin secreto; test runtime de esas versiones solo con autorización posterior (T07).

**STOP y reversión:** cualquier HTTP 403/409, cambio concurrente de deployment, hash/config mismatch, recurso creado/cambiado, migración inesperada, login o permiso excesivo, coste incontrolado o comportamiento no reversible detiene T06 **sin reintentos automáticos**. No activar ni compensar escrituras ciegamente. Si no se modificó tráfico, preservar versiones anteriores activas y documentar el incidente; una versión inactiva no demuestra rollback total. Si se alteró tráfico por error, intervención específica autorizada para restablecer el deployment anterior; **no** suponer que eso restaura DO/Workflow/R2/Containers. No borrar recursos ni ocultar fallos.

## 6. Decisión actual

- **Hechos completados:** T02 auditado, T03 auditado directamente, T04 doble dry-run y verificación en CI, T05 invariantes estructurales, snapshots de Workers confirmados sin cambios; este documento prepara secuencia, parada y rollback.
- **Bloqueantes restantes:** GitHub Actions secret/token y scope real no observables; Cloudflare inventario de tokens HTTP 403; presupuesto de escritura sin corte demostrado; efecto real del upload sobre Workflow/Container/assets no verificado. T06 **no puede declararse ejecutado** y la corrección F0-OOM-02 **no está desplegada**.
- **Próxima decisión del propietario:** aprobar un lote escrito y controlado para crear versiones **inactivas** solo después de resolver evidencias de credencial, scope, costes y side effects. El avance aquí no constituye autorización para intentar la carga a ciegas.

**Coste de esta preparación:** lecturas API GitHub/Cloudflare y CI ya existente, hashing offline y PR documental. Sin gastos nuevos de inferencia ni cloud writes; consumo marginal de API y GitHub CI al editar docs. **Autoría:** ChatGPT, no OpenCode Remote. **No se modifica** CDF, Production, `main`, secretos, Cloudflare ni estado persistente.

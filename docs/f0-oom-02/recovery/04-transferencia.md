# F0-OOM-02/T04 — transferencia binaria verificada sin desplegar

**Fecha:** 2026-11-22. **Actor:** ChatGPT (independiente de OpenCode Remote). **Entorno:** GitHub Actions y lectura de Cloudflare Staging. **Estado inicial:** verificación local PASS de ambos artefactos; ejecución del nuevo workflow y CI pendientes de observar. No se hizo merge, deploy, subida efectiva, inferencia, modificación de secretos ni cambios en Production.

## 1. Continuidad, SHA y estado de infraestructura

- Issue [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), referencia `[F0-OOM-02/T01]`; [PR #106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106) (código candidato) y [PR #107](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/107) (artefactos).
- SHA fuente fijo **`19bba24d81be5b0673acbf2a56b500aed4fa0b66`**; base Staging `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`; HEAD PR #107 fijo al iniciar T04 `f0dc29a568390d97eee22eed4536e2ea2765f523`. La nueva rama `ops/f0-oom02-transfer-20261122` parte exactamente de este HEAD, sin cambiar PR #107.
- Workflow de origen [45038446357](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446357), job `137257316214`, resultado **success**. Bun `1.4.4` y Wrangler `4.158.0`; contiene el principal precompilado y el MCP compilado mediante dry-run.
- Lectura real Cloudflare 22-11-2026: `opencode-g1-staging` versión **#374 `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`**, deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`; `opencode-staging-control-mcp` versión **#19 `196240c0-1052-47b3-aaa7-02cf5baa87f0`**, deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`. Ambos al 100 %. T01 atribuyó su fuente desplegada a `74632f75db010223cc90d99ba4a801ce0e6414e5`, distinto del candidato. **T04 no publica otra versión**.
- Los encargos T02/T03 aún no tenían conclusiones registradas en el hilo #90 durante esta auditoría; no se les atribuye PASS.

## 2. Entradas originales e integridad probada

| Worker | Artifact ID | ZIP SHA-256 confirmado por GitHub y lectura local | Payload SHA-256 | Inventario |
| --- | --- | --- | --- | --- |
| Principal | `14760462966` | `707afab14232ea867eed4de187069f2514bbc8c4ceacce50a6a538a619d84a59` | `c3a74f98a9d50697cac0a2c95b58b2e2199543e2bc00e2661de040b30f9f8b4b` | **543/543** |
| MCP | `14760378207` | `4c268d686cb0bdb60ef790da20525e287627fcc1df128b511a1974e2cf41563d` | `ce2e9befb78020261836c53d9781041d2b616d90a15cb3daa5580577d375c5b9` | **4/4** |

GitHub `fetch_workflow_run_artifacts` confirmó IDs, tamaños y campo `digest`; se descargaron ambos ZIP originales y, en análisis offline, coincidieron ZIP SHA-256, SHA256SUMS del contenido, inventarios, tamaño y hash por archivo; no hubo rutas de escape ni symlinks. **228/228 módulos JS del principal** de `prebuilt-main.tar.gz` son idénticos a los del bundle `dist/opencode_g1_staging`. El MCP `.f0-oom02/mcp-dry-run/worker.js` tiene SHA256 **`4b9323d8df60605132521bb0075045e7d75445f0dc898a8ec358ade5ce836a50`** e incluye `SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED`.

Ambos ZIP se originaron en el mismo SHA fijo y run `45038446357`. El principal preserva assets `dist/client/index.html`, entrypoint precompilado, migraciones hasta `v4` y bindings existentes; el MCP conserva `STAGING_HEALTH -> opencode-g1-staging` y DO `STAGING_SUPERVISOR -> OpenCodeAgent` en `opencode-g1-staging`. **No se infiere integridad de la versión publicada a partir de estos artefactos**.

**Caducidad:** artefactos originales disponibles hasta aprox. **29-11-2026 15:28 UTC**. Toda futura ejecución debe detenerse si expiran; no sustituir con otra compilación silenciosa.

## 3. Workflow y diff de T04

En esta rama técnica únicamente se agregaron:

- `.github/workflows/f0-oom02-staging-transfer.yml`: trigger `pull_request` para la rama base exacta de PR #107, guarda de rama head propia, SHA base fijo, permisos `contents:read` y `actions:read`, timeout 12 minutos. Sin `push`, `workflow_dispatch`, `actions/upload-artifact`, secretos Cloudflare, ni llamadas de escritura.
- `scripts/f0-oom02-transfer-verify.py`: verificador autónomo Python sin red que valida ZIP SHA256 fijos, manifiestos, inventario y contenido tar, workers, assets, service/DO bindings, 228 módulos y MCP. Solo extrae después de comprobar los bytes; prepara configuraciones derivadas para dry-run sin alterar ejecutables.
- `docs/f0-oom-02/recovery/04-transferencia.md`: este recibo y condiciones de aceptación.

El runner descarga los bytes de los **dos Artifact IDs exactos** mediante GitHub REST autorizado con el `github.token` efímero, comprueba sus SHA de ZIP (no solo el nombre del artefacto) y restaura las copias verificadas. Evita el HTTP 403 histórico que se obtuvo **desde el conector Cloudflare hacia GitHub**, porque ese salto no se usa: el runner GitHub obtiene sus artefactos directamente.

Después, instala Bun `1.4.4` y Wrangler `4.158.0` desde el lockfile y ejecuta **solo**:

```bash
wrangler versions upload --dry-run --no-bundle --config .f0-oom02-t04/prepared/main/dist/opencode_g1_staging/wrangler.json --outdir .f0-oom02-t04/main-dry-run
wrangler versions upload --dry-run --no-bundle --config .f0-oom02-t04/prepared/mcp/wrangler.prebuilt-mcp.json --outdir .f0-oom02-t04/mcp-dry-run
```

La configuración generada del principal cambia únicamente `configPath` y `userConfigPath` locales para el runner; registra el nuevo hash de metadatos, **sin modificar JS ni assets originales**. Para el MCP crea un JSON derivado con `main` señalando el `worker.js` original, `no_bundle:true` y `find_additional_modules:false`; el original permanece inmutable. Los dry-run deben producir **228/228 hashes JS idénticos** para principal y el hash MCP exacto. Se publica solo un resumen `GITHUB_STEP_SUMMARY`; **no se sube ningún archivo ni se crea una versión Cloudflare**.

## 4. Credenciales y permisos necesarios

El conector GitHub no ofrece lectura del inventario de **Actions secrets**. No se pudo demostrar que exista un `CLOUDFLARE_API_TOKEN` ya configurado en GitHub Actions ni verificar su alcance o vigencia. No se leyeron ni generaron valores. El workflow T04 no usa credenciales Cloudflare: define vacíos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.

La API de Cloudflare describe **Workers Scripts Write** (o permisos superiores, que **no** se solicitan) para crear versiones `POST .../workers/scripts/{script_name}/versions` y sesiones de assets. Para T06 será indispensable acreditar un mecanismo auténtico limitado a **`opencode-g1-staging`** y **`opencode-staging-control-mcp`**, y verificar que no concede escritura en Production. **El hecho de que el CI T04 sea verde no verificará ese permiso.**

## 5. Coste, prueba, parada y reversión

- **Costo previsible T04:** un runner `ubuntu-24.04` hasta 12 min en repo público; Actions público estándar generalmente gratuito. Sin nuevos uploads de artifacts ni consumo cloud runtime. Estimación Cloudflare: **0 acciones de escritura / 0 ejecuciones de inferencia**; sin hard cap monetario verificable, no afirmar límite automático en USD.
- **Prueba real previa:** verificación local de ZIP, SHA256SUMS, manifests, inventarios y módulos: PASS. No había Bun/Wrangler instalados localmente; por eso **el nuevo dry-run de ambos precompilados tiene que probarse en CI**, no declararse completado anticipadamente. El workflow de PR #107 sí había probado antes el principal con dry-run.
- **STOP inmediato:** credenciales o permiso insuficiente, GitHub 403, expiración de ZIP, SHA erróneo, inventario distinto, config de otro Worker, clases/bindings/asset ausentes, falla `bun --frozen-lockfile` o `wrangler --dry-run`, módulos recompilados o CI rojo. Sin reintentos ciegos ni actualización de permisos.
- **Reversión:** cerrar PR draft o revertir los commits de rama `ops/f0-oom02-transfer-20261122`. No se altera Prod, main, Staging runtime, DO, Container ni datos; ninguna reversión Cloudflare es necesaria.
- **PASS T04 restringido:** ambos paquetes originales descargados, hashes verificados y **dos** dry-runs de empaquetado con JS byte-identical en el nuevo CI. **T06** determinará autenticación real, carga, publicación y rollback bajo lote separado. Issue #90 sigue abierta; el hito F0-OOM-02 no está completado.

## 6. Registro de CI de T04

**Pendiente de agregar resultado y run/HEAD tras abrir la PR draft y observar el CI automático.** Nunca equiparar una PR creada con el PASS del workflow ni con un despliegue.

# CDF Dynamic Execution Ecosystem — implementation receipt (2026-11-18)

**Global state:** INTEGRAL PARTIAL. This receipt is not a declaration of COMPLETE PASS.

## Implemented as draft PRs

| Scope | PR | Source revision | CI verified | Production |
| --- | --- | --- | --- | --- |
| OpenCode pure-tools backend, per-project registry, read-only MCP boundary | [OpenCode #76](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/76) | `70407480bef0e90f8a43d5e4602367c2f2ae48a2` | [PASS, 44342295220](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44342295220) | NOT DEPLOYED |
| WorkBench opt-in pure JavaScript and CDF status metadata checker | [WorkBench #49](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/49) | `0233e9c5298f379f2bc2e651fca823c36fe1d7b7` | [PASS, 44342020464](https://github.com/aamvtrampa36-del/CDF-WorkBench-/actions/runs/44342020464) | NOT DEPLOYED |
| OpenCode Remote read-only status tool, depends on preexisting remote PR #68 | [OpenCode #77](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/77) | `d6d6dc74aca606f6dab031f9aee6840bffb55837` | [PASS, 44341661953](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44341661953) | NOT DEPLOYED |

**Important scope note:** none of these PRs were merged into `main`; no narrative content or canonical CDF records were modified. Code sharing across projects is through existing MCP interfaces only and not a shared durable catalog yet.

## Existing capabilities confirmed (not newly created)

- OpenCode has `LOADER` on production and staging, `@cloudflare/computer` Code Mode and a network-isolated `dynamic-mcp` backend.
- WorkBench already has an OAuth-scoped `ScriptRunner` Container for Python/Node and its original source manifest.
- CDF CLOUD retains canonical state, versioned checkpoints and gateway authorization. No code change to the canonical CDF engine in this mission.
- OpenCode remote MCP is in a separate, not-yet-merged feature branch (#68); the remote addition #77 targets that branch.

## Cloudflare synthetic laboratory

An account-local ephemeral Worker `cdf-dynamic-isolated-lab-20261118` was created by API with a `worker_loader` binding and deployed successfully. **Actual invocation of its `LOADER.load()` handler was not verified** because HTTP invocation could not be established through the available interface. The temporary worker was subsequently disabled and deleted; the account inventory returned to 12 scripts, with no lab remaining. A compile/deploy success is not a live execution pass.

## Known limitations and reasons to retain drafts

1. WorkBench's staging Wrangler configuration and production Wrangler configuration both name the existing `cdf-workbench-mirror` Worker. Deploying the staging configuration directly could overwrite the production service. Create a truly isolated staging target with its own identity and test routing, or use another non-mutating preproduction acceptance method before any promotion.
2. The OpenCode tool registry reuses hashed source and tests, **not** cached running Worker instances. `WorkerLoader.get()` caching remains a separately benchmarked, guarded future change.
3. OpenCode Remote branch #77 requires merging the preexisting remote-control branch #68 and dynamic catalogue #76 in a conflict-free integration; staging-only RPC must be tested after composition.
4. WorkBench's new CDF status diagnostic passes only bounded metadata (`status`, integer `generation`) to dynamic code. It **does not** verify full document integrity and **cannot** authorize canonical mutations.
5. The `CANDIDATE → TESTED → VERIFIED → ACTIVE` registry status proves only declared synthetic cases; no claim of independent security audit or fully reliable arbitrary code.
6. Observability and AI Gateway integrations were not changed: they remain candidates pending benchmarks, privacy review and an identified measurable benefit.
7. A true end-to-end remote test, production authorization check, rollout, live benchmark and code-rollback drill are still outstanding.

## Required acceptance sequence

1. Verify the CI success against the **current head SHA** of each PR after any further modification.
2. Compose OpenCode PR #76 with the existing remote feature and PR #77 on a single isolated staging build; inspect conflicts, model permissions and exported Durable Object RPC.
3. Ensure WorkBench staging uses a separately named Worker and does not replace the current production name. Confirm bindings and Secrets **by name only**, never print values.
4. Execute real synthetic Dynamic Worker tests through the authorized Cloudflare environment: valid input, invalid input, repeated execution, denied egress and refused write tool. Capture receipt with deployed version, result, duration and no leaked data.
5. Exercise OpenCode Remote MCP status read with existing staging authentication. Prove it cannot execute, mutate, read source or access arbitrary workspaces.
6. Exercise WorkBench OAuth with the execute scope and with a read-only scope; the latter must be denied. The CDF check must remain noncanon.
7. Benchmark against existing Containers and Code Mode. Adopt only if performance/cost/maintainability justify it.
8. Validate rollback to the prior Worker version **without restoring or deleting Durable Object or D1 data**. Preserve Access, source authentication and session continuity.
9. Only after passing these gates, promote gradually with recorded versions and post-deployment check. The decision to deploy must not be confused with a source CI pass.

## Decision summary

- Reuse OpenCode Worker Loader and existing DO persistence: **IMPLEMENTED in draft; CI PASS**.
- Keep WorkBench Container for Python and stateful scripts: **UNCHANGED**.
- Remote observer without another Loader or remote execution capability: **IMPLEMENTED in dependent draft; CI PASS**.
- CDF CLOUD as consumer through authorized read-only metadata path, no canonical changes: **IMPLEMENTED in WorkBench draft**.
- Artifacts, Queues, new D1/R2, Workers for Platforms and broad new orchestration: **DEFERRED** because existing infrastructure suffices for the current goal.
- Direct production implementation: **BLOCKED pending live tests, dependency integration and proven rollback**.

## Continuación de integración y pruebas vivas — 18 de noviembre de 2026

**Estado: INTEGRAL PARTIAL.** El contenido anterior conserva las evidencias de la primera etapa; estos resultados posteriores prevalecen cuando exista discrepancia.

- [PR #78](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/78) compone #68, #76 y #77 en `integration/dynamic-execution-20261118`, conservando las rutas de supervisión y añadiendo `DynamicToolRegistry`, `pure-tools` y `remoteDynamicToolsStatus`. [CI de la composición: PASS](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44347462032). Permanece en borrador, sin merge ni despliegue.
- La PR WorkBench #49 ahora separa su script de staging (`cdf-workbench-dynamic-staging`) del productivo (`cdf-workbench-mirror`), sus orígenes y sus namespaces KV de OAuth. Su base D1 y Gateway permanecen orientados a staging. La nueva namespace fue creada dentro del producto Workers KV ya disponible, sin crear una suscripción nueva.
- **Defecto real resuelto**: Worker Loader rechazó las claves dinámicas `.mjs` con el error `Module name must end with '.js' or '.py'`. Se sustituyeron por `candidate.js` y `entry.js` en el ejecutor WorkBench; las pruebas del repositorio se actualizaron. El host Worker puede seguir siendo un módulo `.mjs`.
- **LIVE VERIFIED limitado**: un Worker temporal, aislado y sin secretos ejecutó código fijo mediante `LOADER.load()` y `LOADER.get()`. En tres pruebas sintéticas obtuvo `[4,9,16]`; la salida de red se bloqueó y `get()` llamó al constructor una vez para dos invocaciones dentro de una solicitud. Las peticiones HTTP regresaron 200 con `pass:true`. No se demostró caché persistente entre solicitudes.
- **LIVE VERIFIED limitado**: un segundo Worker temporal importó el módulo `src/dynamic-exec.mjs` de WorkBench #49 **sin alterar su código**; ejecutó una transformación sobre `[2,3,5]` y obtuvo `{count:3,total:10}`. Rechazó una fuente con uso de `fetch`, una entrada mayor que el límite y la ejecución desactivada. La respuesta HTTP fue 200, `pass:true`, y reportó 12 ms para la ejecución sintética.
- Ambos laboratorios se desactivaron y eliminaron; el inventario de la cuenta volvió a **12 Workers sin laboratorios**. Ninguno disponía de CDF Gateway, bases de datos, credenciales ni permisos editoriales.

**Pendientes críticos antes de promover a producción:** probar el código compuesto completo de OpenCode contra su Durable Object y sesiones reales sin comprometerlas; desplegar WorkBench staging únicamente con credenciales y redirect OAuth independientes, comprobar scopes MCP de extremo a extremo; ejecutar prueba real de `workbench_dynamic_cdf_check` con Gateway de staging y autorización configurada; demostrar una reversión del Worker que preserve datos y sesiones; medir el coste/latencia con cargas representativas. Los cambios de producción, el motor Python de CDF y el canon no se modificaron en esta misión.

**Decisión de optimización:** `get()` está soportado y funcionó en laboratorio, pero WorkBench continúa usando `load()` hasta disponer de un benchmark real y política de invalidación; no se afirma ahorro económico ni reutilización de isolate entre solicitudes.

## Rollback en Cloudflare: A → B → A (laboratorio real)

La prueba aislada `cdf-rollback-lab-20261118` se ejecutó sin bindings, credenciales, Durable Objects ni datos de CDF:

| Paso | Versión | Evidencia HTTP |
|---|---|---|
| Crear y publicar A | `33d0b19f-e4e0-4150-81ac-5ae7ec92a5ee` | 200, `{"version":"A","synthetic":true}` |
| Subir B | `8d4bd184-d62d-4f89-aff7-e3efd91226bb` | 200, `{"version":"B","synthetic":true}` |
| Revertir con `POST /deployments`, 100% A | `33d0b19f-e4e0-4150-81ac-5ae7ec92a5ee` | 200, `{"version":"A","synthetic":true}` |

El rollback API informó un despliegue nuevo `f0512883-f355-4b3f-89cc-4189f78dc975` cuyo 100% apuntaba a la versión A. El laboratorio se desactivó y eliminó. Una nueva lectura del inventario Cloudflare reportó **12 Workers** y ningún Worker temporal. Las versiones de producción y staging de OpenCode y WorkBench seguían sin cambios.

Este resultado **solo prueba reversión de código/versiones en un Worker sin estado**. No certifica el efecto en migraciones, Durable Objects, Containers, SQL, sesiones o autenticación de OpenCode/WorkBench.

## Resultado actualizado de CI

- Integración OpenCode [#78](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/78), commit `83b6e6c98bf056526dd0595d68807035e67b0931`: [CI PASS, run 44350355566](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44350355566).
- WorkBench [#49](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/49), commit `474d0a605a3ce0285bd635c607382842ea75d9ce`: [CI PASS, run 44350189059](https://github.com/aamvtrampa36-del/CDF-WorkBench-/actions/runs/44350189059).
- Las pruebas de WorkBench verifican también que el `cdf_status` del Gateway entrega al Worker dinámico **solo estado/generación**, rechazando falta de token, preservando el Container original y el manifiesto de scripts. La integración OAuth de staging **no tiene aún las credenciales y el registro de redirección verificados**.

La política de promoción exige pruebas completas del propio servicio, no sustituibles por estas pruebas de laboratorio. El estado global continúa `INTEGRAL PARTIAL`.


## Execution continuation — security and stateful rollback

**Global classification: INTEGRAL PARTIAL.** This section supersedes older CI SHAs for the same feature branches.

### Integrated OpenCode core and Remote

- Integration PR: [#78](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/78). Confirmed CI for hardened code, Computer runtime `run.result().value`, isolated unbound session namespaces, lifecycle storage transactions, and concurrent revocation tests: [run 44357860676](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44357860676) at commit `3f4cde6d4107c72fb1bdb92156ab142a5468bd51`. Full staging dry-run passed. No PR merge, no staging deploy.
- One-off credential diagnostic [run 44355865698](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44355865698): existing CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET were present; CLOUDFLARE_API_TOKEN was **missing**. No values were printed. The temporary probe workflow has been removed. Cloudflare Workers Builds lists **zero triggers** for the relevant Workers. Without a configured approved build/deploy path, the integrated full Worker bundle cannot be promoted through Github Actions.
- [Issue #79](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/79) tracks the external credential and E2E gates. A new secret or GitHub-provider integration was not authorized or created.

### WorkBench candidate and current live baseline

- WorkBench PR [#49](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/49) has a tested fix for real CDF generation `"42"` (strictly normalized to safe integer 42) and rejects malformed/unsafe values. [CI run 44357914406](https://github.com/aamvtrampa36-del/CDF-WorkBench-/actions/runs/44357914406), commit `b29f53b47112d0c901cab48bf53cd2b6fbe06ea9`: PASS.
- The *currently deployed* WorkBench runtime reports READY, has all **11 original Skills**, and a real, read-only Container execution of `cdf-resource-router/scripts/efficiency_guards.py --help` returned exit code 0, no persisted files or network access.
- Both the CDF CLOUD direct and WorkBench-forwarded cdf_status eventually returned PASS, integrity ok, generation `"42"` and 28 documents. One earlier direct request returned CLOUDFLARE_SQL_ERROR but could not be reproduced on retest. It remains a monitoring signal, not a confirmed persistent outage.
- The independent WorkBench staging Worker is not deployed. Its OAuth KV is separate and empty; independent callback/secret setup is not verified, and production values are not copied.

### Real Cloudflare Durable Object stateful rollback laboratory

| Operation | Active code version | Synthetic stored value | HTTP |
|---|---|---|---|
| Upload and seed A | `91bc4cbf-1fde-4cf1-9c1b-a2c319660b4a` | `{marker: "CDF-SYNTHETIC",count:7}` | 200 |
| Deploy and read B | `58e01b68-5865-44be-b6a8-931b5a016609` | Unchanged, count 7 | 200 |
| Deploy previous A at 100% and read | `91bc4cbf-1fde-4cf1-9c1b-a2c319660b4a` | Unchanged, count 7 | 200 |
| Explicit synthetic-only deleteAll and read | A | `null` | 200 |

Rollback API returned deployment `90916ae2-9c4f-40c4-a712-7579f2649425`, targeting A at 100%. The test Worker was disabled and deleted, with no residual test Worker among the account's **12 existing Workers**. It had no CDF, production storage, Secrets or real user records.

**Limit:** this demonstrates Durable Object state preservation across *generic* Cloudflare Worker version rollback. It does **not** establish persistence of OpenCode production/staging sessions or ScriptRunner state after application-specific changes. Those real E2E tests and their authorization gates remain open. Complete Pass is NOT justified.

### Production snapshot preserved

- OpenCode production Worker `opencode-harness-example` version `d9d97df3-b9c5-4662-9de5-d8a6762b3d0d`.
- OpenCode staging Worker `opencode-g1-staging` version `e129ca1f-271a-4940-a32a-aad595ea27c2`.
- WorkBench production Worker `cdf-workbench-mirror` version `b88d35d5-2fef-4f22-9d24-c53681c50896`.
- CDF CLOUD engine candidate version `960c4433-9ba8-4f1a-a9d5-d1cdfb6f548a`; Gateway version `29381f6a-99a5-4c5d-a0b5-7bac6f23db34`.
- No new feature version was uploaded to any of these Workers.

### Next acceptance gates

1. Approved access to deploy CI-validated full OpenCode bundle to staging, with automatic rollback and no privilege reduction; token or approved alternate build connection needed.
2. Real project/session registry lifecycle, denied MCP mutations, metadata-only remote diagnostics and DO session persistence after staging upgrade/revert.
3. Independent WorkBench OAuth staging registration with authorized secrets and redirect, plus real new MCP tools with read-vs-execute scope denial; no code path into canon.
4. Trace and compare latency and cost for repeated calls. `get()` was proven only within a request, not across requests.
5. Only after all gates pass: controlled production promotion and post-deploy verification.
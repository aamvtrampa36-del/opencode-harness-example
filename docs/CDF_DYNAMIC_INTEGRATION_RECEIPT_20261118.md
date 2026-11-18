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

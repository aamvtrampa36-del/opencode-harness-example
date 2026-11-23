# F0-C10/T08 — Integridad GitHub bajo diez tareas paralelas

**Corte:** 2026-11-22, America/Sao_Paulo. **Estado:** PARTIAL: reproducción sintética local completa, garantías de publicación concurrente en runtime todavía no demostradas. **Actor:** ChatGPT, auditoría y pruebas sin inferencia; no se ejecutó tarea nueva de OpenCode. **Entorno:** solamente lecturas sobre Staging y escrituras en la rama independiente de este informe. Sin merge, deploy, cambios en main, secrets o Producción.

## 1. Versiones y autoridad

Repositorio: https://github.com/aamvtrampa36-del/opencode-harness-example
Plan: F0_C10_PLAN_INTEGRAL.md; incidente: https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90

- Ref observado de Staging (desarrollo): 11161dd6f2c4b5237a2da59d7275ff693e0afdbe, rama staging/opencode-g1-rpc-safe-20261120. Main observado: 5527fce60775f02a94d5d2382b77e4eb4a9fd623.
- Cloudflare lectura: Worker opencode-g1-staging versión 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb, deployment 36ef84b3-0f99-4dd4-ab8e-c11ee450dd23. MCP opencode-staging-control-mcp versión 196240c0-1052-47b3-aaa7-02cf5baa87f0, deployment 9fdaf22d-beeb-44a0-ab68-77ecd5745fa1. Ambos al 100% en el snapshot.
- PR #113 atribuye al Worker principal la fuente 74632f75db010223cc90d99ba4a801ce0e6414e5. No se hizo una verificación binaria propia de esa atribución. GitHub compare demuestra que el ref Staging antes indicado está 54 commits por detrás de ese SHA; se leyeron ambas versiones de src/github.ts y el patrón de creación de PR permanece consult-before-POST.
- Remote status devuelve ready=true y githubWrite=true; informa al menos 96 sesiones históricas, pero no confirma ten-way active, lock global, scope del token GitHub ni gasto controlado.
- Existe otra rama T08 independiente: f0-c10/t08-20261122, HEAD al corte 9f62b8e2fa871564af6ff0e6cec56555e7f6165a; incluye src/github.ts y src/github-pr-conflicts.test.ts. No editar ni sobrescribir ese trabajo; reconciliar antes de modificar el puente.

## 2. Contrato leído en código

Fuentes inspeccionadas: src/github.ts, src/workspace.ts, src/scoped-github.ts, src/tool-permissions.ts, src/project-scope.ts, src/server.ts, src/supervisor-control.ts, src/github.test.ts y src/github-pr-conflicts.test.ts.

| Operación | Contrato existente | Límite comprobado |
| --- | --- | --- |
| repo / read | REST autenticado server-side, allowlist de repositorios y ref opcional | Cloudflare retiene token; lectura default ref si no se pasa SHA |
| pr_search / pr_info / issue_info / pr_files / pr_reviews / pr_checks | Lectura y búsqueda acotadas de datos privados; la búsqueda es index-only | Readback por PR exacta y check SHA requerido; #84, #88 y #89 |
| branch | POST /git/refs solo para opencode/*; base específica para tarea Staging | ensureSupervisorBranch acepta nombres deterministas y readback del commit; no es un mutex global |
| write completo | GET contenido/blob SHA, compara bytes y PUT /contents | <=100000 bytes; respuesta PUT perdida y bytes ya aplicados retorna reconciled=true sin segunda escritura |
| write exact replacement | Exige expectedHead, ancla única, archivo <=128000 bytes y fragmentos <=8192 | Crea blobs/trees/commit y PATCH /git/refs force:false; fast-forward NO equivale CAS exacto |
| review | REST compare against authorized base | 300 archivos como límite, resultado marcado truncado |
| pr | Lee base/head, compare y archivos de PR abiertos de misma base; revalida SHAs y hace POST /pulls draft | Rechaza solapamientos de paths/renames y PR en misma branch; GET/POST NO atómico |

**ACL y aislamiento existentes:** normalizeOwnedRepository/repoChecked y ALLOWED_REPOS (3 repos autorizados); branchChecked solo admite opencode/*; assertNonCanonicalWrite rechaza rutas narrativas/canon, workflows, .env y wrangler. Herramientas en Plan/Review son read-only; scopes de proyecto fijan repositorio; sesiones supervisadas pasan por assertSupervisorBoundGitHubOperation, que impide crear ramas adicionales y exige la branch asignada para write/pr/review. **Hallazgo focal:** para sesiones de proyecto NO supervisadas, assertScopedTool verifica repo/proyecto pero no impone una rama individual; un write puede elegir otra opencode/* del mismo repo. Esto no prueba que ya ocurriera un incidente, pero impide atribuir aislamiento universal a las sesiones.

**Protecciones externas:** GET /rulesets de GitHub reportó [] en el corte. Las consultas concretas a branch protection de main y staging no devolvieron evidencia utilizable por el conector: se considera DESCONOCIDO, no desprotegido ni protegido. Los permisos admin/push reportados por el conector oficial describen a ChatGPT, NO al token OpenCode. No se alteraron rulesets/protecciones.

## 3. Matriz de conflictos

| Actores / conflicto | Efecto | Tratamiento |
| --- | --- | --- |
| 10 ramas y paths disjuntos | commits/refs aislados por Git | Manifest de archivos y CI por HEAD |
| 2 ramas y mismo path | blobs preservados; al integrar puede haber add/add o content conflict | Comparar paths/renames, bloquear PR rivales a misma base y revalidar integración |
| 2 creaciones de PR simultáneas a misma base/path | ambos pueden ver lista vacía y POST antes de que aparezca el otro | Reserva *atómica* de publicación, recheck dentro de autoridad única |
| mismo archivo en PR de bases diferentes | comprobación actual filtra por base y no cubre la convergencia | Política de integración cruzada, sin auto-merge |
| dos writes a una misma rama | PUT blob SHA bloquea conflictos de contenido existentes; PATCH force:false solo valida fast-forward | Binding de rama por sesión y CAS HEAD comprobado |
| PUT aplicado, HTTP perdido | readback contenido igual evita segundo commit | Registro de intent y readback antes de retry |
| POST PR aplicado, HTTP perdido | preflight puede devolver PR_ALREADY_OPEN, pero no recibo idempotente | Buscar PR exacta por repo, head, base, SHA, título y cuerpo |
| PATCH ref aplicado, respuesta perdida | el estado de aplicación queda ambiguo | Readback de HEAD y árbol esperados; no repetir a ciegas |
| stale HEAD / rename / listado truncado / 403 / 429 | se debe fallar cerrado sin escritura adicional | Tests negativos de rechazo y no-network |
| ramas ajenas / main / paths protegidos | servidor debe denegar | No suavizar ACL para lograr PASS |

## 4. Reserva compartida de Staging — propuesta, NO implementada

Proponer GitHubPublicationArbiter reutilizando primero el Durable Object autoritativo existente si está disponible a TODOS los escritores. Un único coordinador por (repo, targetBase) serializa SOLO la fase de publicación; las diez tareas siguen programando y ejecutando tests en sus branches aisladas.

1. Registrar taskId, sessionId y branch fijados por el servidor, intención idempotente, base/head SHA y manifest de paths/renames; validar alcance ANTES de admitir.
2. Adquirir transaccionalmente reserva única para (repo, targetBase) y generar token fencing monótono. Rechazar otro escritor activo. Busy=false, etiquetas, comentarios, búsquedas y check-then-set remoto NO son reservas.
3. Grabar estado reserved/preflight/publishing en almacenamiento durable con ID único; comparar fuentes SHA, cambios, PR abiertos y reservas. El coordinador es el único componente autorizado a POST /pulls tras el registro de intento.
4. Persistir recibo verificado con número PR, URL, head/base SHA y fingerprint del payload. Un reintento con mismo intent devuelve el recibo, y mismo requestId con payload distinto debe fallar.
5. Si se pierde POST response o cae el DO luego de lanzar POST, usar estado unknown/quarantine y readback exacto; **NO liberar solo por TTL**, pues GitHub no reconoce el fencing token: una petición vieja aún puede completar.
6. Con resultado terminal confirmado, liberar reserva y revalidar el siguiente. Ante actores que publiquen por fuera del árbitro, exigir controles GitHub/CI en integración; el árbitro solo cubre las rutas que atraviesan su autoridad.

**Git no sustituye este bloqueo:** GitHub REST update ref force:false asegura fast-forward, pero no recibe expectedOldSHA; GraphQL createCommitOnBranch(expectedHeadOid) sí permite CAS para el commit de una branch (no para crear PR). Un ref especial creado condicionalmente podría ser token de exclusión, pero necesitaría recuperación duradera, fencing y limpieza segura: no introducirlo antes de contrastar la coordinación existente.

## 5. Reproducción offline ejecutada

Archivo de prueba: scripts/f0-c10-t08-integrity.test.mjs. Comando: node --test scripts/f0-c10-t08-integrity.test.mjs. Ejecutado localmente con Node 22.16.0 y Git 2.47.3. **8/8 PASS, exit 0, sin red/GitHub real/inferencia.** Incluye:

1. Diez refs Git y worktrees reales desde la misma base: diez blobs diferentes en la misma ruta, ningún cambio en main fixture.
2. Dos ramas locales con mismo path: merge real add/add conflict, abortado.
3. Dos actualizaciones al mismo ref Git con expected old OID: exactamente una gana.
4. **RED del diseño actual:** simulación intercalada de dos PR, ambos pasan GET listado vacío y llegan a POST: dos PR superpuestas; contraejemplo de atomicidad.
5. Coordinador simulado reserve+recheck: segunda publicación bloqueada por conflicto.
6. Generación de fencing simulada: rechazo de lease antiguo expirado.
7. PUT aplica y pierde respuesta: readback de bytes impide commit duplicado.
8. Mismo path y bases distintas: guarda same-base no detecta conflicto de integración.

**No afirmar runtime GREEN:** estos escenarios son fixtures locales y modelos de la ventana actual. Faltan test RED/GREEN importando GitHubBridge TS, carreras reales backend, crash/restart durable, token OpenCode, readback PR exacto tras HTTP perdido, PATCH ambiguity, branch hijack no supervisada, truncated pages y transacción real del árbitro. El issue #90 ya tiene evidencia de dos agentes escribiendo el mismo path en branches distintas y rechazo secuencial del PR por solapamiento; ese resultado no prueba POST simultáneo. El ensayo histórico de diez inicios dio 0/10 tareas verificadas, no diez ejecuciones simultáneas.

## 6. Open source consultado, reuso y licencias

- GitHub REST Git refs: https://docs.github.com/en/rest/git/refs ; GraphQL expectedHeadOid: https://docs.github.com/en/graphql/reference/commits ; REST Contents: https://docs.github.com/en/rest/repos/contents . Distinción CAS exacto vs fast-forward.
- Aider (Apache-2.0 LICENSE.txt), commit 5dc9490bb35f9729ef2c95d00a19ccd30c26339c: https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c . Manejo Git local de cambios/commits, no mutex de PR remoto.
- SWE-agent (MIT), commit 3ea751c087f32b16e039a2233dd6eefecef325d5: https://github.com/SWE-agent/SWE-agent/tree/3ea751c087f32b16e039a2233dd6eefecef325d5 . Entorno y patches aislados, no reserva distribuida de PR.
- OpenHands software-agent-sdk (MIT), commit ebec01b3893696c2f5454762eb44796c71bb391a: https://github.com/OpenHands/software-agent-sdk/tree/ebec01b3893696c2f5454762eb44796c71bb391a . Workspace aislado y patrón de lease de conversación; no extrapolar su lease a bloqueo de GitHub.
- No se copió código externo. Examinar compatibilidad Cloudflare Workers/DO/Bun y licencia antes de implementar.

## 7. Handoff, gates y pruebas negativas

**Handoff T04 recuperación:** compartir estado unknown/quarantine, ledger de intent y respuesta perdida. **Handoff T02:** no crear DO nuevo si ya hay coordinador con capacidad de reserva transaccional. **Handoff T10:** agregar casos de same-file, lost-response, 10 refs, stale lease y branch-boundary a harness global.

**NEGATIVOS por añadir ANTES de cambios productivos:** 2 POST intercalados con mock de API de GitHubBridge, 404 privado vs inexistente, PR exacta ajena con misma rama, head movido entre read y publish, 100 PRs/paginación truncada, renames con previous_filename, write de una sesión a branch ajena, replay con intent diferente, timeout POST inconcluso, crash tras POST antes del ledger, retry PATCH después de timeout. Probar que cada bloqueo precede a POST/PUT/PATCH no permitido.

**Estado del encargo:** análisis y harness sintético preparados; no hay corrección runtime ni validación de 10 escritores, tampoco evidencia de branch protection aplicable. No se inició tarea Remote: falta reserva global atómica demostrada y corte de gasto efectivo. PR de auditoría queda draft, sin merge ni deploy. Al integrar, comparar con rama T08 paralela y ejecutar Bun/CI exacto antes de cualquier promoción.

**Próximo gate:** RED contra GitHubBridge real, mínima reparación server-side de binding de rama y exclusión de publicación (preferir reutilización de código), GREEN+CI SHA, luego una prueba Remote aislada solo con reserva y presupuesto efectivos. No cerrar F0-C10 por esta entrega.

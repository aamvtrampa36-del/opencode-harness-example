# F0-C10/T08 — Integridad GitHub de diez escritores paralelos

**Fecha:** 2026-11-22 (America/Sao_Paulo). **Estado:** PARTIAL / CANDIDATO SIN DESPLIEGUE.  
**Actor:** ChatGPT coordinó lecturas, simulación local y commits mediante el conector GitHub autorizado. **OpenCode no ejecutó esta corrección**: no existía evidencia suficiente de reserva exclusiva ni corte efectivo de coste para iniciar una tarea remota.  
**Repositorio:** https://github.com/aamvtrampa36-del/opencode-harness-example  
**Base inmutable examinada:** `staging/opencode-g1-rpc-safe-20261120` @ `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`.  
**Rama T08 exclusiva:** `f0-c10/t08-20261122` (creada desde esa base). **PR draft:** [#122](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/122) hacia la misma base; no merge, no deploy. **Preflight:** 13 PR abiertas examinadas, sin archivos solapados con T08.

## 1. Resultado verificable y límites

El puente existente **sí** conserva contenido separado por rama y tiene protecciones server-side, comparación de archivos y actualizaciones de referencias sin `force`. Los ensayos históricos de la [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) confirmaron dos blobs distintos para un mismo path en ramas diferentes; su [comentario #7051854533](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7051854533) confirmó un rechazo REAL de PR por archivo solapado, antes del POST.

Sin embargo, **la comprobación de colisiones previa a POST no es atómica**. Dos escritores pueden observar en paralelo una lista de PR aún vacía y publicar ambos un cambio al mismo archivo, cada uno desde su rama. Las ramas siguen aisladas, pero sus propuestas de integración son incompatibles. Un GET de `busy=false`, una etiqueta, el mismo nombre de fichero o releer un SHA no son mutex globales.

Cambio focalizado de este T08: si el `POST /pulls` ya creó una PR draft pero perdió su respuesta HTTP, una repetición deliberada y con el mismo intento puede **recuperar el recibo** de la PR abierta, tras contrastar exactamente repositorio de head, nombre de rama, SHA de head, SHA de base, título, cuerpo y condición draft. En caso de diferencia o datos insuficientes, rechaza `PR_ALREADY_OPEN` sin nuevo POST. **No hace reintentos automáticos ni corrige la carrera entre dos branches.**

## 2. Contrato del puente GitHub (fuente directa)

Fuentes de implementación en SHA base: [src/github.ts](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/github.ts), [src/workspace.ts](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/workspace.ts), [src/server.ts](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/server.ts), [src/supervisor-control.ts](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/supervisor-control.ts), [src/tool-permissions.ts](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/11161dd6f2c4b5237a2da59d7275ff693e0afdbe/src/tool-permissions.ts).

| Acción | Contrato y verificación observada |
| --- | --- |
| `repo`, `read` | Metadatos/archivo vía REST autenticado; `read` acepta ref explícita o default; archivo de texto base64 hasta 100000 bytes. Un 404 privado significa no accesible, **no** ausencia demostrada. |
| `pr_search` | Búsqueda server-side `repo:<repo> is:pr`, página máx. 20, hasta página 10; valida procedencia. Índice no autoritativo: confirmar luego con `pr_info`. |
| `pr_info`, `issue_info`, `pr_files`, `pr_reviews`, `pr_checks` | Lecturas acotadas, validan número, página o SHA. Checks y commit statuses son pruebas diferentes; puede existir respuesta parcial por permisos. |
| `branch` | Crea únicamente rama `opencode/*` desde rama default o base revisada de Staging; GitHub POST de ref, sin force. La acción expuesta al agente NO es idempotente por sí sola. |
| `ensureSupervisorBranch` | Reserva determinista `opencode/staging-<16hex>` o `opencode/supervised-<16hex>`; reusa solo si SHA coincide con base. Creación concurrente de la misma ref se reconcilia con GET, nunca se mueve otra base. **No es un lease de exclusión entre tareas diferentes.** |
| `write` completo | Hasta 100000 bytes. GET de contenido en rama; si el texto ya coincide, devuelve `unchanged:true,reconciled:true`. En caso contrario PUT Contents con SHA del blob anterior cuando exista. **No aplica expectedHead de rama a esta modalidad**. |
| `write` reemplazo | Solo repo OpenCode y rama `opencode/staging-<16hex>`, expected HEAD de 40 caracteres, ancla única, fragmentos hasta 8192 bytes, fichero hasta 128000 bytes. Lee árbol Git real, preserva modo 100644/100755, crea blob/tree/commit hijo y PATCH ref `force:false`. El PATCH no ofrece por sí mismo parámetro REST de expected-head. |
| `review` | Compara base y rama; advierte truncamiento al llegar a 300 archivos. No significa autorización para fusionar. |
| `pr` | Draft exclusivamente; compara SHA base/head, diff hasta límites, lista PR abiertas de misma base (máx. 99), revisa archivos (máx. 99 por PR), renames (old + new), rechaza solapamientos, relee refs y POST. **La ventana posterior al segundo GET sigue sin arbitraje atómico**. |

`src/github.ts` usa GitHub REST `2022-11-28`, credenciales conservadas en Secrets/Settings de Worker y no en prompts/Container. Tipifica 401 (auth), 403 (permisos/cuota), 404 (inaccesible), 429/5xx (transitorio). No reintenta writes automáticamente. La PR histórica [#86](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/86) quedó cerrada sin merge por base RPC obsoleta; la reconciliación de PUT sí aparece en la fuente Staging revisada. [#103](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/103) corrigió `tree.sha` de GitHub REST en esa fuente.

## 3. Aislamiento y permisos reales

La allowlist de repositorios se comprueba en backend y se obtiene de Settings; nombres de otros propietarios/repo no autorizados se rechazan. `src/project-scope.ts` fija proyecto/repositorio por sesión; `src/server.ts:enforceSessionScope` vincula la tarea supervisada a su rama y rechaza cambios de scope o sesiones canceladas/fallidas. La acción genérica `github` pasa por `assertAgentToolPermission` y `scopeGuard` ANTES de tocar el puente. Plan/Review admiten consultas, no writes. Se bloquean rutas de canon, workflow, credenciales y configuración Wrangler. Crear PR no concede merge, escritura directa a main, borrado ni despliegue.

**Límite:** estas guardas gobiernan el puente propio cuando el agente lo usa. No gobiernan automáticamente el conector GitHub oficial de ChatGPT, tokens externos, usuarios con permisos directos, merges o cambios por otra API. El conector oficial en este encargo solo fue usado para la rama T08 y su draft. **Lectura real de reglas en este corte:** `GET /repos/.../rulesets` devolvió `[]` (no se listaron rulesets del repositorio). `GET /branches/main/protection` devolvió HTTP `403 Resource not accessible by integration`; la lectura de protección de la rama Staging no pudo hacerse mediante la ruta admitida por el conector. **NO se confirmó ninguna regla externa efectiva que bloquee PR conflictivas o escrituras directas.** No se modificó ninguna protección.

En `src/server.ts` existe una transacción `supervisor:lock:<id>` para **un requestId**, con token y TTL de 60 s. Es lock de inicio/reconciliación de esa tarea, **no** exclusión global de diez escritores ni reserva del tramo de PR POST. Un TTL sin fencing verificable en el efecto externo no impide que un proceso vencido publique tarde.

## 4. Matriz de conflictos

| Escenario | Guarda observada | Caso negativo / incertidumbre | Veredicto |
| --- | --- | --- | --- |
| Dos tareas, dos branches y rutas distintas | Branches y SHA separados; preflight de PR inspecciona paths | 10 ramas sintéticas no solapadas | **PASS sintético**, no E2E |
| Mismo path en ramas distintas | Blobs independientes (issue #90); PR solapada existente se detecta | PR #95 abierta bloqueó PR de agente B; test de colisión | **PASS secuencial histórico**, no arbitración paralela |
| Dos PR concurrentes al mismo path y misma base | Dos GET de refs y lista, después POST | Barrera `GET/GET/POST/POST` permite dos POST | **DEFECTO TOCTOU reproducido sintéticamente** |
| Misma rama, commits hermanos | `force:false` exige fast-forward | Un hijo posterior al commit alternativo debe fallar | **Defensa de no-fast-forward**, no CAS exacto probado |
| PUT llega, HTTP 503 desaparece | Relectura de contenido idéntico evita segundo PUT | Prueba en `src/github.test.ts` | **PASS mock**, no respuesta perdida live |
| PR POST llega, HTTP 503 desaparece | Antes devolvía solo `PR_ALREADY_OPEN` | Test nuevo recupera PR idéntica sin segundo POST | **Corregido en candidato T08**, CI pendiente |
| Rama con PR distinta (body, SHA, fork, draft) | Nuevo contraste exacto antes de reutilizar recibo | Cuatro rechazos negativos | **PASS diseño/mock**, runtime no probado |
| Rename sobre path de otra PR | Compara filename y previous_filename | Test negativo existente | **PASS mock** |
| Lista/compare de más de límite, 403/429 | Fail closed; clasificaciones explícitas | Pruebas de truncamiento existentes | **PASS mock**, API real no revalidada en carga |
| Agente intenta main, repo ajeno, config/secreto | Allowlist, scope/branch/paths server-side | Tests existentes en github/scoped/project-scope | **PASS por código/test histórico**, no prueba de ruleset |
| Caducidad de lease con escritor retrasado | No hay fencing GitHub global implementado | Simulación local rechaza epoch viejo solo en modelo | **NO VERIFICADO** |
| Escrituras externas al puente o dos DO distintos | Ninguna reserva compartida demostrada | Necesita prueba autenticada posterior | **BLOCKED** |

## 5. Compare-and-swap y significado de exclusividad

La documentación [REST Git references](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28) define `PATCH /git/refs` con `sha` y `force`; `force:false` comprueba avance rápido, **no expresa el SHA esperado como condición atómica**. GET previo + PATCH posterior es TOCTOU. La firma de `update_ref(expected_sha)` del conector oficial no debe confundirse con una garantía server-side de CAS GitHub; no se empleó para una reserva real.

`POST /git/refs` para una referencia *ausente* sí ofrece un único nombre a crear y puede servir como adjudicación de una **reclamación de un solo uso** (requiere ensayo de competencia y reconciliación de errores). No equivale a un lease reutilizable: para liberar la ref habría que borrarla o rotarla, fuera del alcance y sin fencing de writers obsoletos. No lo instalamos como bloqueo.

**Propuesta mínima para un lote posterior, NO implementada:**

1. Reutilizar el supervisor Staging o un único DO coordinador nombrado de forma determinista para todos los escritores autorizados. Prohibir writer directo a rutas mutantes fuera de ese carril. Las transacciones de almacenamiento del DO solo coordinan **su propio objeto**.
2. `acquire(scope, ownerRequestId, intentHash, ttl)` en transacción durable: unicidad por `repo + baseRef + recurso` (o exclusión más conservadora `repo + baseRef + PR-write`); devuelve `leaseId`, `epoch` monótono, vencimiento y versión/identidad de propietario. Dos aspirantes reciben uno `ACQUIRED`, otro `BUSY`, sin efectos GitHub.
3. Validar `owner + epoch + unexpired` antes de cada POST/PUT/PATCH. Renovar en transacción; al liberar, compare owner+epoch. Conservar un registro de intención y recibos para reconstruir respuestas perdidas. Tras reinicio, reconciliar GitHub antes de repetir POST, no asumir que expiración significa fallo.
4. Para que fencing sea **efectivo contra un escritor tardío**, hacer pasar el efecto GitHub por un ejecutor coordinado serializado (o usar una primitiva verdaderamente condicional documentada). Comprobar un token inmediatamente antes del POST desde otro actor no garantiza seguridad si el actor viejo conserva acceso de escritura fuera del carril.
5. Primera prueba RED con dos aspirantes simultáneos al **mismo scope**, otra con scopes disjuntos, reinicio entre efecto y persistencia, TTL y writer retrasado; después diez tareas con un repositorio de prueba y sin gastos no acotados. Si no hay un coordinador compartido comprobado, **cero arranques Remote concurrentes**.

Cloudflare documenta almacenamiento fuerte y transacciones por DO ([SQLite DO API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)), pero **no** arbitraje automático entre DO diferentes. No crear nueva namespace ni modificar migraciones sin lote aparte.

## 6. Pruebas y reproducción

**Código añadido en esta rama:**
- `src/github-pr-conflicts.test.ts`: reconciliación de PR idéntica tras 503 perdido (un solo POST); mismo branch con intent/HEAD/fork/draft divergente, rechaza; barrera artificial con dos escritores concurrentes al mismo path (**documenta la falla**, espera dos POST); diez ramas sintéticas con diez archivos distintos (espera diez PR independientes).
- `src/github.ts`: comparación exacta de la PR previamente abierta y `reconciled:true` solo al coincidir toda la identidad. Sin rediseño del puente, sin dependencias, sin bypass.
- Pruebas anteriores de la base: `src/github.test.ts` (respuesta de PUT perdida; SHA y validación de reemplazo), `src/github-pr-conflicts.test.ts` (colisión, rename, truncamiento, cambio de refs y duplicación).

**Reproducción local efectivamente ejecutada:** `node --test f0_c10_t08_model_tests.mjs` (Node v22), **8/8 PASS, exit 0**, en un modelo independiente que simula diez ramas, colisión secuencial/paralela, PUT/PR con respuesta perdida, no-fast-forward y fencing. Este script local es una simulación, **no carga el puente TypeScript real**. El runtime local no ofrece `bun` y no permitió clonar por DNS; no atribuir esas ocho pruebas a `bun test`. El test real de fuente debe pasar en CI del HEAD de la PR y luego, cuando se autorice, en Staging.

**Primera consulta CI del draft #122:** la API no devolvió workflow runs ni estados combinados para el HEAD inicial `37257a1c89de4bc97204a669b17704737a27ce08`; **no hay CI verde comprobado**. Es necesario repetir comprobación tras este último commit documental.

**Comandos de verificación en CI del SHA exacto:** `bun test src/github-pr-conflicts.test.ts src/github.test.ts`, `bun run typecheck`, `bun run build`, `bun scripts/check-invariants.mjs`. Deben comprobarse sus exit codes y asociarlos al HEAD tras la última edición; una PR draft por sí sola no es PASS.

## 7. Referencias externas examinadas (patrones, no código copiado)

- [Aider — Git integration](https://aider.chat/docs/git.html) (Apache-2.0): commits y diff/undo sobre branch; valioso para trazabilidad, **no mutex distribuido**.
- [SWE-agent — Repository configuration](https://swe-agent.com/latest/reference/repo/) (MIT): `base_commit` fijable por ref/SHA y comprobación de checkout sucio; aplicar aislamiento de base, **no adoptar runtime**.
- [OpenHands SDK — AgentSandboxWorkspace](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-workspace/openhands/workspace/agent_sandbox/README.md) (MIT): workspace aislado y persistencia por volumen, útil para independencia de FS, **no arbitra PR de GitHub**.
- [GitHub REST refs](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28): create, update, fast-forward, permisos y límites de errores.
- [Cloudflare DO SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): consistencia/transacción en instancia específica.

No se copiaron implementaciones externas ni se introdujeron dependencias. Revisión de licencias: [Aider](https://github.com/Aider-AI/aider/blob/main/LICENSE.txt), [SWE-agent](https://github.com/SWE-agent/SWE-agent/blob/main/LICENSE), [OpenHands](https://github.com/OpenHands/software-agent-sdk/blob/main/LICENSE). No se fijaron commits de terceros porque se estudió documentación pública sin trasplantar código; si se reutiliza código posteriormente, fijar SHA y licencia del fragmento exacto.

## 8. Estado de despliegue, costes, parada y reversión

Lectura remota: `staging_status=ok`, `supervisor.ready=true`, `supervisedSessions=96`, `supervisedCountComplete=false` (no significa 96 tareas activas). Cloudflare deployments de lectura: principal `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` (100 %, deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`) y MCP `196240c0-1052-47b3-aaa7-02cf5baa87f0` (100 %, deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`). Son versiones **actuales consultadas**, pero no demuestran que el parche T08 esté en runtime. **No se desplegó T08**, ni se arrancó una tarea Remote. Gastos de inferencia/Containers de T08: cero ejecuciones iniciadas; la facturación total de lecturas/CI conectadas no fue medida y no se declara cero coste universal.

**Stop:** no merge, no deploy, no changes a main, no mutaciones de rulesets/Access, credenciales, Producción, otras ramas, ni reintentos HTTP mutantes ciegos. **Rollback:** dejar draft sin fusionar; para reversiones futuras del runtime exigir fuente, SHA, versión, pruebas y rollback separado. No confundir revertir Worker con recuperar DO/Containers.

## 9. Veredicto y aceptación pendiente

**RESULTADO:** PARTIAL. Se corrige la reconciliación de la respuesta perdida de PR draft en rama de revisión y se conserva evidencia del defecto de carrera global; no se afirma seguridad serializable ni diez tareas reales.  
**EVIDENCIA:** SHA base y archivos exactos, PR draft de T08, pruebas Bun añadidas (ejecución CI aún por verificar), simulación local 8/8 y antecedentes de issue #90.  
**BLOQUEANTE:** lease global/fencing no implementados ni ejercitados, CI del HEAD aún por comprobar al momento de redactar, sin reserva/corte de coste para un nuevo OpenCode Remote.  
**PRÓXIMA ACCIÓN:** verificar protecciones GitHub mediante un lector con permiso administrativo autorizado; verificar CI de la PR draft y corregir únicamente los defectos del candidato en esta rama si aparecen; en un lote separado coordinar arbitraje atómico real y prueba dos escritores → diez escritores sin autorizar merge ni deploy automáticamente.


---

## R2-T08 — Contrato de publicación con fencing y respuesta perdida (2026-11-22)

**Continuidad y autoría.** Esta sección pertenece a la ronda 2, construida por ChatGPT en \`f0-c10/r2-t08-github-publication-20261122\`, partiendo de la candidata #126 (base exacta \`1268ba22f26330d619b046fcf551ca846cb69d0f\`). No fue ejecutada por OpenCode Remote. #122 aportó reconciliación de recibo \`POST /pulls\`; #124 aportó el contraejemplo de dos PR superpuestas; #126 integró ambos en una **rama draft aún sin merge ni deployment**. La rama documental R2 #127 contiene \`00_COORDINACION.md\`, \`12_RONDA_2_PROMPTS.md\` y el plan completo R2.

### Decisión técnica y dependencia de T03

Se añadió en \`src/github.ts\` la **interfaz** \`GitHubPrPublicationGate\` (inyección opcional como cuarto parámetro de \`GitHubBridge\`):

- \`withExclusive(intent, execute)\` debe tomar el scope \`(repo, base)\` de forma **atómica entre todas las instancias y Durable Objects**, no con un \`Map\` local, \`busy=false\`, tags, comentarios, consulta GitHub ni lock por \`requestId\`.
- El intent canónico contiene \`repo, base, branch, title, body\`. **T03 debe añadir al registro server-side** la identidad autenticada \`taskId/sessionId\`, \`head/base SHA\`, hash de payload, generación monótona y token fencing; verificar que nadie pueda proporcionar esos datos desde un modelo.
- El \`GitHubPrPublicationPermit\` entrega \`fencingToken\`, \`retryOnly\` y \`beginExternalEffect()\`. T03 debe registrar en transacción durable el inicio de publicación y validar el token **antes del POST**. Sólo después \`GitHubBridge\` emitirá \`POST /pulls\`; dentro de una repetición \`retryOnly=true\` no lo emite nunca.
- Si una respuesta HTTP se pierde tras POST, el registro queda \`unknown/publishing\`, **no se libera por TTL**. La misma intención puede consultar GitHub y recuperar la PR exacta por branch, repositorio de head, base/head SHA, título, cuerpo y \`draft:true\`. Si la PR no aparece, se rechaza \`PR_PUBLISH_UNKNOWN\` y NO se intenta otro POST. Una intención divergente no puede superar la reserva pendiente.
- La salida exitosa debe persistir PR número/URL/SHA con la generación vigente. Otro escritor sólo puede comenzar después de confirmación durable de esa salida. Si el proceso muere entre efecto externo y persistencia, el registro previo a POST permitirá recuperar o poner en cuarentena.
- Un TTL/epoch no detiene por sí solo una llamada HTTP ya enviada por un escritor vencido: **el POST debe vivir dentro de una única autoridad de publicación** y el estado incierto debe bloquear promociones posteriores. El fencing es efectivo sólo si todas las rutas mutantes pasan por ese ejecutor. No ocultar ni liberar las operaciones \`unknown\`.

**Estado exacto:** la interfaz y el uso del permiso en el puente están implementados; **no** existe en esta rama una implementación de almacenamiento durable, un único coordinador global ni conexión desde \`src/server.ts\`. La llamada antigua \`GitHubBridge\` sin cuarto argumento conserva su comportamiento previo para no romper la operación vigente; por tanto, **la carrera real de dos PR sigue abierta sin T03**. No promover esta contribución como garantía runtime. Integrar y probar con T03 antes de habilitar diez publicaciones.

### Cambios adicionales: actualización de ref ambigua

\`replaceExact\` generaba un commit nuevo y realizaba \`PATCH /git/refs/... {sha, force:false}\`. En un 503 con efecto aplicado, el puente antes devolvía una excepción sin recibo. Ahora, ante excepción de PATCH, hace **sólo un GET** de la ref: si el SHA coincide exactamente con el commit creado, retorna el recibo \`reconciled:true\`; si no, devuelve \`GITHUB_REF_UPDATE_UNKNOWN\` sin otro PATCH. Esto **no** transforma \`force:false\` en compare-and-swap: sigue siendo una validación de fast-forward, no del SHA anterior. Para CAS de commits, GitHub GraphQL \`createCommitOnBranch\` ofrece \`expectedHeadOid\`; no resuelve el efecto distinto \`POST /pulls\`.

### Matriz de nuevas pruebas negativas

| Caso | Expectativa del test | Garantía |
| --- | --- | --- |
| Dos tareas mismo archivo, misma base, dos instancias de GitHubBridge | 1 POST y rechazo del segundo por conflicto | **Mock con un único gate compartido**, no Cloudflare |
| Diez ramas con archivos disjuntos | Diez recibos, paths y PR separados | **Mock** de publicación serializada |
| HEAD cambia durante preflight | \`PR_PREFLIGHT_STALE\`, cero POST | **Mock** contra puente real |
| POST exitoso pero respuesta HTTP 503 | Retry mismo intent lee PR exacta; nunca hace segundo POST | **Mock** con ledger de modo recuperación |
| POST ambiguo que no aparece en listado | \`PR_PUBLISH_UNKNOWN\`, cero POST adicional | **Mock**; quarantine durable pendiente |
| Payload divergente después de intento incierto | \`PR_PUBLICATION_BUSY_UNKNOWN\`, cero POST | **Mock**, requiere T03 |
| Fencing invalidado antes de POST | Rechazo \`PR_FENCE_STALE\`, cero POST | **Mock** de revocación, no fencing entre DO |
| Respuesta PATCH perdida, ref ya es commit esperado | \`reconciled:true\`, exactamente 1 PATCH | **GitHubBridge** con HTTP simulado |
| Respuesta PATCH perdida sin HEAD esperado | \`GITHUB_REF_UPDATE_UNKNOWN\`, exactamente 1 PATCH | **GitHubBridge** con HTTP simulado |
| Intento de PR sobre \`main\` o repo ajeno | Rechazo previo a API | Guarda server-side existente |

Archivo: \`src/github-publication-gate.test.ts\`. Usar \`bun test src/github-publication-gate.test.ts src/github-pr-conflicts.test.ts src/github.test.ts\`; después suite Bun completa, typecheck, build e invariantes en CI sobre HEAD exacto. Estas pruebas **no** autorizan invocaciones Remote, ni instalación de una nueva clase DO, bindings, migraciones, reglas, secretos o despliegues.

### Integridad branch → commit → PR / límites

1. **Branch:** \`ensureSupervisorBranch\` crea nombre determinista desde base SHA y devuelve recibo exacto; \`branch\` manual no es idempotente tras 503, aunque GitHub rechace una ref ya existente. La rama de tarea supervisada sigue fijada en \`src/supervisor-control.ts\`, server-side.
2. **Commit:** escritura completa \`PUT /contents\` usa blob SHA y readback por bytes; no ofrece CAS de todo el HEAD. Reemplazo \`PATCH\` impide non-fast-forward, no CAS del viejo OID. El commit objeto inalcanzable creado antes de PATCH es un efecto Git de bajo alcance distinto de actualizar una rama. Un 503 debe reconciliar antes de reintentar, sin escribir a ciegas.
3. **PR:** \`POST /pulls\` puede aplicar antes de perder respuesta. La reconciliación exacta de #122 funciona tras un reintento deliberado, pero para exclusión multi-escritor faltan ledger transaccional, fencing y publicación bajo una única autoridad de T03. Una lista vacía de GitHub no prueba ausencia de un POST en vuelo.
4. **Permisos:** no se modificaron \`ALLOWED_REPOS\`, \`assertNonCanonicalWrite\`, \`branchChecked\`, \`assertScopedTool\`, \`assertSupervisorBoundGitHubOperation\`, parámetros \`force:false\` ni política \`draft:true\`. En sesiones no supervisadas se mantiene la limitación ya documentada sobre vinculación de rama; este PR no autoriza ampliaciones.
5. **Frontera externa:** actores con token GitHub directo u otros clientes pueden saltarse un gate del puente. Deben permanecer controles CI/rulesets y revisión humana, cuya configuración efectiva no fue verificada para este cambio. **No habilitar merges automáticos**.

### Estudios de implementación externa (evidencia de patrón, no código incorporado)

- GitHub REST: \`PATCH refs\` recibe \`sha/force\`, no \`expectedOldSHA\` (https://docs.github.com/en/rest/git/refs); GitHub GraphQL: \`createCommitOnBranch(expectedHeadOid)\` (https://docs.github.com/en/graphql/reference/commits). **Ninguno** garantiza idempotencia atómica de \`POST /pulls\`.
- Aider, <https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py> y <https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt>: commit Git local con cambios acotados; Apache-2.0. No usarlo como lock global.
- SWE-agent, <https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/environment/repo.py> y <https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/LICENSE>: repositorio/environment aislado y PR opcional tras tarea; MIT. No atribuir a SWE-agent serialización distribuida de publicación.
- Cloudflare Durable Objects: <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/> proporciona transacciones **dentro de un único DO**; T03 debe asegurar que todas las tareas compartan la misma clave de árbitro o una ruta única validada. No crear un DO nuevo en T08.

**Handoff a T03:** implementar el contrato \`GitHubPrPublicationGate\` como ledger durable en la misma autoridad elegida para admisión o un coordinador ya existente. Definir identidad, estado \`reserved→publishing→committed|unknown\`, exclusión por base, incrementos de epoch, recuperación/readback sin segundo POST y almacenamiento de recibos. Probar dos instancias DO/Workers, crash entre POST y receipt, caducidad de lease y agente tardío, reanudación de \`unknown\`, más control de gastos efectivo antes de Remote. Coordinar con T04 por journal. T11 debe integrar mediante PR dependiente y verificar CI/compatibilidad con #126 antes de promover.

### CI verificada del primer HEAD R2

- GitHub Actions exact SHA `82a323368e89516d73c3c731d91d4ae13254b0a4`: [OpenCode validation #45096050118](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45096050118) **completed/success**. Job `137435968740`: **526 tests / 74 files PASS**, incluidos **9/9 R2-T08**, Typecheck, preview, build de Workers/web e invariantes sin errores.
- [F0-C10 offline #45096050062](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45096050062) y [T09 output #45096050092](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45096050092): **completed/success**, mismo SHA. No prueba runtime, DO ni despliegue.
- La adición de esta nota documental produce un **nuevo HEAD** que requiere verificación CI independiente antes de alegar CI verde del HEAD final.

**Rollback:** no fusionar el PR draft. Ninguna mutación Cloudflare/Producción fue realizada por esta contribución. \`R2-T08=PARTIAL\` hasta conexión durable verificada y E2E supervisado; \`F0-C10\` permanece \`NOT COMPLETE PASS\`.


---

## Continuación — Coordinador durable de publicación R2-T08 + T03 (candidato, NO DEPLOY)

**Fecha:** 2026-11-22 BRT / 2026-11-23 UTC. **Actor:** ChatGPT mediante GitHub; no se llamó a OpenCode Remote con efectos. **Rama exclusiva:** \`f0-c10/r2-t08-publisher-ledger-20261122\` creada del HEAD \`b3387593a1300133aa0b15f4b2e07e204313a806\` de la [PR T03 #135](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/135). Se superpuso **solo en esta rama** el delta T08 de la [PR #130](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/130), sin modificar #130, #135, #126 ni Staging. Las tres permanecían candidatas draft/unmerged en la comprobación.

### Alcance implementado

- \`src/github-publication-durable.ts\` implementa \`GitHubPrPublicationGate\` con \`DurableObjectStorage.transaction\`, un registro por \`(repo,base)\` y recibo permanente por rama. El scope se identifica mediante SHA-256 del repo/base; el hash de intención incluye repo/base/branch/título/cuerpo. El contrato es **single authority**, no un mutex por instancia.
- El registro usa \`generation\` monótona y \`token\` aleatorio, con transición \`reserved → publishing → committed\` o \`unknown\`. El TTL **solo puede renovar una reserva que aún no empezó ningún efecto**. Una vez persistido \`publishing\`, un fallo de red, respuesta perdida, restart o timeout NO permite ceder el scope a otro escritor. Los reintentos del mismo intento operan en \`retryOnly\`: pueden recuperar una PR exacta, pero no volver a hacer POST.
- \`beginExternalEffect()\` se ejecuta en transacción con validación de token/generación y revalidación opcional de sesión/tarea. Un intento revocado o una tarea cancelada antes de POST se rechazan. El efecto de red ocurre **fuera** de la transacción. Se persiste recibo estrictamente comprobado (repo, rama, base, head/base SHA, draft, número y URL). Nunca se almacena el token del servidor en el documento o en respuesta al agente.
- \`src/server.ts\` integra la publicación desde el **Durable Object ya existente y nombrado** \`SUPERVISOR_WORKSPACE = opencode-supervisor-v1\`: \`ctx.id.name\` identifica si el agente está en el mismo objeto; desde otra instancia se usa \`env.OpenCodeAgent.getByName(SUPERVISOR_WORKSPACE)\`. El método RPC \`publishSupervisedGithubDraft\` valida de nuevo el \`taskId\` derivado de \`opencode/staging-<16hex>\`, repo, proyecto \`supervised-<id>\`, \`sessionID\` auténtico y estado preparing/running. \`src/workspace.ts\` pasa \`context.sessionID\` desde la herramienta, no desde el prompt. Se revalida el registro dentro de la transacción de \`publishing\`.
- \`src/github.ts\` **falla cerrado** para PR de \`opencode/staging-<16hex>\` si falta gate, impidiendo un camino de publicación propio no coordinado. Los commits y ramas continúan sujetos a ACL preexistente; no se abrieron merge, force-push ni deploy. Los recibos de \`pr\` ahora incluyen \`headSha\` y \`baseSha\` confirmados.
- El puente GitHub nativo se mantiene. El conector oficial se utilizó únicamente para preparar la rama, publicar código/PR y verificar CI.

### Qué no garantiza todavía

1. **No se desplegó**: ni Worker, MCP, binding, migración, secretos o ajustes de Cloudflare. La identidad \`ctx.id.name\` de un DO nombrado está documentada por Cloudflare (https://developers.cloudflare.com/durable-objects/api/id/), pero la ruta RPC específica del Workers/Agents SDK actual requiere **prueba autenticada** antes de declarar el gate operativo.
2. La nueva exclusión solo cubre PR del **repositorio OpenCode Staging supervisado** que pasen por este puente y su método RPC. Otros repositorios, ramas no supervisadas, tokens directos, el conector oficial de ChatGPT, usuarios externos y otras bases pueden crear PR fuera de la autoridad. No alegar exclusión universal ni bloqueo de conflictos entre bases diferentes.
3. Los writes de contenido completo, reemplazo y creación de ramas mantienen las guardas actuales y la reconciliación acotada; **no** son transacciones globales de diez tareas. \`force:false\` no es CAS exacto del HEAD. El tratamiento de \`unknown\` puede bloquear publicaciones indefinidamente hasta reconciliación o recuperación auditada; esto es preferible a dos POST ciegos, pero requiere operación/visibilidad antes de habilitarlo.
4. El Durable Object del supervisor también gestiona sesiones y puede sufrir OOM; T01/T02 deben certificar su memoria. El gate no arregla las OOM ni los slots/scheduler de T03; no introducir un nuevo Durable Object sin autorización.
5. T04 debe revisar la política de cancelación y efectos inciertos; T11 debe comparar e integrar #130 y #135 sin sobrescribir sus ramas. La publicación candidata tiene rollback sencillo antes de merge: abandonar esta PR; **no hay rollback de datos publicado** que realizar.

### Matriz de pruebas negativas — nuevo archivo

\`src/github-publication-durable.test.ts\` contiene el fake transaccional con snapshot/restart y el puente \`GitHubBridge\` real contra HTTP simulado. Casos: dos escritores competidores, diez ramas/path disjuntos, respuesta 503 tras POST aplicado, 503 sin efecto con reinicio y UNKNOWN sticky, payload cambiado, reintento tras recibo, expiración de reserva antes de POST y fencing del propietario antiguo, tarea cancelada durante preflight, gate ausente y repositorio/rama/proyecto/sesión no autorizados, corrupción del ledger. Las pruebas de la primera ronda permanecen en \`src/github-publication-gate.test.ts\`, \`src/github-pr-conflicts.test.ts\`, \`src/github.test.ts\` y \`scripts/f0-c10-t08-integrity.test.mjs\`.

**Pruebas/CI:** ejecutar \`bun test\`, \`bun run typecheck\`, \`bun run build\`, \`bun scripts/check-invariants.mjs\`, preview y harness offline mediante workflows de PR. **No atribuir PASS antes de ver el HEAD y los pasos reales del runner.** No se llama a inferencia ni a Staging con efectos en este lote.

### Frontera de aceptación

**Estado:** \`CODE_CANDIDATE / CI_PENDING / RUNTIME_NOT_VERIFIED\`. Para aceptar este subsistema hacen falta CI verde del HEAD, prueba de RPC dentro y fuera del DO central, fault injection con reinicio entre POST y recibo, restauración del journal, doble escritor real sin doble POST, revalidación de permisos/branch y prueba de coste y memoria. Para aceptar F0-C10 siguen siendo necesarias las rondas E2E 10/10 de T10 y criterios del issue #90.

**Criterio STOP:** un token antiguo consigue publicar, aparece una segunda publicación tras UNKNOWN, la sesión ajena publica sobre rama supervisada, existen escrituras fuera del carril central o un fallo de memoria consume el ledger: bloquear promoción y no relajar permisos.


### Auditoría RED → GREEN y CI del candidato

**RED observado en GitHub Actions:** [OpenCode validation #45098032541](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45098032541), HEAD inicial \`8ed5da21298480a1ba8658d51425c9ece83420fd\`, \`failure\` en Unit tests: **10 fallos**, nueve de la nueva suite por confundir SHA-256 del fingerprint (64 hex) con SHA de commit Git (40 hex) en \`readLedger/readReceipt\`; uno por expectativa histórica de publicar una rama staging sin gate. No hubo error de infraestructura ni Remote; build/typecheck quedaron omitidos por fallo previo. No ocultar el RED.

**Reparación focal:** \`HASH=64\` para intención/fingerprint, \`SHA=40\` para OIDs Git; la antigua prueba de PR sin gate ahora espera \`PR_PUBLICATION_COORDINATOR_REQUIRED\` antes de API, y la ruta positiva se verifica a través del ledger/bridge. No se relajó ninguna guarda.

**GREEN verificado sobre SHA \`b5e3801a9ed31e69b399e1e7bb151116d0dfb308\`**:

- [OpenCode validation #45098121582](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45098121582) — \`completed/success\`; **551 pruebas aprobadas en 76 archivos**, incluidas **11/11 nuevas del ledger durable**, vistas previas, typecheck, build de Workers/web e invariantes.
- [F0-C10 offline harness #45098121612](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45098121612) — \`completed/success\`.
- [T09 offline output #45098121592](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45098121592) — \`completed/success\`.
- Ejecución: GitHub Actions con Bun **1.4.4**; los tests de T08 son mocks transaccionales en memoria y HTTP simulado, **no fault injection sobre Cloudflare real**.

**Aviso HEAD documental:** la incorporación de este registro crea un commit adicional posterior al SHA citado; verificar nuevamente los tres workflows sobre el HEAD final. Mantener PR draft y no permitir merge/deploy por el hecho de que el candidato tenga CI verde.


---

# F0-C10/R3-T08 — HEAD auténtico, respuestas ambiguas y diez escritores stateful

**Corte:** 23-11-2026 UTC. **Autoría:** ChatGPT mediante el conector GitHub autorizado; **OpenCode Remote NO START**, sin Codex, sin gastos de inferencia iniciados, sin despliegues ni mutaciones Cloudflare. **Estado de área:** `PARTIAL` hasta la verificación del HEAD final y entorno real; el objetivo de diez agentes activos continúa sin demostrarse.

**Base de código:** PR [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) `a49e985909cb56bb42c609c9cd5cb4250a620169` (apilada #144→#143→#126, todas draft). **Rama R3 propia:** `f0-c10/r3-t08-multiwriter-20261123`, sin modificar los ancestros. La documentación R3 se consultó en [#146](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/146) (rama documental distinta; **no** incorporada automáticamente). El informe anterior T08, los ensayos R2 y #138 son evidencia previa, no aportes independientes que deban reaplicarse.

## R3.1 Defecto RED demostrado y reparación mínima

**Causa:** `src/github.ts` hacía el último `GET headSha`, después `beginExternalEffect()` y `POST /pulls`. Una actualización del HEAD por otro cliente en esa ventana hace que GitHub publique **la nueva punta**, pero el puente devolvía `headSha` de la punta previamente revisada y `github-publication-durable.ts` guardaba un recibo como correcto. En una respuesta 503 tras POST aplicado, el reintento de la misma intención podía leer la rama y PR ya avanzadas y reconciliar **el SHA posterior**, porque el ledger identificaba la intención por repo/base/rama/título/body y **no persistía los SHA del efecto**. Esto es un falso positivo real del contrato ante un mock con interleaving, no una medición de GitHub remoto.

**RED ejecutado:** [Actions #45109568863](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45109568863), HEAD `a4dab85f4d2d821eeec7d373bd371899daedc3cf`, fallo esperado únicamente en los dos tests R3 nuevos: (1) HEAD cambia entre el GET final y POST; (2) POST con respuesta 503 perdida y cambio de HEAD antes de reconciliar. En ambos casos `expect(...).rejects` observó una Promise resuelta falsamente.

**Corrección:** `GitHubPrPublicationPermit.beginExternalEffect({baseSha,headSha})` registra ambos OID Git de 40 caracteres en el ledger, con `token+generation+owner` validado en **la misma transacción durable** que cambia `reserved→publishing`. Tras POST, el puente exige que la **respuesta GitHub** contenga `created.head.ref/sha` y `created.base.ref/sha` iguales al branch/base/SHA revisados; de lo contrario emite `PR_PUBLICATION_HEAD_CHANGED`, el gate conserva `unknown` y nunca reenvía `POST`. Un reintento `retryOnly` recibe exclusivamente el `expectedProof` original del ledger/recibo y rechaza un HEAD distinto **antes** del preflight posterior. La confirmación transaccional rechaza también recibos cuyos SHA difieran del proof persistido.

**Límite semántico:** no existe una instrucción GitHub `create PR if branch HEAD == expected SHA` atómica. El chequeo del PR después del efecto **detecta** una publicación a SHA diferente y la pone en cuarentena, pero **no impide el primer POST** que produjo una PR con el SHA ajeno. Un actor con credenciales directas puede seguir actualizando la rama/PR fuera del gate. Se necesita aislar realmente a todos los mutadores de esa rama y protecciones externas para una garantía más fuerte. No se permite llamar a esto `exactly-once` global.

## R3.2 Contrato branch → commit → PR y garantías

| Frontera | Control vigente | Prueba o límite |
| --- | --- | --- |
| `ensureSupervisorBranch` | `GET` fuente, `POST /git/refs` de nombre determinista; reconciliación exacta con ref fuente tras 503 | Unicidad GitHub por nombre, rama ajena distinta SHA se rechaza; no lease global |
| `branch` expuesto al agente | `branchChecked` `opencode/*`, repo allowlist, Source Staging para patrón supervisor | No permite `main` ni `staging/...`, no `force`; por sí solo no es idempotente |
| `write` completo | `PUT /contents` con `sha` de blob anterior; mismo contenido por `GET` devuelve `unchanged/reconciled` | 1 PUT efectivo al perder 503; dos contenidos rivales al mismo path deben resultar 1 éxito + 409; no compare-and-swap de todo HEAD |
| `replaceExact` commit | Ancla única, `expectedHead`, Git blob/tree/commit, `PATCH /git/refs force:false` | GitHub aplica fast-forward, **no** expected-old-SHA CAS; GET posterior permite confirmar commit exacto tras 503 sin segundo PATCH |
| `pr` supervisada | Transacción del DO supervisor nombrado `repo+base`, token/epoch, revalidación de tarea/sesión/proyecto en transacción de publish, `publishing/unknown` durable | Un solo POST mientras está ocupado; pinned head/base SHA + comprobación de respuesta y recibo; resultado perdido nunca autoriza segundo POST |
| RPC y scopes | `assertScopedTool` fija repo/proyecto y `assertSupervisorBoundGitHubOperation` fija rama; `assertSupervisedPublicationScope` fija tarea, sesión, proyecto y estado | Cruce de sesión, rama, proyecto, repo o tarea cancelada se rechaza antes del POST |
| Fuera del puente | Token GitHub directo, cambios en rama protegida o merge externo | **No** cercados por el ledger. Rulesets/branch protection efectivos no se dieron por demostrados |

**CAS relevante:** GitHub `PATCH /git/refs` con `force:false` solo prohíbe movimientos no-fast-forward, no fija `oldOid` en una condición server-side; el `sha` de Contents solo condiciona el blob del fichero. No se introdujo segundo scheduler ni se cambiaron reglas de GitHub. El publicador T08 depende del storage/owner T03 ya integrado en #145. No reescribir `src/server.ts` como solución artificial de la carrera.

## R3.3 Instrumentos y métricas verificables

- **RED/HEAD movido:** `src/github-publication-durable.test.ts`, dos casos nuevos con ref que cambia después del `GET` final o entre POST perdido y readback. Tras el parche se exige `PR_PUBLICATION_HEAD_CHANGED`, un único POST y `unknown` sticky; no recibe `reconciled:true` falso.
- **Regresión heredada R2:** `src/github-publication-gate.test.ts` actualiza **solo el mock** para aportar `beginExternalEffect(proof)`, `expectedProof` y retorno `head/base.sha`. El contrato de producción se hizo más estricto; los fixtures antiguos no podían acreditar el SHA al no simular la respuesta real de GitHub.
- **Prueba stateful adicional:** `src/github-r3-multiwriter.test.ts` usa `GitHubBridge` y `DurableGitHubPublicationGate` auténticos con GitHub HTTP y storage transaccional **simulados**. Almacena refs, contenidos/blobs, commits, paths, PR, historial de mutaciones y recibos en memoria sin llamadas reales a GitHub.
- **Diez escritores:** diez nombres deterministas y diez archivos exclusivos; `Promise.all` para crear ramas/escribir, lote de diez PR con una publicación mantenida en vuelo; nueve rechazos `PR_PUBLICATION_BUSY_UNKNOWN` sin efectos, que se reenvían **solo después** de demostrar que no pasaron la frontera mutante; total esperado **10 nuevas refs, 10 PUT efectivos, 10 commits de archivos, 10 POST PR, 10 recibos, 10 paths disjuntos**, SHA de `main` y Staging inalterados. La serialización de **publicación**, no de la ejecución de agentes, es deliberada y no impide que diez tareas Linux/inferencia trabajen simultáneamente.
- **Mismo destino:** dos PUT competidores con distinto contenido en la misma rama/path producen un único commit efectivo y 409 del otro en el mock de SHA condicionado; dos ramas con blobs distintos sobre el mismo path conservan ambos contenidos pero el segundo `POST /pulls` se bloquea por `PR_WRITE_SCOPE_CONFLICT`. Una colisión de PR no debe confundirse con pérdida de su archivo en la rama.
- **Respuestas perdidas:** crear ref determinista, PUT de Contents y POST PR pueden aplicar y devolver 503 simulado. El mismo `requestId`/branch/payload se recupera con GET/receipt exacto y **1 efecto efectivo por mutador**, sin repetir a ciegas ni atribuir otra operación. Un payload distinto al mismo branch falla con `PR_BRANCH_INTENT_CONFLICT`.
- **ACL negativa:** acciones a `main`, ref Staging, repositorio ajeno, sesión de otro propietario, tarea cancelada, proyecto y rama cruzados denegadas; cero escrituras ni llamadas HTTP para los rechazos previos a acceso. Las suite heredadas mantienen pruebas de rename, archivos truncados, HEAD obsoleto y reglas de ruta.

**Evidencia de entorno:** Cloudflare lectura devolvió Workers activos principal `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` y MCP `196240c0-1052-47b3-aaa7-02cf5baa87f0`, ambos 100%; Remote `status=ok`, 96 sesiones **al menos** registradas con `supervisedCountComplete=false`. Nada demuestra binarios R3 activos ni diez agentes reales. No hubo RPC Remote con efectos, DO alterado o inferencia. El coste de GitHub Actions/Cloudflare por consultas **no se midió**.

## R3.4 Orden mecánico de integración para T11

1. **Punto de partida:** confirmar HEAD/estado de #145 y su ascendencia #144→#143→#126. La R3-T08 debe compararse por `compare_commits(base SHA exacto, head SHA exacto)`. No cherry-pick de #122/#124/#130/#138 porque su código ya es ancestro del candidato, ni reintroducir la alternativa #131. La PR documental #146 es paralela y no reemplaza la fuente.
2. **Ownership por archivo:** T08 solo modifica `src/github.ts`, `src/github-publication-durable.ts`, sus pruebas, `docs/f0-c10/08_GITHUB_INTEGRIDAD.md` y el workflow de validación de esta rama. `src/server.ts`, `src/supervisor-admission.ts`, `src/supervisor-r2.ts` y journals de recuperación pertenecen a T03/T04; comparar contratos/funciones si T03 cambió el estado de la tarea. No sobrescribir archivos enteros al integrar.
3. **Colisiones:** para cada PR R3 comprobar `base/head SHA`, rename `previous_filename`, intersección de archivos y dependencias de ámbito (no solo nombres); rechazar `truncated`/listas incompletas. Si una rama modificó el mismo path que otra, conservar ambas ramas y resolver con revisión semántica; no asumir que un merge textual sin conflictos equivale a integración.
4. **Orden:** integrar primero contratos de admisión/recuperación T03/T04; aplicar después solamente los hunks de `GitHubPrPublicationProof` del puente T08 y ledger durable, sin cambiar el nombre de DO ni duplicar el coordinador. Integrar el resto de especialistas con fuente/owner definidos; no incluir de forma automática `.github/workflows/f0-c10-r3-t08.yml` como workflow permanente (solo dispara en la rama R3).
5. **Revalidación de 10 ramas:** tras cualquier integración que toque `github.ts`, ledger durable, scope, server o SDK, volver a ejecutar el test stateful de diez PR, carreras, HEAD movido, 503 y fallos de autorización **sobre el HEAD integrado**, luego `bun test`, preview, typecheck, build ambos Workers/web, invariantes y CI del mismo SHA. Un PASS individual o de un HEAD anterior no autoriza promover.
6. **STOP:** si un POST se repite tras `unknown`, un recibo acepta SHA distinto, el scope permite un escritor ajeno, o el runtime pierde fencing/recovery, mantener `PARTIAL` y no probar Staging con efectos hasta control de costes, identidad binaria y rollback verificados.

**Referencias externas:** se conservaron las investigaciones y SHAs/licencias de GitHub REST, Aider, SWE-agent y OpenHands recogidos en R2. R3 no incorpora código de terceros ni dependencias nuevas. El defecto y la corrección surgen del propio contrato de GitHub REST ya auditado, sin nueva investigación externa de coste.

**Cierre T08:** prueba offline de identidad y serialización del publicador, **no garantía live de diez agentes**. GitHub sigue siendo autoridad de código y CI; el puente OpenCode permanece en uso. No fusionar, desplegar ni modificar infraestructura dentro de este lote.

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

# R2-T08 — Publicación idempotente con journal durable (continuación)

**Autoría:** ChatGPT mediante GitHub; **OpenCode Remote: NO START**. **Fuente R2:** PR [#126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126), base de rama de T08 `1268ba22f26330d619b046fcf551ca846cb69d0f` (PR draft/unmerged); plan R2 en [#127](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/127). Esta sección no sustituye las pruebas históricas del informe superior. **Estado: CANDIDATO / NO RUNTIME PASS**.

## R2.1 Contrato de seguridad y SHA

- **`branch`:** `POST /git/refs` tiene unicidad del nombre de referencia, pero no crea un lease reusable. El supervisor `ensureSupervisorBranch` reconsulta la misma SHA tras colisión de creación, rechaza nueva base, no force-push.
- **`write` completo:** `PUT /contents` usa SHA de blob actual de archivo, no CAS del HEAD completo; retorno perdido se reconcilia por lectura exacta del contenido de *esa rama*. Distintos escritores sobre la **misma** rama todavía requieren un solo dueño. Si la respuesta está perdida y otro contenido fue publicado, no reinterpretar la diferencia como permiso para volver a escribir sin journal.
- **`write` reemplazo:** exige `expectedHead`, construye commit hijo, `PATCH /git/refs` con `force:false`. Esto rechaza actualizaciones **no fast-forward**; no admite parámetro REST atómico `expected_old_sha`. El patrón `GET HEAD → PATCH` no es CAS general y no bloquea otros hijos por sí solo.
- **`pr`:** actual preflight comprueba refs, paths (incluidos renames), PR abiertas y vuelve a leer SHA; no es transacción con `POST /pulls`. GitHub REST no ofrece una clave idempotente de PR documentada. Reintentar un POST tras `503` o respuesta perdida es peligroso; una lista temporalmente vacía no autoriza repetir.
- **Permisos:** `GitHubBridge` verifica propietario y allowlist, `opencode/*`, rutas protegidas, tamaños y modo del agente; `OpenCodeAgent.enforceSessionScope` vincula `sessionID`, repo y rama de `requestId` antes de la herramienta. Plan/Review solo lectura. El token vive en Secrets/Settings del Worker, nunca en Linux. Estas reglas NO cubren tokens GitHub externos ni los controles de merge; en lectura anterior `rulesets=[]` y protección de `main` inaccesible 403. No se alteraron reglas ni permisos.

**Matriz R2 (sin falsos positivos):**

| Efecto | Precisión posible | Reparación implementada / pendiente |
| --- | --- | --- |
| Crear rama determinista | Unicidad de ref + GET readback | Existente, no global mutex |
| Actualizar un archivo con SHA de blob | Conflicto de versión de archivo, no todo HEAD | Existente; requiere único dueño de rama |
| Commit hijo y PATCH `force:false` | Fast-forward, no expected SHA CAS | Existente, requiere scope + head pin |
| Abrir PR tras lista/compare | No atómico: dos POST pueden ganar | **Nuevo gate opcional** para serializar base |
| PR POST con respuesta perdida | Estado externo puede ser `unknown` | **Nuevo journal: no segundo POST**; reconciliación solo GET |
| Timeout/crash entre preflight y POST | Si ya se marcó intento, efecto es incierto | `unknown` durable; sin TTL/retry ciego |
| Otro escritor tras `unknown` | Nunca conceder exclusión concurrente | Bloqueado hasta recibo verificado o resolución autorizada |
| Staging real actual | Puente aún no conectado al gate | **NO GARANTÍA LIVE; NO DEPLOY** |

## R2.2 Implementación candidata

**Archivos nuevos/actualizados en la rama exclusiva R2:**

- `src/github-publication-gate.ts`: interfaz de almacenamiento transaccional y `GitHubPublicationGate.run()`, con scope `SHA256(repo,base)`, huella del payload, `generation` monótono y estados `free → preflight → unknown → free`. Mientras haya `preflight` o `unknown`, la transacción rechaza cualquier otro propietario. Solo un recibo verificado autoriza liberar `unknown`.
- `src/github.ts`: `pr` pasa por el gate **únicamente si está inyectado**. Antes de enviar `POST`, persiste `unknown` y SHA base/head, dentro de una transacción; la reconciliación en la repetición de la misma intención usa únicamente `GET /pulls?state=all&head=...&base=...` y exige identidad exacta. Si faltan datos, difieren SHA/payload/branch/fork o hay resultados ambiguos, **no reenvía POST**. Existe un parámetro `requirePublicationGate` optativo que falla cerrado para ramas `opencode/staging-<16hex>` si el gate falta. **T03 debe activarlo tras conectar el almacén compartido, y T11 revalidar compatibilidad.** El bridge conserva su API histórica para otros clientes.
- `src/github-publication-gate.test.ts`: almacén transaccional de mocks compartido entre instancias de bridge, dos escritores rivales con barrera, diez branches, HEAD movido, POST remoto exitoso + 503 perdido, POST 503 sin efecto observable, payload divergente, escape de repo/main y strict fail-closed.

**Fencing exacto:** `generation` y `owner` se validan transaccionalmente antes de marcar el intento. Después de `markEffect()`, el slot queda **`unknown` persistente** *antes* del POST GitHub. No hay expiración automática, porque vencimiento por reloj no puede invalidar un HTTP POST ya enviado. Un escritor antiguo no puede adquirir una nueva generación por encima de un `unknown`. El gate serializa operaciones solo entre clientes que utilizan **el mismo almacén durable**. Un wrapper almacenado en memoria de cada Worker **NO** basta. Si alguien escribe a GitHub sin el gate, la garantía de exclusión no aplica.

**Conservadurismo deliberado:** si el proceso muere en `preflight` antes de publicar, la reserva puede bloquear nuevas PR hasta recuperación del propietario. No hay borrado manual ni liberación automática implementados en este candidato. Si el proceso muere en `unknown`, la misma huella solo puede ejecutar un GET de reconciliación; un resultado negativo del GET deja `unknown`, porque una lectura no establece que el POST no se haya completado. Esto sacrifica disponibilidad puntual, no integridad.

**Efectos fuera del gate:** `branch` y `write` siguen protegidos por scopes y guardas actuales, pero **no** pasan todavía por esta exclusión compartida. Para garantizar escrituras de dos sesiones a la **misma rama** se necesita T03: vincular `requestId → rama` a un único writer y, si es necesario, incluir todas las mutaciones de rama en una sección exclusiva; de lo contrario el contrato de PR solo garantiza exclusión del paso PR, no la totalidad `branch → commit → PR`.

## R2.3 Dependencia explícita de T03 — NO conectada aún

T03 conserva la propiedad de la admisión de tareas, su journal, límites de capacidad y budget; T08 no añade un segundo scheduler de agentes ni nuevos bindings. T03 debe suministrar una transacción `transaction(get/put)` **desde una identidad Durable Object común para todos los writers del mismo repo/base**, preferentemente el supervisor ya compartido mientras siga siendo la autoridad. Instanciar un nuevo `GitHubPublicationGate` por petición está permitido **solo si todos apuntan al mismo storage durable**, no al storage de DO distintos. Debe inyectarse en el constructor de `GitHubBridge` y habilitar `requirePublicationGate=true` para Staging cuando la compatibilidad y la recuperación estén verificadas. No alterar el plan R2 o la rama #126 desde T08.

T03/T04 deben especificar recuperación administrativa reversible de `preflight` abandonado, demostración de que no hay writer vivo y reconciliación `unknown` sin saltar el fencing; nunca liberar `unknown` mediante TTL. T11 integrará esta interfaz con #126 y verificará DI/scope, regresiones, coste y E2E. Mientras falta la inyección, **esta implementación está preparada pero no operativa en Staging**, y el preflight legado conserva la carrera.

## R2.4 Negativos, criterios de aceptación y pruebas

Correr `bun test src/github-publication-gate.test.ts src/github-pr-conflicts.test.ts src/github.test.ts`, `bun run typecheck`, `bun run build`, `bun scripts/check-invariants.mjs` en el HEAD de esta PR. La CI no prueba transacciones reales de Cloudflare: `TransactionalStore` es un simulador con cola serial. No se publican diez PR reales: las pruebas son HTTP fake y, en la primera ronda, Git worktrees locales.

**Aceptación offline:** segundo escritor no hace POST mientras primero ocupa reserva; tras PR A, B con path solapado se rechaza; diez rutas disjuntas producen diez recibos sintéticos separados; HEAD movido bloquea; respuesta 503 después de POST exitoso concilia exactamente un recibo y un POST; respuesta 503 sin evidencia deja `unknown`; payload distinto se bloquea; fallo de permiso no toca API. **Aún no es aceptación integral de diez agentes activos.**

**STOP:** no usar `unknown` como `failed` para reiniciar, no auto expirar efectos, no reintentar POST a ciegas, no introducir cambios en `main`, reglas, ramas ajenas, Workers, secretos ni Producción. No inferencia, Staging Remote con efectos, merge o deploy en este lote.

## R2.5 Implementaciones externas verificadas (sin código copiado)

- **Aider:** fuente [`aider/repo.py` en commit `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py), licencia **Apache-2.0** ([repositorio](https://github.com/Aider-AI/aider)). Aprende trazabilidad de commits/ediciones, **no** promueve su Git local a mutex distribuido.
- **SWE-agent:** [configuración y checkout `sweagent/environment/repo.py` en `3ea751c087f32b16e039a2233dd6eefecef325d5`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/environment/repo.py), licencia **MIT** ([LICENSE](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/LICENSE)). Proporciona contexto reproducible por `base_commit`; tampoco arbitra `POST /pulls` externo.
- **OpenHands SDK:** [`openhands-agent-server/openhands/agent_server/event_service.py` en `ebec01b3893696c2f5454762eb44796c71bb391a`](https://github.com/OpenHands/software-agent-sdk/blob/ebec01b3893696c2f5454762eb44796c71bb391a/openhands-agent-server/openhands/agent_server/event_service.py), licencia **MIT** ([repositorio](https://github.com/OpenHands/software-agent-sdk)). Se observó `ConversationLease` con `generation`: patrón comparable para eventos, **no** prueba de fencing GitHub REST.
- **GitHub:** [REST Git references](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28) (force:false = fast-forward), [REST Pull requests](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28) (sin idempotency-key para create PR documentada), [GitHub Contents](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28) (`sha` del archivo). Un `git update-ref <new> <old>` local es CAS para ese repositorio, pero **no se trasladó** a GitHub REST.

**Procedencia:** commits de terceros obtenidos del endpoint REST `/commits/main` en la consulta de esta ronda; se conservaron SHA y licencia. Cero imports/copia de código externo.

## R2.6 Cierre técnico de esta ronda

**RESULTADO:** candidato con journal durable y exclusión de publicación opcional, no activado ni desplegado.  
**EVIDENCIA:** commits/diff de rama R2, prueba RED de carrera previa, nuevos tests y CI del HEAD (ver PR draft para estado final).  
**BLOQUEANTE:** inyección de storage de DO común + strict mode + recuperación de `unknown`/T03; aún sin prueba E2E de Cloudflare ni control de coste.  
**PRÓXIMA ACCIÓN:** integrar interfaz con T03 en lote T11 y ejecutar test de dos writers en Staging únicamente tras permiso/preflight de gastos, luego escalar a diez.

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

**Límite:** estas guardas gobiernan el puente propio cuando el agente lo usa. No gobiernan automáticamente el conector GitHub oficial de ChatGPT, tokens externos, usuarios con permisos directos, merges o cambios por otra API. El conector oficial en este encargo solo fue usado para la rama T08 y su draft. Las protecciones/rulesets efectivos de GitHub requieren auditoría independiente de reglas (no fueron modificados ni se presupone su configuración).

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
**PRÓXIMA ACCIÓN:** verificar CI de la PR draft y corregir únicamente los defectos del candidato en esta rama si aparecen; en un lote separado coordinar arbitraje atómico real y prueba dos escritores → diez escritores sin autorizar merge ni deploy automáticamente.

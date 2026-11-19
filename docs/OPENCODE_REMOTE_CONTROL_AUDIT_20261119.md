# Auditoría de OpenCode Staging Remote Control — 2026-11-19

## Resultado

El servidor MCP remoto y el conjunto E2E están desplegados y operativos contra Staging. La campaña final de GitHub Actions pasó; además se hicieron pruebas reales de reparación aislada, delegación, recuperación tras desconexión, concurrencia idempotente y cancelación confirmada. La revalidación del 2026-11-19 agregó una prueba real OpenRouter + Bun/Linux, confirmó una llamada MCP dinámica en vivo y corrigió la atribución de evidencia OpenRouter. El estado `finished` indica que terminó la ejecución; no aprueba cambios. Las ramas y PR creadas siguen sujetas a revisión humana.

El único destino configurado es `opencode-g1-staging`. Cloudflare muestra el Durable Object `OpenCodeAgent` de Staging en el namespace `0a43752314b24fe4a89327c7ecda787c`; el MCP enlaza ese mismo namespace y el Service Binding `STAGING_HEALTH` apunta a `opencode-g1-staging`. Producción conserva su namespace distinto (`401fd8de9521408cbe3d9205988dc952`) y `OPENCODE_SUPERVISOR_ENABLED=false`. No se enviaron operaciones del conector a Producción ni se modificaron sus recursos.

## Cambios y despliegue

- La rama de trabajo es `feat/remote-control-hardening-20261119`. Los cambios remotos están en `f727efd2bdc93a1f2d2219fcf4fc0731fa3a7a6b`; la corrección funcional principal del MCP está en `c935c13fb1b371cb56aafb44574032c006965ed6`. La corrección de atribución de autopruebas OpenRouter está en `059c7d3f1a52df5423ec3048b9b3684248d95d8a`.
- El MCP expone 21 herramientas, incluido descubrimiento y llamada a MCP ya configurados, sesiones aisladas por defecto, fork con workspace UUID y sesión exactos, continuación idempotente, progreso, cambio de modelo, cancelación verificada y revisión sin aprobación automática.
- El Worker MCP independiente usa OAuth de Cloudflare Access y bindings fijos a Staging. La campaña E2E inicial se ejecutó contra el despliegue `67eac2c3-fdbe-4a4a-860b-16662624a47a` (versión `996479ad-ae49-4dce-bb31-b9e9362ffc14`). El despliegue posterior de documentación fue `e962cd88-033c-4aa3-ae35-9afaef009965` (versión `f8a75580-01b3-4e67-9163-2c83f55d870d`). La revalidación del commit `059c7d3…` desplegó OpenCode Staging como `56046df3-160a-4ddc-8d34-c7cee32b641d` (versión `d044b3a2-3829-4336-bbbe-0dce75b46c6a`, 100% tráfico; Cloudflare Build `e0f3776e-30dd-4e2a-918f-d0cbb7fe5446`, `stopped/success`) y el MCP como `38e2ebd8-3307-4b8b-b5da-73e730b839e6` (versión `f85296d1-0e0c-4fcb-b7e6-bbbb3a057cb1`, 100%). Health de OpenCode Staging fue `ok` con `targetWorker=opencode-g1-staging`.
- Se corrigió un defecto encontrado en la primera ejecución intensiva: una respuesta MCP grande se truncaba después de serializarse y dejaba JSON inválido. El recorte ahora conserva JSON válido e indica `_responseTruncated`; una regresión reproduce respuestas mayores de 16 KB.
- La guía operativa está en `OPENCODE_STAGING_CONTROL_MCP.md` y `OPENCODE_REMOTE_CONTROL_RUNBOOK.md`. El plugin privado OpenCode Cloud Remote tiene la guía de uso versión 1.1.0.

## Pruebas y evidencias

| Prueba | Resultado observado |
| --- | --- |
| Unitarias y build | GitHub Actions run `44443685925`: 336 pruebas pasaron, 0 fallaron; build MCP y comprobación del Worker finalizaron correctamente. |
| OAuth, protocolo y descubrimiento | La petición sin credenciales recibió HTTP 401 y `WWW-Authenticate: Bearer` con metadata protegida descubrible por HTTPS. Con credenciales de CI, `tools/list` devolvió las 21 herramientas; estado `ok`, destino y supervisor identificados como Staging. |
| Interfaz móvil | Playwright headless pasó contra Staging en viewport 393×852, con nueva conversación, cambio de modelo Cloudflare y ciclo offline/online. Evidencia visual: [artifact 14491813091](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44443685925/artifacts/14491813091), SHA-256 del ZIP `fb5dffceff78f6cfd12bb7fe6b870f91f30068cc46f2591c5ad27195ba458190`. |
| Reparación aislada (experimento B) | `staging_agent_check` con modelo `economy` detectó primero una prueba fallida, ejecutó 4 llamadas de herramienta y verificó el archivo reparado de forma independiente. Resultado `passed`; proyecto aislado `agent-check-2f3ca20e7faf`. |
| Delegación de ingeniería (experimento A) | Tarea `0a62c322d8f44b8d`, modelo `economy`, terminó en `finished`, con 37 llamadas (36 completadas y 1 fallida), transcript real, pruebas Bun y revisión de rama. OpenCode creó la PR borrador [#80](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/80); no se fusionó ni desplegó. El estado mantiene `passed=false` y `verified=false` hasta revisión humana. |
| CI de la PR experimental #80 | FAIL | Run `44444780940`: unitarias y UI pasaron, pero el smoke MCP falló en la comparación del catálogo: esa rama esperaba 8 herramientas y el Worker desplegado devolvió 21. Es una incompatibilidad de esa rama experimental con la versión Staging actual; no se integró. |
| Desconexión y recuperación (experimento C) | Tarea `689a2d8d455e4c75`: tras dos reconexiones, el mismo `requestId` recuperó sesión, rama y operación; una continuación con `turnId` idempotente ejecutó otro comando. Estado `finished`, 3 llamadas completadas, sin duplicar operaciones. Transcript SHA-256 `69b60581125c12210176f1fde8930fac9689c115044c3d7e877710f3d78db09f`. |
| Concurrencia real | Dos solicitudes simultáneas con el mismo ID `f81d29a4c6570be3` devolvieron la misma rama, sesión y `operationId`; solo una fue aceptada y la otra reutilizó la reserva. OpenCode ejecutó `node -e "console.log('CONCURRENCY_OK')"` una vez, con `exitCode: 0`. |
| Cancelación real | La tarea `45fa73b6e1092c84` fue interrumpida por OpenCode: `confirmed=true`, `abortAccepted=true`, razón `interrupted`; el estado persistido pasó a `cancelled`. No quedó ejecutándose el comando largo solicitado para la prueba. |
| Catálogo MCP y recuperación de defectos | La campaña final terminó en GitHub Actions run `44443685925` (commit `f727efd…`). Artefacto JSON: [artifact 14493225781](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44443685925/artifacts/14493225781), ZIP SHA-256 `6bee483a8c2c320ccee53c067f1755567a2281204a68b77436612c4c07b9ce29`. Una ejecución anterior, `44442766787`, detectó el defecto de JSON inválido; la ejecución posterior pasó. |
| Revalidación de corrección de estado | GitHub Actions run `44466336632` sobre `059c7d3…`: unitarias/build, MCP E2E y Playwright móvil terminaron correctamente. Run de validación acompañante `44466336941` también pasó. Localmente: `bun test` 337/337, `bun run typecheck`, `bun run build` y `wrangler deploy --dry-run --config wrangler.mcp-staging.jsonc` pasaron. |
| OpenRouter + Bun/Linux real | PASS: `agent-check-3b1b0ec2dc7b` en `opencode-g1-staging` terminó `passed`; `providerID=openrouter`, `providerModel=z-ai/glm-5.3-flash`, preset `review`, `toolCalls=1`, Bun `1.4.4`, y `modelVerified`, `runtimeVerified`, `toolProofVerified`, `fileVerified` verdaderos. La API de estado no reveló credenciales. |
| MCP dinámico en vivo | PASS: Staging descubrió `cdf-workbench-staging`, enumeró sus tres herramientas bajo allowlist y ejecutó la lectura `workbench_status`: `READY`, CDF `PASS`, generación `42`, equivalencia `VERIFIED_SCOPED`, `canon_modified=false`. No se invocaron operaciones de escritura. |

## Matriz de aceptación

| Criterio | Estado | Alcance de la evidencia |
| --- | --- | --- |
| Conectividad, estado y descubrimiento MCP | PASS | 401/metadata OAuth, llamadas autorizadas de CI, 21 herramientas y health real de Staging. |
| Sesiones aisladas, recuperación, continuación y cancelación | PASS | Recuperación tras dos reconexiones, reintentos idempotentes y aborto confirmado. |
| Fork de una sesión existente | BLOCKED | El contrato exige UUID exacto del workspace y `ses...` de origen. No se proporcionó un par real para probar; el caso sin sesión de origen falla cerrado. |
| Modelos y ejecución Cloudflare | PASS | Catálogo y tareas reales con el preset económico de Cloudflare. El cambio de modelo de la UI se verificó con Playwright. |
| Inferencia OpenRouter | PASS | Una llamada real al modelo configurado completó además prueba de Bun, herramienta Linux y archivo temporal aislado. |
| Descubrimiento de MCP existentes | PASS | Se descubrió el servidor real configurado y sus tres herramientas bajo allowlist. |
| Ejecución E2E de una herramienta MCP dinámica | PASS | `workbench_status` se ejecutó en vivo y devolvió `READY`; operación de solo lectura. |
| Archivos, Linux, pruebas y cambios GitHub | PASS | Reparación red-a-verde, comando Linux real, pruebas del repo, branch y PR borrador inspeccionados. |
| Delegación supervisada | PASS | OpenCode ejecutó trabajo real y entregó branch, transcript y revisión; quedan revisión humana y el registro de una llamada fallida. `finished` no equivale a aprobación. |
| CI del resultado generado por la delegación (#80) | FAIL | El smoke MCP de esa PR esperaba el catálogo antiguo de 8 herramientas, mientras el servicio actual publica 21; unitarias y UI sí pasaron. La PR sigue borrador y no está lista para fusionarse. |
| Concurrencia | PASS | Se probó la carrera de dos llamadas duplicadas y se observó una sola operación. No se hizo una prueba de saturación de alta carga. |
| Diagnóstico de un fallo de OpenCode | PASS | Reparación red-a-verde aislada y health/diagnostics reales. No se indujo una caída del Worker de Staging. |
| Aislamiento de Producción | PASS | Binding MCP y namespace DO son de Staging; namespaces separados y flag supervisor de Producción desactivado. |
| Catálogo del plugin en esta conversación de ChatGPT | PASS | En esta conversación se cargó el catálogo actualizado y se operaron herramientas de estado, OpenRouter y MCP dinámico; el servicio devolvió el destino fijo de Staging. |

## Límites y siguiente uso

- El MCP remoto es independiente de Playwright; el job MCP instala dependencias de producción y verifica que Playwright no está instalado. La UI E2E opera de forma determinista y no usa un agente para decidir clics.
- No se hizo una carga de concurrencia masiva ni una caída artificial del Worker; se evitó ampliar el impacto más allá de pruebas aisladas de Staging.
- El fork explícito queda sin prueba E2E porque el usuario eligió no proporcionar un par workspace UUID/session ID. La herramienta falla cerrada sin ambos identificadores exactos; no se enumeró ni inspeccionó una sesión para adivinarlos.
- Las ramas y la PR borrador de la campaña no están aprobadas. Antes de incorporar cambios, revisar el diff y ejecutar el CI correspondiente; no fusionar ni desplegar esas ramas automáticamente.

## Continuación de validación — 2026-11-19

La revisión de la evidencia encontró que `openrouter_check_status` podía etiquetar como OpenRouter el resultado de otra autoprueba genérica de OpenCode. La causa era reutilizar la misma clave durable de estado para dos tipos de prueba. El cambio `059c7d3` separa las claves, conserva proveedor/modelo solicitado al iniciar y valida identidad del modelo, Bun y evidencia de herramienta/archivo antes de informar `passed`. La regresión comprueba que las dos pruebas no se atribuyan evidencia mutuamente.

La revisión de código superó 337 pruebas (0 fallos, 1519 expectativas), typecheck y build. Wrangler dry-run para el MCP confirma los bindings a `opencode-g1-staging`. GitHub Actions `44466336632` y `44466336941` están verdes. Cloudflare construyó y desplegó los Workers de staging indicados arriba; producción no fue destino de estas verificaciones.

La verificación live del MCP confirmó estado HTTP saludable del Worker de OpenCode, catálogo de modelos ya configurados sin secretos y el servidor dinámico OAuth `cdf-workbench-staging`. El descubrimiento respetó la allowlist de `workbench_status`, `workbench_catalog` y `workbench_read`; la llamada ejecutada fue solo `workbench_status`.

La operación Linux de marcador `77d94a2fb8195a01` produjo el marcador esperado y exit code 0, pero el supervisor la dejó `passed=false, verified=false` porque no hubo revisión independiente. Se conserva como evidencia de ejecución de comando, no como tarea delegada aceptada.

El PR #81 sigue abierto, en borrador y sin fusionar. El criterio de fork continúa `BLOCKED`; no afecta el modo aislado predeterminado ni justifica inspeccionar sesiones ajenas.

# Auditoría de OpenCode Staging Remote Control — 2026-11-19

## Resultado

El servidor MCP remoto y el conjunto E2E están desplegados y operativos contra Staging. La campaña final de GitHub Actions pasó; además se hicieron pruebas reales de reparación aislada, delegación, recuperación tras desconexión, concurrencia idempotente y cancelación confirmada. El estado `finished` indica que terminó la ejecución; no aprueba cambios. Las ramas y PR creadas siguen sujetas a revisión humana.

El único destino configurado es `opencode-g1-staging`. Cloudflare muestra el Durable Object `OpenCodeAgent` de Staging en el namespace `0a43752314b24fe4a89327c7ecda787c`; el MCP enlaza ese mismo namespace y el Service Binding `STAGING_HEALTH` apunta a `opencode-g1-staging`. Producción conserva su namespace distinto (`401fd8de9521408cbe3d9205988dc952`) y `OPENCODE_SUPERVISOR_ENABLED=false`. No se enviaron operaciones del conector a Producción ni se modificaron sus recursos.

## Cambios y despliegue

- La rama de trabajo es `feat/remote-control-hardening-20261119`. Los cambios remotos están en `f727efd2bdc93a1f2d2219fcf4fc0731fa3a7a6b`; la corrección funcional principal del MCP está en `c935c13fb1b371cb56aafb44574032c006965ed6`.
- El MCP expone 21 herramientas, incluido descubrimiento y llamada a MCP ya configurados, sesiones aisladas por defecto, fork con workspace UUID y sesión exactos, continuación idempotente, progreso, cambio de modelo, cancelación verificada y revisión sin aprobación automática.
- El Worker MCP independiente usa OAuth de Cloudflare Access y bindings fijos a Staging. Su despliegue más reciente observado es `67eac2c3-fdbe-4a4a-860b-16662624a47a` (versión `996479ad-ae49-4dce-bb31-b9e9362ffc14`). El Worker de OpenCode Staging tiene el despliegue `e080f5e3-31ce-463c-9c23-3cc09d4f6a66` (versión `dcba9708-c0e4-4e13-b56c-abd6e5d64f40`).
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
| Desconexión y recuperación (experimento C) | Tarea `689a2d8d455e4c75`: tras dos reconexiones, el mismo `requestId` recuperó sesión, rama y operación; una continuación con `turnId` idempotente ejecutó otro comando. Estado `finished`, 3 llamadas completadas, sin duplicar operaciones. Transcript SHA-256 `69b60581125c12210176f1fde8930fac9689c115044c3d7e877710f3d78db09f`. |
| Concurrencia real | Dos solicitudes simultáneas con el mismo ID `f81d29a4c6570be3` devolvieron la misma rama, sesión y `operationId`; solo una fue aceptada y la otra reutilizó la reserva. OpenCode ejecutó `node -e "console.log('CONCURRENCY_OK')"` una vez, con `exitCode: 0`. |
| Cancelación real | La tarea `45fa73b6e1092c84` fue interrumpida por OpenCode: `confirmed=true`, `abortAccepted=true`, razón `interrupted`; el estado persistido pasó a `cancelled`. No quedó ejecutándose el comando largo solicitado para la prueba. |
| Catálogo MCP y recuperación de defectos | La campaña final terminó en GitHub Actions run `44443685925` (commit `f727efd…`). Artefacto JSON: [artifact 14493225781](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44443685925/artifacts/14493225781), ZIP SHA-256 `6bee483a8c2c320ccee53c067f1755567a2281204a68b77436612c4c07b9ce29`. Una ejecución anterior, `44442766787`, detectó el defecto de JSON inválido; la ejecución posterior pasó. |

## Matriz de aceptación

| Criterio | Estado | Alcance de la evidencia |
| --- | --- | --- |
| Conectividad, estado y descubrimiento MCP | PASS | 401/metadata OAuth, llamadas autorizadas de CI, 21 herramientas y health real de Staging. |
| Sesiones aisladas, recuperación, continuación y cancelación | PASS | Recuperación tras dos reconexiones, reintentos idempotentes y aborto confirmado. |
| Fork de una sesión existente | BLOCKED | El contrato exige UUID exacto del workspace y `ses...` de origen. No se proporcionó un par real para probar; el caso sin sesión de origen falla cerrado. |
| Modelos y ejecución Cloudflare | PASS | Catálogo y tareas reales con el preset económico de Cloudflare. El cambio de modelo de la UI se verificó con Playwright. |
| Inferencia OpenRouter | BLOCKED | Staging la reporta configurada, pero no se consumió crédito: Cloudflare bastó para las pruebas. No se afirma una inferencia OpenRouter reciente. |
| Descubrimiento de MCP existentes | PASS | El protocolo y la herramienta de descubrimiento funcionaron en E2E. |
| Ejecución E2E de una herramienta MCP dinámica | BLOCKED | La ruta y su allowlist/redacción están cubiertas por pruebas unitarias con servidor falso; no se seleccionó una herramienta real conectada para ejecutarla. |
| Archivos, Linux, pruebas y cambios GitHub | PASS | Reparación red-a-verde, comando Linux real, pruebas del repo, branch y PR borrador inspeccionados. |
| Delegación supervisada | PASS | OpenCode ejecutó trabajo real y entregó branch, transcript y revisión; quedan revisión humana y el registro de una llamada fallida. `finished` no equivale a aprobación. |
| Concurrencia | PASS | Se probó la carrera de dos llamadas duplicadas y se observó una sola operación. No se hizo una prueba de saturación de alta carga. |
| Diagnóstico de un fallo de OpenCode | PASS | Reparación red-a-verde aislada y health/diagnostics reales. No se indujo una caída del Worker de Staging. |
| Aislamiento de Producción | PASS | Binding MCP y namespace DO son de Staging; namespaces separados y flag supervisor de Producción desactivado. |
| Catálogo del plugin en esta conversación de ChatGPT | BLOCKED | El servidor remoto anuncia 21 herramientas, pero el catálogo de herramientas ya cargado en esta conversación sigue mostrando 8. La actualización de plugin 1.1.0 añadió la guía, pero no pudo refrescar el catálogo activo desde este hilo. |

## Límites y siguiente uso

- El MCP remoto es independiente de Playwright; el job MCP instala dependencias de producción y verifica que Playwright no está instalado. La UI E2E opera de forma determinista y no usa un agente para decidir clics.
- No se hizo una carga de concurrencia masiva ni una caída artificial del Worker; se evitó ampliar el impacto más allá de pruebas aisladas de Staging.
- La llamada dinámica MCP real y el fork explícito quedan sin prueba E2E por falta de una herramienta conectada seleccionada de forma segura y de un par workspace/sesión proporcionado, respectivamente.
- Para ver las 21 funciones desde ChatGPT, hay que abrir una conversación nueva o volver a cargar la conexión para que el cliente vuelva a descubrir el endpoint. Esta sesión conserva su catálogo antiguo aunque el Worker ya responda el nuevo.
- Las ramas y la PR borrador de la campaña no están aprobadas. Antes de incorporar cambios, revisar el diff y ejecutar el CI correspondiente; no fusionar ni desplegar esas ramas automáticamente.

# F0-OOM-02 — T01: auditoría de reconciliación GitHub ↔ Cloudflare

**Fecha del corte:** 2026-11-22 (lecturas de GitHub y Cloudflare en esta auditoría).  
**Estado del encargo:** \`PASS — AUDITORÍA DE LECTURA\`; **estado del hito F0-OOM-02:** \`BLOCKED / NO COMPLETE PASS\`.  
**Actor de auditoría y documentación:** ChatGPT, mediante conectores autorizados de GitHub y Cloudflare, **solo lecturas** del entorno y escritura documental separada.  
**Repositorio:** [aamvtrampa36-del/opencode-harness-example](https://github.com/aamvtrampa36-del/opencode-harness-example).  
**Índice:** [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90); identificador \`[F0-OOM-02/T01]\`.

> **Alcance y precaución temporal:** Los IDs y SHAs que siguen son un corte observado, no una afirmación permanente de actualidad. Otro desarrollo está publicando en los mismos Workers; volver a consultar GET de deployments, versions, PR y ramas antes de cualquier operación posterior. No se ejecutaron tests en runtime, despliegues, inferencia, cambios de configuración ni rollback durante T01.

## 1. Estado de código, ramas, PR y CI — GitHub (autoridad de código)

| Elemento | Evidencia verificada | Interpretación |
|---|---|---|
| Base de Staging | \`staging/opencode-g1-rpc-safe-20261120\` en SHA \`11161dd6f2c4b5237a2da59d7275ff693e0afdbe\` | Base de las dos PR de F0-OOM-02; **no** equivale a versión Cloudflare activa |
| \`main\` | SHA \`5527fce60775f02a94d5d2382b77e4eb4a9fd623\` | Solo lectura; no se modificó |
| [PR #106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106) | OPEN, DRAFT, no merged; HEAD \`19bba24d81be5b0673acbf2a56b500aed4fa0b66\`; 4 archivos | Corrección de aplicación **implementada como candidata**, todavía fuera de la rama Staging |
| [CI PR #106](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45028680557) | \`completed/success\`, HEAD exacto \`19bba24d…\` | Pruebas de CI, **no prueba de despliegue** |
| [PR #107](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/107) | OPEN, DRAFT, no merged; HEAD \`f0dc29a568390d97eee22eed4536e2ea2765f523\`; 1 archivo | Workflow de evidencia, explícitamente **sin deploy** |
| [CI general PR #107](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446380) | \`completed/success\`, intento 1, HEAD \`f0dc29a5…\` | CI de infraestructura |
| [CI de artefactos PR #107](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446357) | \`completed/success\`, intento 1, HEAD \`f0dc29a5…\` | Preparación de fuentes y binarios offline |
| [Issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) | OPEN; incluye evidencia de OOM histórico y reproducción ampliada | No debe cerrarse por F0-OOM-02 sin cubrir su alcance específico |

La PR #106 modifica \`src/server.ts\`, \`src/staging-control-mcp/server.ts\`, \`src/staging-control-mcp/server.test.ts\` y añade \`src/supervisor-transcript-containment.test.ts\`. Su fuente contiene el marcador \`SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED\`. La PR #107 añade \`.github/workflows/f0-oom02-staging-artifact.yml\` con \`SOURCE_SHA\` fijado a la PR #106.

### Artefactos GitHub Actions (vigencia consultada)

| Worker candidato | Artifact ID | Tamaño ZIP | Digest ZIP SHA-256 | Caducidad |
|---|---:|---:|---|---|
| \`opencode-g1-staging\` | \`14760462966\` | 24 168 777 B | \`707afab14232ea867eed4de187069f2514bbc8c4ceacce50a6a538a619d84a59\` | 2026-11-29 15:28:27 UTC |
| \`opencode-staging-control-mcp\` | \`14760378207\` | 782 092 B | \`4c268d686cb0bdb60ef790da20525e287627fcc1df128b511a1974e2cf41563d\` | 2026-11-29 15:28:31 UTC |

Ambos artefactos constaban como \`expired=false\` en la consulta GitHub. Auditorías previas verificaron los 543 archivos originales y 228 módulos precompilados del principal y el bundle independiente MCP, pero **T01 no repitió íntegramente esas verificaciones binarias**. El \`worker.js\` esperado del artefacto MCP tiene SHA-256 \`4b9323d8df60605132521bb0075045e7d75445f0dc898a8ec358ade5ce836a50\`. T02/T03 deben repetir la comparación con bytes exactos si hace falta.

## 2. Versiones y deployments — Cloudflare (autoridad de runtime)

**GET /deployments, /versions, /versions/{id}**, solo lectura. Porcentaje del primer deployment de la lista, que Cloudflare identifica como el último en servicio.

| Entorno | Versión activa | ID de versión | Deployment ID | Fecha del deployment (UTC) | Tráfico |
|---|---|---|---|---|---:|
| Principal Staging | **#374** | \`3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb\` | \`36ef84b3-0f99-4dd4-ab8e-c11ee450dd23\` | 2026-11-22 18:16:17 | 100 % |
| MCP Staging | **#19** | \`196240c0-1052-47b3-aaa7-02cf5baa87f0\` | \`9fdaf22d-beeb-44a0-ab68-77ecd5745fa1\` | 2026-11-22 18:17:59 | 100 % |
| Producción \`opencode-harness-example\` | **#42** | \`58056ee6-e795-4e9e-9a04-d0dab2056a4e\` | \`8bf7948c-c4aa-4059-bef8-0935a6275e52\` | 2026-11-20 22:03:35 | 100 % |

Las versiones anteriores del principal #371 (\`7e25ba19-4893-4e4f-a089-380ef8e01377\`) y MCP #17 (\`83a3eb1f-7f22-47d8-89a9-17208ed440bd\`) todavía se pueden leer por API; esto **no prueba** por sí solo que su rollback sea funcional o seguro.

### Cronología y origen de los deployments recientes

Se contrastó la correlación de **Cloudflare Workers Builds GET /builds/builds?version_ids=…**, que devuelve \`build_uuid\`, \`build_outcome\`, \`build_trigger_metadata.commit_hash\`, \`trigger.build_command\` y \`trigger.deploy_command\`:

| Worker/versión | Fecha UTC de deployment | Commit registrado como fuente | Cloudflare build UUID | Resultado |
|---|---|---|---|---|
| Principal #372 | 2026-11-22 17:38:05 | \`fb123432439abb5ecc7506f34e55447c804c0eca\` | \`df90f859-b235-4a29-8897-2b27e8cdbf88\` | \`success\` |
| Principal #373 | 2026-11-22 17:47:17 | \`ac43b45286c3034a5200d10ae197190763f2e415\` | \`4649ac41-b879-4d82-abd8-d8df66de2ff1\` | \`success\` |
| Principal #374 | 2026-11-22 18:16:17 | \`74632f75db010223cc90d99ba4a801ce0e6414e5\` | \`df8bbe2b-6964-4f59-86d9-3c2c706da3aa\` | \`success\` |
| MCP #18 | 2026-11-22 17:39:23 | \`fb123432439abb5ecc7506f34e55447c804c0eca\` | \`30732c51-3851-4634-a73b-d5db64544c26\` | \`success\` |
| MCP #19 | 2026-11-22 18:17:59 | \`74632f75db010223cc90d99ba4a801ce0e6414e5\` | \`3ca29528-f99b-4865-a4a5-972b8a18d892\` | \`success\` |

Para ambos Workers, la metadata indica \`build_trigger_source=manual\`, las fuentes registradas están en la rama GitHub \`opencode/staging-c0de5a1260a11f01\`, y los deployments aparecen como \`source=wrangler\`. El build del principal configura \`cp wrangler.g1.jsonc wrangler.jsonc && bun run build\` seguido de \`bunx wrangler deploy\`; el MCP usa \`bunx wrangler deploy --dry-run --config wrangler.mcp-staging.jsonc\` durante build seguido de \`bunx wrangler deploy --config wrangler.mcp-staging.jsonc\`. **Son reconstrucciones de otro commit**, no la promoción de los ZIP de F0-OOM-02.

**Alcance de la atribución:** Cloudflare registra una cuenta/autorización y el origen manual, pero no demuestra qué agente, usuario interactivo o conversación inició cada acción. No adjudicarla a ChatGPT, OpenCode Prod o Stage sin evidencia independiente.

En GitHub, la rama \`opencode/staging-c0de5a1260a11f01\` tenía HEAD \`6b1ff55267e9e7941ea788e987bdeff503525337\`, posterior al \`74632f75…\` desplegado, con CI de validación \`success\` en la [run 45054554609](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45054554609). Sus commits recientes tratan \`read_only\`, importación de repositorios y verificación de árbol/SHA; son **otro frente de trabajo**. Esa rama había tenido también CI fallidos/cancelados durante iteraciones, por lo que solo la CI del SHA final correspondiente debe usarse como evidencia específica.

## 3. Comparación de fuente y límites de la prueba binaria

- La fuente en GitHub \`src/server.ts\` y \`src/staging-control-mcp/server.ts\` del commit desplegado \`74632f75…\` **no** contiene \`SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED\`; la fuente de PR #106 **sí** lo contiene.
- El contenido activo devuelto por Cloudflare \`GET /workers/scripts/{script}/content/v2\` en principal #374 y MCP #19 tampoco contenía ese marcador en el material consultado.
- La extracción de \`worker.js\` del **multipart textual devuelto por el conector** para MCP #19 produjo SHA-256 \`352164f1fc328109234f39be94cb8ba8b4f4d8d3f254240adb488b8e6919e616\`, distinto del hash esperado del artefacto #14760378207 (\`4b9323d8…\`). Para una certificación de identidad exacta usar descarga de bytes crudos con validación de encuadre multipart en T03.
- El principal activo presenta 228 módulos JS y una configuración que conserva la estructura general, pero el simple conteo de módulos no demuestra que coincidan con los del artefacto candidato.
- **Conclusión:** no está acreditado que los binarios verificados F0-OOM-02 estén desplegados; no declarar \`COMPLETE PASS\`. La ausencia del marcador es una señal firme de que no se publicaron esos candidatos exactos, pero no demuestra por sí sola que no exista alguna protección equivalente en otro código.

## 4. Invariantes de infraestructura observadas

Principal #374: \`compatibility_date=2026-06-11\`; flags \`nodejs_compat\` y \`durable_object_io_tasks_prevent_eviction\`; \`migration_tag=v4\`; assets SPA y \`run_worker_first\` para rutas de API/supervisor; contenedor \`DevContainer\`; bindings \`OpenCodeAgent\`, \`DEV\`, \`SETTINGS\`, \`SESSION_BK\`, \`RECOVERY_R2\`, \`SUPERVISOR_WORKFLOW\`, \`AI\`, \`LOADER\`, variables de Staging.

MCP #19: \`compatibility_date=2026-11-17\`, flag \`nodejs_compat\`, binding \`STAGING_HEALTH\` al servicio \`opencode-g1-staging\` y \`STAGING_SUPERVISOR\` a \`OpenCodeAgent\` en \`opencode-g1-staging\`. El MCP no tiene assets propios. T05 deberá comprobar las invariantes exactas de migraciones, credenciales, assets y rutas sin alterar recursos.

## 5. Riesgo crítico agregado: reproducciones de OOM y trabajo concurrente

[Issue #90, comentario 7083567558](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558), publicado el 2026-11-22 18:23:34 UTC, registra **un experimento previo, no repetido por T01**, con diez solicitudes \`staging_start_task\` distintas. Reporta:

- **0/10 trabajos** con ejecución y validación completas.
- **6** errores de memoria durante llamadas de inicio, pese a que algunas tareas persistieron parcialmente.
- **4** tareas terminadas \`failed\`, **2** registros \`unknown/not_found\` cuya cancelación no quedó confirmada, **4** solicitudes \`preparing\` canceladas con confirmación antes de iniciar sesión.
- Reinicios/reanudaciones y posible riesgo de referencias huérfanas; **no se comprobó** diez sesiones ejecutándose simultáneamente.
- La causa raíz exacta sigue **desconocida**. No atribuir el OOM de inicio exclusivamente a F0-OOM-02 ni viceversa.

Ese experimento informa una condición de estabilidad importante para cualquier promoción, pero es un problema de alcance más amplio que la contención de lecturas de transcript. El comentario documenta pruebas con inferencia ya realizadas por otro actor; **T01 no usó inferencia, no ejecutó OpenCode Remote y no consultó sesiones privadas**.

Los comentarios previos de [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) documentan también bounded \`supervisedTaskStatus\` en PR #91, una RPC \`remoteSupervisorSessions\` con \`exceededMemory\` tras esa corrección, y validaciones parciales de índice supervisado en PR #94. Son evidencias históricas, no un root cause demostrado para el nuevo lote.

## 6. Matriz de estado / gate

| Área | Estado | Base de evidencia |
|---|---|---|
| Corrección F0-OOM-02 en código candidato | **IMPLEMENTADO (PR)** | PR #106, cuatro archivos, hash fuente fijo |
| Pruebas automatizadas de candidato | **CI PASS / OFFLINE PASS** | Actions #45028680557, #45038446380, #45038446357; artefactos |
| Publicación real de F0-OOM-02 | **NO DEMOSTRADA / BLOQUEADA** | Active #374/#19 proceden del commit distinto \`74632f75…\` |
| Validación en runtime de F0-OOM-02 | **NO PROBADA** | T01 no ejecutó E2E y source activo difiere |
| Bindings básicos Stage | **CONFIGURADOS** | GET Cloudflare versions #374/#19 |
| Estabilidad del supervisor multi-tarea | **FAIL documentado en experimento independiente** | Issue #90 comment 7083567558; causa no demostrada |
| Recuperación / rollback | **VERSIONES ANTERIORES CONSULTABLES; NO EJERCITADO** | GET versions #371 y #17 |
| Producción | **SIN CAMBIO OBSERVADO** | Worker Prod #42, deployment \`8bf7948c…\` |
| Documentación canónica del proyecto | **CORTE PREVIO DESACTUALIZADO** | Adjunto \`00_ESTADO_Y_FUENTES.md\` corresponde al 19-11; debe preservarse como historia |
| \`docs/f0-oom-02/recovery/01-auditoria.md\` | **Documento de esta entrega T01** | Rama/PR documental y comentario índice #90 |

\`CONOCIMIENTO_UNIFICADO.md\` y \`00_ESTADO_Y_FUENTES.md\` **no aparecieron en la raíz de la rama Staging consultada**. Existen archivos aportados al Proyecto con cortes históricos, pero no se asume que sean archivos versionados en GitHub. Esta auditoría se publica como nueva evidencia, sin sobrescribirlos.

## 7. Ruta mínima y dependencias para T02–T10

1. **T02/T03 (paralelos, lectura):** comparar los bytes de principal/MCP activos contra artefactos y código fuente de PR #106, con manifiestos exactos. No iniciar builds.
2. **T04 (paralelo, revisión/CI controlada):** resolver transferencia autenticada ZIP GitHub→Cloudflare. Una prueba previa dio HTTP 403 en el entorno Cloudflare; no insistir con la misma URL/host sin cambio de método. Usar CI con digest validado solo si existen credenciales y permiso explícito; evitar reconstrucción silenciosa.
3. **T05 (paralelo, lectura):** validar compatibilidad assets, bindings, DO, R2, Workflows, Containers y rollback.
4. **T06 (después de T02–T05, aprobación específica):** crear hasta dos versiones inactivas *solo si* hashes, fuente, infraestructura y costo están verificados. Antes de cualquier escritura confirmar que los Workers no están recibiendo deploys ajenos.
5. **T07 (después de T06, aprobación específica):** promoción coordinada y comprobación de IDs activos. No mezclar ejecuciones concurrentes ni desplazar versiones recientes sin reconciliar.
6. **T08/T09 (después de T07):** pruebas reales seguras de contención y estabilidad, con actor, requests, HTTP/exit codes y telemetría acotada. No reproducir el experimento de diez inferencias sin nuevo lote autorizado.
7. **T10:** consolidar la documentación del proyecto y emitir \`COMPLETE PASS — F0-OOM-02 STAGING\` solo con código binariamente trazado, runtime PASS, ausencia de regresiones importantes y recuperación documentada. **No cerrar automáticamente issue #90 ni toda Fase 0.**

**Condición de parada transversal:** nuevo deployment/HEAD no conciliado, integridad binaria incompleta, falta de permisos, presupuesto no controlado o riesgo de pérdida de estado. No ejecutar POST/PUT Cloudflare para 'probar' permisos ni repetir operaciones inciertas. T01 preserva únicamente pruebas de lectura, no autoriza T02–T10.

## 8. Referencias y autoría de fuentes

- Código/PR/CI: [PR #106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106), [PR #107](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/107), [Actions 45028680557](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45028680557), [45038446380](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446380), [45038446357](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446357), [GitHub branch commit 74632f75](https://github.com/aamvtrampa36-del/opencode-harness-example/commit/74632f75db010223cc90d99ba4a801ce0e6414e5).
- Incidente y reproducciones: [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90); [reproducción ampliada](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558).
- Deployments/versions, build→SHA, bindings, contenidos: Cloudflare API GET de los dos Workers; IDs y build UUID documentados arriba (enlace de consola no inventado).
- Documentación adjunta del Proyecto: \`00_ESTADO_Y_FUENTES.md\` (19-11-2026) y \`03_OPERACION_Y_PERMISOS.md\`, utilizados únicamente para criterios de autoridad y permisos, no como estado live 22-11.
- No atribuir a T01 despliegues, builds, pruebas realizadas por otros procesos, ni ensayos que solo estén registrados históricamente en issue/CI.

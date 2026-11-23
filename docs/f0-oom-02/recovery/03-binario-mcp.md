# F0-OOM-02/T03 — Reconciliación del Worker MCP

**Fecha de auditoría:** 2026-11-22. **Actor:** ChatGPT; lecturas autorizadas GitHub/Cloudflare y análisis local de artefacto. **Entorno:** Staging. **Estado de la auditoría T03:** **PASS (procedencia y defecto de protección demostrados)**. **Estado de la entrega F0-OOM-02:** **BLOCKED / NO COMPLETE PASS**. **Tipo de documento:** auditoría técnica T03, preparada tras lecturas autorizadas y destinada a publicación exclusivamente documental mediante autorización de escritura GitHub separada.

## 1. Referencias y límites

- Repositorio: https://github.com/aamvtrampa36-del/opencode-harness-example
- Issue #90, referencia `[F0-OOM-02/T01]`: https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083647199
- Informe T01: https://github.com/aamvtrampa36-del/opencode-harness-example/blob/docs/f0-oom02-recovery-t01-20261122/docs/f0-oom-02/recovery/01-auditoria.md
- PR #106 (OPEN/DRAFT, no integrada): https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106 ; HEAD `19bba24d81be5b0673acbf2a56b500aed4fa0b66`; base `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`.
- Preparación de artefactos: GitHub Actions run https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446357 (`success`, attempt 1), ejecutada desde rama de evidencias con HEAD **distinto**, `f0dc29a568390d97eee22eed4536e2ea2765f523`. El job confirmó paso “Checkout exact candidate commit, never the PR merge ref”; el manifiesto del artefacto declara `sourceSha=19bba24d…`. La identidad del run no debe confundirse con la identidad del código compilado.
- CI de aplicación de la PR #106: https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45028680557 ; `completed/success` sobre el SHA candidato, con pasos `Unit tests`, `Typecheck`, `Build both Worker and web client` e invariantes `success`. No es un test de ejecución del candidato en Cloudflare.
- **Fuera del alcance operativo:** despliegues, merge, Access, inferencia, herramientas MCP con efectos y lecturas históricas completas de sesiones. Las únicas escrituras permitidas son rama/archivo/PR draft/comentario documental en GitHub.

## 2. Estado Cloudflare revalidado

**Worker:** `opencode-staging-control-mcp`.

| Dato | Evidencia de GET Cloudflare |
|---|---|
| Actual | versión **#19** `196240c0-1052-47b3-aaa7-02cf5baa87f0`, 100 % |
| Deployment actual | `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, `2026-11-22T18:17:59Z` |
| Anterior referenciado | versión **#18** `2afcceff-e54d-465f-8afa-c1916c28761c`, 100 % en su deployment histórico `7e70d0a0-ee4d-4bc3-9cb6-1ca6028e5187` (`17:39:23Z`); **ya no activo** |
| Versión MCP actual | `source=wrangler`, `compatibility_date=2026-11-17`, `nodejs_compat`, `MCP_ENABLED=true` |
| `STAGING_HEALTH` | `type=service`, `service=opencode-g1-staging`, `environment=production` (campo de entorno Cloudflare del servicio de destino; **no** es el Worker OpenCode Producción) |
| `STAGING_SUPERVISOR` | Durable Object `OpenCodeAgent`, `script_name=opencode-g1-staging`, namespace `0a43752314b24fe4a89327c7ecda787c` |
| Worker principal revalidado | `opencode-g1-staging` versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` al 100 %; deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23` a las `18:16:17Z` |

La fuente Cloudflare Workers Builds, analizada y documentada en T01, atribuye MCP #19 y principal #374 al commit `74632f75db010223cc90d99ba4a801ce0e6414e5`; build MCP `3ca29528-f99b-4865-a4a5-972b8a18d892`, con `bunx wrangler deploy --config wrangler.mcp-staging.jsonc`. Se trata de un **rebuild y deployment de otro commit** realizado por una operación externa a esta auditoría, no de la promoción del artifact `14760378207`. Esta atribución identifica fuente técnica registrada, **no demuestra identidad del operador humano/agente**.

## 3. Artefacto candidato: descarga e integridad

Se ejecutó `download_workflow_artifact` para `14760378207`, se recibió el ZIP y se verificaron ZIP, `SHA256SUMS` y todos los cuatro archivos de inventario. GitHub Actions listó el artifact en el run `45038446357`, `expired=false`, nombre `f0-oom02-mcp-19bba24d81be5b0673acbf2a56b500aed4fa0b66`, y digest oficial `sha256:4c268d…`, igual al cálculo local.

| Elemento | Bytes | SHA-256 comprobado |
|---|---:|---|
| ZIP GitHub | 782,092 | `4c268d686cb0bdb60ef790da20525e287627fcc1df128b511a1974e2cf41563d` |
| `payload.tar.gz` | 780,700 | `ce2e9befb78020261836c53d9781041d2b616d90a15cb3daa5580577d375c5b9` |
| `manifest.json` | 1,575 | `4a59d0ee1ce0570efcd00446d346a2a3377b0d4b0278bddab3b9af99d4dcf4e0` |
| `.f0-oom02/mcp-dry-run/worker.js` | 1,286,914 | `4b9323d8df60605132521bb0075045e7d75445f0dc898a8ec358ade5ce836a50` |
| `.f0-oom02/mcp-dry-run/worker.js.map` | 2,865,898 | `12f01472a5ef8e88c9b7d43ae1a4df50a95a8577cb9c0884b0b8ea4729a9df03` |
| `wrangler.mcp-staging.jsonc` | 667 | `31907fc438748600c198eaef9d85d204838f63e47a0134bc0dfe8f1559878e54` |
| README `mcp-dry-run` | 129 | `f7723c44d9d1f5af9899af0a03cfdaaa5e4ec7e5cd713a295cf72a4496166146` |

El manifiesto declara esquema `f0-oom02-mcp-evidence-v1`, fuente candidata `19bba24d…`, `workerName=opencode-staging-control-mcp`, `sourceEntrypoint=src/staging-control-mcp/worker.ts`, `sourcePreparedBy="wrangler deploy --dry-run"` y **`directlyDeployable=false`**. No usar el tarball como si fuera una carga preconstruida íntegramente certificada por Cloudflare. La configuración coincide semánticamente con los bindings activos, pero **no el código**.

## 4. Bundle activo frente al candidato

Se consultó `GET /accounts/{account_id}/workers/scripts/opencode-staging-control-mcp/content/v2`, se analizaron las partes multipart `worker.js` y `worker.js.map` y se computaron SHA-256 sobre **texto decodificado y re-codificado UTF-8**. Los bytes crudos originales de la respuesta HTTP no están disponibles para comparación forense directa mediante esta interfaz; no convertir estos hashes en certificación de identidad de bytes de transporte.

| Elemento | Candidato verificado (binario local) | Activo recuperado por Cloudflare (UTF-8 multipart) | Diferencia |
|---|---:|---:|---|
| `worker.js` | 1,286,914 bytes, `4b9323d8…` | 1,294,909 bytes, `352164f1fc328109234f39be94cb8ba8b4f4d8d3f254240adb488b8e6919e616` | +7,995 bytes en activo; hashes distintos |
| `worker.js.map` | 2,865,898 bytes, `12f01472…` | 2,833,249 bytes, `747500187f06248b60571b4fb9940a1c1bc49d81df52f1d051edc57ef774f203` | -32,649 bytes en activo; hashes distintos |
| Marcador `SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED` | presente en bundle y sourcemap | ausente en bundle y sourcemap | diferencia de implementación |

**Prueba de procedencia de código más fuerte que los hashes:** el sourcemap publicado contiene `sourcesContent` para `src/staging-control-mcp/server.ts` y `src/staging-control-mcp/worker.ts`. Del `sourcesContent` del `server.ts` activo se reconstruyó el Git blob SHA-1 con el prefijo `blob <bytes>\0`; resultado **`c815e27f6a2008cba502b7f6834bd4f7f1db544d`**, igual al blob que GitHub devuelve para `src/staging-control-mcp/server.ts` en `74632f75…`. El blob de la fuente candidata PR #106 es **`af077796eb7c3a76ad6ae4e08523b856a4eaeac4`**. Además, el fragmento ejecutable de `worker.js` publicado coincide con la lógica anterior descrita a continuación. **La diferencia no es solo minificación, sourcemap o orden de módulos: hay una rama funcional distinta.**

Límite: sourcemap reconstruye procedencia de esa fuente y los fragmentos ejecutables inspeccionados; no es certificación criptográfica de *todas* las dependencias del bundle activo ni de los bytes crudos HTTP.

## 5. Protección real del transcript y rutas de riesgo

**MCP publicado (#19, código originado en `74632f75…`):**

1. `staging_task_transcript` llama primero a `bindings.supervisor(...).supervisedTaskStatus(id)`.
2. Después invoca `supervisedTaskTranscript(id)` y hace `JSON.parse(raw)`.
3. Solo **después de recibir la transcripción entera** usa `messages.slice(-20)`, `renderConversationMarkdown(...)` y limita a 20,000 caracteres la respuesta textual.
4. El `supervisedTaskTranscript` del origen GitHub `74632f75…` llama a `exportSessionData(session)`, que lista sesiones y ejecuta `this.harness.session(sessionID).history()` sin un límite de bytes anterior a esa lectura.

Fuentes GitHub:
- MCP antiguo: https://github.com/aamvtrampa36-del/opencode-harness-example/blob/74632f75db010223cc90d99ba4a801ce0e6414e5/src/staging-control-mcp/server.ts
- Ruta principal antigua: https://github.com/aamvtrampa36-del/opencode-harness-example/blob/74632f75db010223cc90d99ba4a801ce0e6414e5/src/server.ts#L610-L615
- Export de historial antiguo: https://github.com/aamvtrampa36-del/opencode-harness-example/blob/74632f75db010223cc90d99ba4a801ce0e6414e5/src/server.ts#L685-L695

**Conclusión:** el recorte de salida no es un límite de memoria de entrada. El riesgo de materialización del transcript permanece en el flujo publicado. La observación histórica de OOM en `supervisedTaskTranscript`, recogida en PR #106/issue #90, eleva el riesgo de disponibilidad; **no** demuestra por sí sola la causa única de todos los OOM concurrentes, ni un incidente nuevo causado por esta auditoría.

**PR #106 (candidato verificado estáticamente):**

- `src/staging-control-mcp/server.ts` L375–378: `staging_task_transcript` retorna `failed(Error("SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED"))` **sin llamar a `supervisedTaskStatus` ni a la sesión**. `failed` incluye `isError: true` (L137–140).
- `src/server.ts` L580–586: `supervisedTaskTranscript` valida Staging y existencia de tarea/sesión, **después rechaza antes de cualquier `history()`**.
- `src/server.ts` L311–316: `remoteSupervisorInspectSession` rechaza tras comprobar identidad, **antes de enumeración/historial**.
- `src/server.ts` L393–411: `remoteSupervisorInspect` devuelve snapshot del ledger, sin `wait()` ni `history()`, con `snapshot=true`, `transcriptAvailable=false`, y `passed=false`, `verified=false`.
- `src/server.ts` L454–519: `supervisedTaskStatus` usa métricas de log por cursor con máximo de 256 eventos por sondeo; en fallo métricas desconocidas/no completas y retorna **`passed:false`, `verified:false`**, nunca verdad inferida. La llamada `wait()` y la ruta de continuación permanecen fuera de este arreglo.
- `src/server.ts` L1531–1537: endpoint supervisor `GET /tasks/{id}/transcript` hace `await host.supervisedTaskTranscript(...)` **antes** de `supervisedTaskStatus`, por lo que el error bloquea esta ruta específica.
- **Excepción explícita:** `GET /api/session/export` continúa usando `exportSessionData`, que materializa historial completo. PR #106 **no** elimina todas las rutas potencialmente ilimitadas ni resuelve concurrencia/OOM sistémica.

Fuentes candidatas:
- https://github.com/aamvtrampa36-del/opencode-harness-example/blob/19bba24d81be5b0673acbf2a56b500aed4fa0b66/src/staging-control-mcp/server.ts#L375-L378
- https://github.com/aamvtrampa36-del/opencode-harness-example/blob/19bba24d81be5b0673acbf2a56b500aed4fa0b66/src/server.ts#L311-L316
- https://github.com/aamvtrampa36-del/opencode-harness-example/blob/19bba24d81be5b0673acbf2a56b500aed4fa0b66/src/server.ts#L393-L411
- https://github.com/aamvtrampa36-del/opencode-harness-example/blob/19bba24d81be5b0673acbf2a56b500aed4fa0b66/src/server.ts#L580-L586

## 6. Pruebas, PASS y límites de verificación

- `src/staging-control-mcp/server.test.ts` L299–309 comprueba que `staging_task_transcript` retorna `isError=true`, marcador esperado, no filtra token simulado, no llama `transcript` ni vuelve a invocar `status`.
- `src/supervisor-transcript-containment.test.ts` L42–83 comprueba con mocks que transcript e inspector abortan sin `history()` ni `wait()`, que el snapshot presenta `passed=false`, `verified=false`, y que siguen las validaciones de identidad y habilitación.
- PR #106 CI `45028680557` muestra `Unit tests`, preview estático, typecheck, build, invariantes con `conclusion=success`; la preparación del MCP en CI `45038446357` también `success`. **No hubo ejecución autenticada de esas rutas en el candidato desplegado**, pues el candidato **no está desplegado**.
- En el código actual GitHub `74632f75…`, `supervisedTaskStatus` devuelve `passed=false` y `verified=false` incluso si `toolCountsComplete=false`; el MCP activo no introduce explícitamente `passed:true` ni `verified:true` en el flujo transcript. La ruta incompleta **no se convierte en PASS** en los caminos examinados. No afirmar una auditoría universal de todos los handlers ni una prueba live de este comportamiento.

**Certificación pendiente mínima, bajo un lote operativo distinto autorizado:**

1. T02 y T04/T05 deben reconciliar el **principal y el MCP como pareja** y demostrar identidad de bytes originales/digests del transporte y compatibilidad de bindings; ningún deploy mientras haya fuentes concurrentes sin conciliar.
2. Al preparar versiones **inactivas** en un lote futuro, verificar `worker.js`, sourcemap y config efectivos; comparar rutas y `get_version`/bindings sin activar nada.
3. Prueba E2E autenticada del candidato (solo con permiso específico) sobre una tarea sintética mínima: consultar `staging_task_transcript` y confirmar error cerrado **sin lectura de historial y sin OOM** mediante trazas acotadas; probar `staging_session_inspect` y el endpoint supervisor.
4. Probar estatus con cursor incompleto/error de métricas: `toolCountsComplete=false`, contadores nulos/desconocidos, `passed=false`, `verified=false`; sin historiales completos.
5. Telemetría acotada de OOM/CPU/memoria bajo carga comparativa y recuperación de referencias, sin usar inferencia ni cargas concurrentes en esta auditoría. Mantener issue #90 abierta.

## 7. Decisión técnica

**Decisión:** `REQUIERE SUSTITUCIÓN COORDINADA, NO REPARACIÓN IN SITU NI VALIDACIÓN ADICIONAL SOLAMENTE`.

El MCP publicado #19 es de fuente distinta y contiene el camino que consulta historial completo antes de recortar. La PR #106 aporta un bloqueo de esa ruta **en código candidato con CI verde**, pero el binario está fuera de runtime. La sustitución debe planificarse **junto con** la versión adecuada del Worker principal, la compatibilidad de T05, el método de traslado de bytes de T04 y las pruebas/reversión exigidas. **No desplegar ahora** ni sustituir solo un Worker sin gate de compatibilidad. Una mitigación operativa temporal prudente es evitar invocar `staging_task_transcript` y `staging_session_inspect` en el MCP actual; esa recomendación no se ha aplicado como control técnico.

**Severidad:** alta para la **disponibilidad de Staging** por ruta de materialización completa que coincide con un riesgo OOM ya registrado. No hay prueba aquí de lectura de secretos, escalada de permisos, afectación de Producción ni causalidad total de los diez fallos concurrentes.

**Resultado por ámbito:** auditoría de procedencia/implementación **PASS**; despliegue de protección **NO**; E2E de protección **NO VERIFICADO**; recuperación global OOM **NO COMPLETE PASS**.

## 8. Registro y límites de publicación

La publicación de este informe en `docs/f0-oom-02/recovery/03-binario-mcp.md`, una rama documental independiente, una PR **draft** y la referencia `[F0-OOM-02/T03]` en issue #90 fueron autorizadas explícitamente **después** de la auditoría de solo lectura. La publicación del informe no significa que el código se haya integrado, que haya pruebas E2E nuevas ni que el defecto esté reparado en Cloudflare. Para cualquier cambio operativo posterior hace falta un lote autorizado distinto.
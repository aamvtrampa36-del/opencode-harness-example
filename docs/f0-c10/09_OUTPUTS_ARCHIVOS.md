# F0-C10/T09 — Resultados independientes y descargas verificables

**Corte de consulta:** 2026-11-22 (America/Sao_Paulo). **Veredicto:** `PARTIAL` (suite offline PASS; entrega real por tarea en Staging NO demostrada). **Actor:** ChatGPT, lectura de GitHub/Cloudflare/OpenCode Remote y fixtures locales Node; **no** ejecutó nueva tarea de inferencia ni desplegó.

## 1. Fuentes, refs y límites del entorno

- Plan focal `F0_C10_PLAN_INTEGRAL.md`, secciones 1, 15–20: diez tareas verdaderamente activas, diez resultados recuperables, hash/tamaño y verificación real; una ruta `/bundle` no es descarga. Issue [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) sigue abierta por OOM/recovery y **0/10 completados** en el ensayo histórico de diez solicitudes (no es una prueba actual).
- Repo [`aamvtrampa36-del/opencode-harness-example`](https://github.com/aamvtrampa36-del/opencode-harness-example). HEAD de rama de análisis `staging/opencode-g1-rpc-safe-20261120`: `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`; `main`: `5527fce60775f02a94d5d2382b77e4eb4a9fd623` (GitHub GET). No confundir ese HEAD con el binario publicado.
- Cloudflare GET de deployments: principal `opencode-g1-staging` deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` al 100%; MCP `opencode-staging-control-mcp` deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, versión `196240c0-1052-47b3-aaa7-02cf5baa87f0` al 100%. GitHub #90 T02/T03 atribuye fuente publicada a `74632f75...`, distinta del HEAD de Staging. Estas versiones **no contienen** este fixture ni un nuevo endpoint de descargas por tarea.
- `staging_status` remoto respondió `status=ok`, supervisor `ready=true`, `schema=opencode.staging-control.v2` y catálogo default `economy`; `staging_diagnostics` devolvió ledger con incidentes. **No hubo `staging_start_task` ni otra ejecución pagada**: presupuesto/corte efectivo de una tarea no estaban comprobados y no se autoriza gastar sin esa reserva.
- [PR #100](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/100) `merged` en Staging: visualización de partes `file`; [PR #102](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/102) `merged`: correlación de incidentes `taskId == requestId`; [PR #105](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/105) `draft/open` a main aunque el cambio de stdout/stderr ya fue integrado en Staging. El límite de stdout de Linux **no equivale** a entrega duradera de un archivo.

## 2. Contrato real observado y rutas de salida

**Cliente web ordinario (código en rama indicada):** `src/protocol.ts` define `SessionSnapshot.messages` (historial de `OpenCodeMessage`), mensajes WebSocket `snapshot`, `event`, `result` y `error`. `src/sockets.ts` obtiene `handle.history()` para construir snapshots. `src/client.tsx` renderiza `ToolCard` y llama `ToolFileAttachments` solamente para `part.state.content` de herramientas **completadas**. `src/tool-file-attachment.ts` interpreta `type:"file"`, `uri`, `mime`, `name?`; admite inline `data:` de MIME allowlist, `blob:` y `https:`; para HTTPS crea un enlace **Abrir**, no asegura descarga. Rechaza `file:`, http, rutas relativas, HTML/SVG inline y texto que simplemente mencione un path. No comprueba un GET, tamaño, checksum ni afiliación a tarea antes de mostrar enlaces externos. `blob:` enviado desde contexto distinto puede no resolverse en el navegador receptor; no es referencia durable.

**Descarga por proyecto (mecanismo diferente):** `src/client.tsx` usa `/api/dev/download/{project}` para tar.gz de Container o ZIP de GitHub. `src/server.ts` valida identidad de proyecto/repo en la ruta GitHub; `src/download-response.ts` reenvía `upstream.body` como stream con `Content-Disposition: attachment`, `nosniff`, `no-store` y rechazo de respuestas upstream fallidas. Esta ruta puede ser útil para exportación explícita de un proyecto, **pero no tiene contrato taskId→archivo individual ni prueba de SHA-256 por archivo**. Tampoco convierte automáticamente la ruta del Container `/bundle/reporte.txt` en un objeto descargable.

**Supervisor/MCP:** `src/supervisor-control.ts` impone `requestId` hexadecimal de 16 caracteres, proyecto determinista `supervised-{id}` y rama de tarea. `src/server.ts::supervisedTaskStatus` devuelve `id`, `session`, `operationId`, `project`, `branch`, estado, métricas y `passed:false`, `verified:false`; **no devuelve una lista de bytes/archivos**. `remoteSupervisorProgress` entrega hasta 100 eventos por consulta con `nextAfter` y `truncated`. `src/staging-control-mcp/server.ts` serializa JSON como parte MCP `type:"text"` y expone `staging_task_status`, `staging_task_progress`, `staging_task_transcript` (vista textual de hasta 20 mensajes y recorte de caracteres). La ruta de transcript del Worker y `exportSessionData().history()` pueden materializar historial completo en la versión actual; **no usar transcript como transporte binario**. La protección candidata de #106 no está certificada como desplegada.

### Distinciones que deben conservarse

| Tipo | Qué demuestra | ¿Permite anunciar «Descargar»? |
|---|---|---|
| Texto simple `"guardado /bundle/x.txt"` | Afirmación del modelo, sin prueba de fichero | **No** |
| JSON/MCP `content:[{type:"text",text:"{...}"}]` | Respuesta serializada/truncable | **No** |
| Tool output stdout/stderr | Salida de comando, posiblemente recortada | **No**; puede referenciar un artefacto separado |
| Ruta interna `/tmp`, `/bundle`, `file:` | Ubicación en Container, inaccesible al navegador | **No** |
| Parte OpenCode `file` con `data:` válido | Bytes embebidos en la sesión y tipo seguro | **Sí, condicional**; comprobar tamaño/hash y límites de memoria |
| Parte `file` con `https:` | Referencia externa, quizás expirada/denegada | **No automáticamente**; hoy solo se presenta como Abrir |
| `blob:` | Identificador local de navegador/contexto | **No como persistencia entre dispositivos** |
| GET autenticado por tarea + manifiesto persistido | Ruta autorizada, bytes y huella verificables | **Sí, tras prueba de integridad y acceso** |
| Artefacto GitHub CI/R2 | Referencia externa con permisos/expiración propios | **Solo** con identidad, acceso y conservación verificados |

## 3. Contrato propuesto `opencode.task-output.v1` (NO IMPLEMENTADO EN BACKEND)

Una proyección **por solicitud**, no un volcado de transcript. Ejemplo semántico con identificadores ilustrativos, **no URL existente**:

```json
{
  "schema": "opencode.task-output.v1",
  "requestId": "0000000000000064",
  "status": "finished",
  "passed": false,
  "verified": false,
  "reviewRequired": true,
  "summary": { "text": "Resultado producido; revisión pendiente", "truncated": false },
  "artifacts": [{
    "requestId": "0000000000000064",
    "artifactId": "file_00000064",
    "name": "reporte.txt",
    "mime": "text/plain",
    "byteSize": 128,
    "sha256": "<64 dígitos SHA-256 obtenidos de bytes reales>",
    "delivery": {
      "kind": "authenticated-route",
      "path": "/api/tasks/{requestId}/artifacts/{artifactId}",
      "expiresAt": 1795380000000
    }
  }],
  "errors": [],
  "evidence": { "operationId": "<ID real cuando exista>", "sourceSha": "<SHA cuando aplique>" }
}
```

Los valores entre `<>` y `{}` son **marcadores de esquema, no un registro validable ni enlace publicado**. El módulo de prueba genera rutas específicas y digests auténticos calculados de buffers.

**Invariantes propuestas**: (a) el `requestId` de la parte, su registro persistente y la ruta deben ser iguales; (b) el artefacto se registra únicamente tras hacer readback de bytes y hash de la fuente permitida; (c) `finished` no transforma `passed/verified` en verdadero; (d) `error`, `cancelled`, `unknown`, `not_found`, `partial` o truncamiento explícito impiden mostrar un resultado final ficticio; (e) en actualización/reintento, un mismo `(requestId, artifactId)` no se asocia a contenido distinto: elegir identificador de artefacto nuevo o respuesta de conflicto; (f) ningún resultado de una tarea incluye los de otra aunque terminen en distinto orden; (g) `errors[]` solo contiene `{code,message,retryable}` sanitizados, sin comandos, secretos, rutas confidenciales ni transcript interno.

**Datos durables requeridos**: `owner/workspace`, `requestId`, `session`, `operationId`, `artifactId`, fuente fija bajo root permitido, nombre canónico, tipo, bytes, hash, `createdAt`, `expiresAt`, estado/errores; referencias almacenadas por tarea y protegidas por ACL server-side. No almacenar blobs grandes ni toda la transcripción en DO por defecto. Si se necesita persistencia tras destruir Container, un objeto aislado por tarea en almacenamiento aprobado es opción posterior, **no autoriza escribir buckets compartidos**. Alternativa de menor cambio para piloto: endpoint Worker autenticado que valida tarea/propiedad, lee solo archivos permitidos del Container todavía disponible y transmite el stream; indicar duración de retención y responder `410 Gone` si caducó. La viabilidad de lectura y hashing seguro desde Container aún requiere prueba Staging.

## 4. Servicio de descarga y seguridad propuestas

1. **Identidad/autoridad**: sesión de usuario y scope de tarea se comprueban server-side antes de leer; no confiar en el nombre/path/URL enviado por modelo, usuario o MCP; rutas derivadas solo de IDs validados. Operaciones GET sin efectos sobre objetos compartidos. Responder 403 a otro dueño, 404 a inexistente, 410 a caducado, 409 al archivo aún preparándose y 502 ante fallo de fuente. No filtrar detalles de paths a errores.
2. **Origen/URL**: mismo origen HTTPS de la interfaz, ruta canónica sin `?token=`, userinfo, redirect ni URL proporcionada por el modelo; `file:`, `/bundle`, IPv4/IPv6 privado, loopback, `javascript:`, `data:` no controlado y HTTPS arbitrario no son URLs backend válidas. Si algún día se usan presigned R2, caducidad corta, operación GET y bucket/clave aislados; el token firmado es secreto de acceso temporal y no debe quedar en logs/referrers. Revocación efectiva exige política especial; presigned por sí solo no demuestra ACL después de emitido.
3. **Bytes/tamaño/hash**: antes de anunciar descarga verificar lectura de fuente, `byteSize` y SHA-256 del contenido final. Responder `Content-Type` allowlisted y normalizado; `Content-Disposition: attachment` con fallback ASCII y `filename*=UTF-8''...`; `X-Content-Type-Options: nosniff`, `Cache-Control: private,no-store`, `Referrer-Policy: no-referrer`; prohibir redirects. Hash y conteo se validan al consumir el GET completo; no aceptar `200` ni `HEAD` como prueba suficiente. Archivo cambiado durante lectura → fail closed, sin entregar versión parcial anunciada como íntegra.
4. **MIME/nombres**: normalizar Unicode NFC, conservar letras válidas y extensiones `.txt/.md/.json`; rechazar traversal, separadores Windows/Linux, caracteres de control, bidi overrides, ocultos y nombres maliciosos. Rechazar HTML/SVG activos; no previsualizar contenido no confiable en el mismo origen. No basta con confiar en el MIME declarado: comparar con extensión y, según formato, inspección/validación adicional. Mantener política de tipos cerrada y límite por tamaño; `.bin` solo como adjunto no interpretable.
5. **Retención y errores**: indicar `createdAt`, `expiresAt` y estado `pending/ready/expired/error`; revocar/no anunciar el archivo si Container ya no existe. La lista es página acotada, con cursor estable; nunca leer todo para cortar después. Para un cliente Android, descargar por `GET` autenticado con respuesta binaria, sin depender del estado temporal `blob:` de otra pestaña.

## 5. Streaming, paginación y truncamiento

- **Progreso**: reutilizar cursor durable `nextAfter` de `remoteSupervisorProgress`, conservar `truncated` y documentar si faltan eventos. No presentar una página acotada de 100 eventos como historia completa.
- **Texto final**: resumen pequeño (propuesta fixture: máximo 8.000 caracteres), con `truncated`, `omittedChars` y futura referencia paginable si excede; no simular respuesta íntegra con `slice` silencioso. JSON grande debe ofrecerse como archivo, no en un único frame MCP o atributo DOM.
- **Archivos**: transmitir bytes sin lectura completa en heap; digest verificado desde fuente o por streaming; para descargas grandes utilizar `Content-Length` y opcional `Range` **solo** si el proveedor garantiza versión inmutable, autorización por rango y checksum final. No truncar una descarga exitosa; 413/error es preferible a archivo parcial.
- **Política local del fixture**: máximo 20 MiB por artefacto, 32 artefactos por tarea, nombre 120 caracteres, expiración máxima 24 h y whitelist txt/md/json/bin. **Estos valores solo pertenecen a la prueba**, no son límites desplegados ni presupuesto acordado. Deben validarse con métricas y UX.

## 6. Pruebas implementadas (fixture offline, no código de producción)

Archivos propuestos para la rama del encargo:

- `docs/f0-c10/fixtures/09-output-contract.mjs`: esquema, validación de identidad, rutas canónicas, MIME y Unicode, expiración, límites y verificador GET real que compara `Content-Length`, MIME, `Content-Disposition`, bytes y SHA-256 por stream.
- `docs/f0-c10/fixtures/09-output-contract.test.mjs`: servidor HTTP **solo en loopback 127.0.0.1** con autenticación sintética; respuestas reales de bytes, truncamientos y errores; ninguna conexión a recursos de Staging. `http:` está habilitado únicamente en modo test local, nunca en el contrato de producción.

**Comando ejecutado localmente:** `node --test docs/f0-c10/fixtures/09-output-contract.test.mjs` (Node 22.16.0) → **14 PASS, 0 FAIL, exit code 0**. La primera corrida tuvo un FAIL por expectativa incorrecta de longitud/hash; corregida y re-ejecutada GREEN. Los tests validan:

| Escenario | Resultado offline |
|---|---|
| `.txt`, `.md` UTF-8/Unicode y `.json` | GET, bytes y SHA-256 exactos: PASS |
| `.bin` 2 MiB entregado en fragmentos | Stream y digest: PASS |
| 10 tareas terminando fuera de orden | 10 IDs únicos, cada `artifactId` mantiene su `requestId` y hash: PASS |
| Inyección de artefacto de otra tarea | Rechazada antes del GET: PASS |
| Bytes corruptos / igual longitud pero distinto contenido | Rechazados por `Content-Length` o SHA-256: PASS |
| Ruta `/bundle`, `file:`, HTTPS malicioso, parámetro secreto | Nunca aceptada como ruta de descarga: PASS |
| MIME HTML/SVG, extensión incongruente, traversal, nombre bidi | Rechazados: PASS |
| Link expirado, tamaño excesivo, duplicados, truncamiento no declarado | Rechazados: PASS |
| HTTP 404/403/302, MIME alterado, origen distinto | Rechazados: PASS |
| Nombre Unicode de descarga distinto del manifiesto | Rechazado: PASS |

**Alcance exacto de la demostración:** la prueba sí ha recuperado bytes mediante un GET HTTP real en un servidor *sintético local* y comprobado SHA-256 y asociación de 10 solicitudes. **No demuestra** que el Worker publicado sirva estos endpoints, que diez tareas OpenCode funcionen simultáneamente, que los archivos duren tras reinicio, ni que Android real pueda descargarlos. El fixture no realiza test de autenticación multiusuario real, de red Cloudflare/Access, de 20 MiB límite físico, ni de navegadores Android.

## 7. Referencias abiertas (estudiadas, sin copiar código)

- **OpenHands Software Agent SDK:** `RemoteWorkspace` separa directorio de trabajo de API HTTP; su [`remote_workspace_mixin.py`](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/workspace/remote/remote_workspace_mixin.py) utiliza `/file/download`. Patrón reutilizable: operación de archivo del workspace con una ruta de API, no path local directamente a navegador. No trasladar sin ACL, autorización y validaciones. Repo: https://github.com/OpenHands/software-agent-sdk.
- **SWE-agent:** conserva outputs/trajectorias por instancia como archivos separados, no equipara la observación textual de una herramienta con descarga; https://swe-agent.com/latest/usage/trajectories/. Útil para identificación y recibos por tarea, no como transporte listo para OpenCode.
- **Cloudflare R2**: https://developers.cloudflare.com/r2/objects/download-objects/ (Worker binding GET/stream, S3 presigned). https://developers.cloudflare.com/r2/api/s3/presigned-urls/ (expiración 1 s a 7 días, credenciales S3 necesarias para firmar; Worker R2 binding no genera presigned por sí solo). Requiere una autorización separada antes de utilizar bucket real.
- **HTML/Android browser:** https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a : el atributo `download` no obliga a descargar cualquier URL cross-origin; depende de mismo origen, `blob:` o `data:`; para cross-origin cuenta `Content-Disposition`. Probar en Android Chrome real sin asumir comportamiento de un WebView.
- PR del proyecto #100 (UI file), #102 (taskId), #105 (stdout/stderr) enlazadas arriba.

## 8. Limitaciones Android y criterios de aceptación

Se requiere un teléfono Android autenticado real para comprobar, con un usuario autorizado, que después de completar una tarea se muestra un archivo real, aparece la descarga del sistema, abre correctamente `.txt/.md/.json`, conserva Unicode en el nombre, funciona al cambiar de conversación/reiniciar cliente y niega archivos de tarea ajena o expirados. Capturar versión Android/navegador, source SHA/deployment, requestId, bytes, SHA, HTTP status, UI y logs sanitizados. Pruebas Playwright con emulación móvil **no** sustituyen esta aceptación. No hay dispositivo Android disponible en este encargo y no se ejecutó esta prueba.

## 9. Corrección mínima y bloqueantes para integración

**Entrega presente:** contrato + fixtures reproducibles y documentación; no cambiaron `src/server.ts`, `src/staging-control-mcp/server.ts`, `src/client.tsx`, Storage, R2, routes reales, permisos, `main` ni Workers. Recomendación para otro lote de integración: (1) agregar en supervisor una proyección durable de artefactos por tarea y estado de disponibilidad; (2) endpoint GET autenticado `/api/tasks/{requestId}/artifacts/{artifactId}` limitado a files permitidos (o almacenamiento aislado aprobado); (3) bytes verificados por streaming y manifest con digest; (4) cliente con estado `disponible/expirado/error` y descarga real, no enlace de texto; (5) pruebas E2E y Android. No efectuar cambios de bucket sin nueva autorización ni incrustar secretes en URL. Auditar posibles conflictos con las otras nueve PR antes de integrar.

**Bloqueantes:** productor real no entrega manifest, no hay endpoint per-task, retención garantizada ni pruebas Android; concurrencia de diez/estabilidad del Worker sigue abierta (#90); presupuesto y corte real de Remote no verificados. Conservar esta PR como draft; no hay permiso de merge/deploy. El CI del HEAD de esta PR debe consultarse tras creación, no inferirse de PR anteriores. Estado F0-C10 completo permanece `NOT VERIFIED`.

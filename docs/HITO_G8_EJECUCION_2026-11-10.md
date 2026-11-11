# OpenCode Cloud — G8: aislamiento de CDF CLOUD y WorkBench (10 noviembre 2026)

**ESTADO DEFINITIVO (10 noviembre 2026): G8 APROBADO EN STAGING.** La captura autenticada aportada por el propietario muestra que la comprobación real del agente aprobó ambos repositorios mediante `repo_review`. Todas las evidencias y el alcance exacto figuran en el **§12 (cierre final)**; los apartados §1–§11 conservan el registro histórico de los bloqueos anteriores. **G9 — Endurecimiento mínimo y entrega** es el hito siguiente. No hay autorización para fusionar ni publicar en producción.

## 1. Informe maestro y línea base

Se leyó íntegramente `Informe_Integral_OpenCode_Cloud_V1.pdf` de 21 páginas, el plan `docs/V1_EXECUTION_PLAN.md` y el acta definitiva de G7. G1–G7 están cerrados en staging, G7 sustentado por captura del titular con incidente real `SHELL_FAILED` (`exitCode 19`).

El gate literal G8 es: «ambas pruebas muestran repositorio correcto, diff correcto, regresiones ausentes y recuperación». Sus dos recorridos son **CDF CLOUD** y **WorkBench**, en ramas nuevas, mediante lectura, cambio no canónico, prueba y PR borrador, sin escrituras a canon, fuentes narrativas ni producción. El siguiente gate G9 corresponde a entrega, pruebas finales y publicación controlada.

## 2. Riesgo anterior y cambio de arquitectura mínimo

Antes de G8 existía una lista de repositorios autorizados para el puente GitHub, pero la selección del proyecto en la interfaz se comunicaba al modelo **solo como texto del prompt**. Una sesión de agente podía pedir un `repo` o `project` distinto en sus argumentos de herramientas, dentro de la lista global autorizada. Esto NO satisfacía aislamiento.

Se corrigió sin añadir otro motor:

- `src/project-scope.ts`: ámbito inmutable por sesión, con identificador de conversación verificado y asociación `{project,repository}`. La asociación del repositorio debe pertenecer a la lista explícitamente autorizada en Configuración. Cambiar de proyecto o repo requiere **otra conversación**; un LLM no puede revincular una sesión.
- `src/server.ts` y `src/sockets.ts`: se fija el ámbito en Durable Object **antes de iniciar una tarea** y se hereda al delegar una revisión. Los tests automáticos internos vinculados al sistema reciben un proyecto aislado. El binding se conserva durante reconexiones o reinicios de Durable Object.
- `src/workspace.ts`: **en el instante de ejecutar la herramienta**, valida el `sessionID` real proporcionado por OpenCode. Rechaza `github` dirigido a otro repositorio, `linux/inspect_linux` dirigido a otro proyecto y escrituras/ejecución global en el Workspace sin límite por proyecto. Sin ámbito, falla cerrado. Plan y Review conservan su restricción de escritura.
- `src/protocol.ts`, `src/use-opencode-session.ts` y `src/client.tsx`: el cliente envía proyecto+repositorio como campos estructurados, no solo instrucciones en lenguaje natural. El panel **Proyectos** muestra repositorios autorizados; elegir uno crea una **conversación nueva**, asignando un proyecto Linux propio.
- `src/github.ts`: además de permitir solo ramas `opencode/*` y PR borradores, rechaza escrituras en rutas claramente canónicas, narrativas, despliegues, workflows y archivos de secretos. La acción nueva `review` obtiene un resumen limitado y **solo lectura** de archivos cambiados contra `main` desde la API oficial GitHub. No puede hacer merge, borrar ramas, cambiar `main` ni desplegar.
- `src/tool-permissions.ts`: permite usar `review` de GitHub también en modo Plan/Revisión sin conceder permisos de escritura.

No se introdujo ninguna dependencia, cola de autoparches, despliegue a producción ni modificación del sistema editorial CDF.

## 3. Dos pruebas reales independientes en GitHub

Se verificó que ambos repositorios privados existen y tienen rama por defecto `main`. Se leyó el README de cada uno y se crearon ramas nuevas específicas de G8. **Las siguientes operaciones se ejecutaron desde el conector GitHub del supervisor, NO desde el navegador OpenCode Cloud**:

| Proyecto | Rama de prueba | Commit | PR borrador | Diff comprobado |
| --- | --- | --- | --- | --- |
| CDF CLOUD, `aamvtrampa36-del/cdf-cloud-engine` | `opencode/g8-cdf-isolation-20261110` | `f1e4027b9d35b4e885ce0fbe86ee43c2df20bf35` | [#160](https://github.com/aamvtrampa36-del/cdf-cloud-engine/pull/160) | Solo `docs/opencode-g8/isolated-review-20261110.md`, 16 líneas añadidas |
| WorkBench, `aamvtrampa36-del/CDF-WorkBench-` | `opencode/g8-workbench-isolation-20261110` | `85502acb534cb28ce7e8cd1774d4fcdbff280e13` | [#36](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/36) | Solo `docs/opencode-g8/isolated-review-20261110.md`, 16 líneas añadidas |

Cada archivo contiene un marcador distinto (`G8-CDF-ISOLATION-PROOF` y `G8-WORKBENCH-ISOLATION-PROOF`). Se recuperaron ambos archivos desde sus ramas y se comprobó que cada uno contiene **solo su propio marcador**, el repo correcto y la rama correcta. Se consultó el patch de las dos PR y se confirmó un único archivo `added` en cada una. La misma ruta de prueba **no existe en `main`** de ningún repositorio. Ninguna PR se fusionó; recuperar consiste en cerrar cada borrador o abandonar la rama sin modificar `main`.

**Regresiones y CI de repositorios:** el PR de WorkBench tiene GitHub Actions **#161** `completed/success`. Para CDF CLOUD no se recuperó ningún run asociado con el commit de la rama de prueba; su README indica expresamente que cambios en `docs/**` no activan despliegues. Al ser una adición documental sin archivos operativos cambiados, no hay cambios de runtime que probar en esas dos PR. **No se declara que se hayan ejecutado las compilaciones completas de CDF CLOUD o WorkBench desde OpenCode Cloud.**

## 4. Tests del aislamiento y verificación sin IA

- `src/project-scope.test.ts`: repos válidos, ámbitos inmutables, rechazo de cruces de repositorios/proyectos, bloqueo de herramientas sin ámbito y de escrituras globales.
- `src/sockets-g8.test.ts`: prueba de despacho con Harness simulado; liga la sesión antes de enviar, rechaza cambiar de CDF CLOUD a WorkBench en la misma conversación y permite continuar en el repositorio original.
- `src/github.test.ts`: niega `main`, `../`, escritura a rutas oficiales y de despliegue; prueba nueva acción `review` solo lectura y diff limitado.
- `src/g8-smoke.ts` y `src/g8-smoke.test.ts`: un verificador que utiliza el mismo `GitHubBridge` de OpenCode Cloud. Lee metadatos, archivos reales y diffs de **ambas ramas de prueba**, rechaza cruces y cualquier marcador/diff inesperado. No ejecuta acciones GitHub de escritura ni consulta un modelo. Tests con puente simulado verifican ese contrato y el rechazo de marcadores incorrectos.
- `src/server.ts`: endpoint `POST /api/dev/g8-verify` protegido por Cloudflare Access y petición JSON de mismo origen; utiliza la conexión GitHub de **OpenCode Cloud** y la lista de repositorios autorizados, no credenciales que circulen por ChatGPT. `src/client.tsx`: botón **Comprobar aislamiento CDF CLOUD y WorkBench** en el panel Proyectos; una pulsación realiza las lecturas reales y muestra éxito solo si ambos repositorios están correctos. Puede fallar con indicación de conectar GitHub en Configuración. No usa tokens de IA, ramas nuevas ni escrituras.
- GitHub Actions del repositorio OpenCode Cloud: **#226 y #229 `completed/success`** tras introducir y probar el aislamiento; el último cambio del UI también superó Cloudflare Workers Builds para `11b705a923305e96d25c4bf17bdc4de365ac3a49`.
- Staging publicado: `db45748a-19a3-4ef4-8be7-5def172cbab1`. Producción `opencode-harness-example` sigue en `1d70eb77-316e-408d-bd14-5f19b171dedf`. Cron vacío. Staging conserva Cloudflare Access.

## 5. Criterios de cierre y bloqueo externo mínimo

| Requisito G8 | Evidencia | Dictamen |
| --- | --- | --- |
| Identificar correctamente ambos repositorios | Metadata privada y readback de ramas por GitHub conectado | **APROBADO (conector GitHub del supervisor)** |
| Rama nueva, archivo no canónico, PR borrador y diff correcto | PR #160 y #36; un único archivo agregado en cada una; `main` intacto | **APROBADO (conector GitHub del supervisor)** |
| No escribir fuera del proyecto seleccionado | Validación servidor por `sessionID` y tests de rechazo, compilación de staging | **APROBADO TÉCNICAMENTE; sin prueba de denegación real en un agente del propietario** |
| Regresiones y recuperación | CI de aislamiento OpenCode y WorkBench; CDF no lanzó CI documental. PRs reversibles y no fusionadas | **Evidencia suficiente para cambios de documentación; no hay compilación CDF de esta rama** |
| Integración real con la conexión GitHub **dentro de OpenCode Cloud** | Endpoint seguro y botón de verificación implementados, **aún no invocados con la sesión autenticada** | **PENDIENTE** |
| Ciclo agente de OpenCode que usa herramienta GitHub con sesión ligada | Hay pruebas de binding y bridge, pero todavía no una traza real de agente sobre las dos ramas | **PENDIENTE** |

**Dictamen vigente: G8 IMPLEMENTADO Y VALIDADO AUTOMÁTICAMENTE EN STAGING, PERO NO APROBADO FUNCIONALMENTE.** Las PR reales por el conector GitHub externo no sustituyen las pruebas del cliente OpenCode. No afirmar que G8 está cerrado o que G9 ha iniciado.

### Acción mínima del propietario

1. Abrir `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev` desde Android → **Proyectos** → **Comprobar aislamiento CDF CLOUD y WorkBench**. Si la aplicación aún no tiene GitHub conectado, el botón estará deshabilitado y habrá que conectarlo desde Configuración dentro de la aplicación (no pegar tokens aquí).
2. Confirmar que aparece: **«Verificado: CDF CLOUD y WorkBench están aislados. Dos diffs correctos, ninguna escritura o inferencia durante la comprobación.»**. Si falla, compartir solo el mensaje, nunca secretos.
3. Después, para el gate de *agente real*, abrir una conversación aislada por cada repositorio desde el selector y pedir una **revisión de solo lectura de la rama G8**, con acciones `github repo/read/review`. Confirmar que ambas respuestas usaron herramientas reales y los diffs correctos. No pedir nuevas escrituras: las PR de prueba ya existen.

Si estas pruebas pasan, actualizar matriz, cerrar G8 y comenzar G9 — pruebas de entrega y publicación controlada. En caso contrario, corregir únicamente el defecto observado, sin ampliar G8. No desplegar producción ni fusionar PRs sin autorización explícita.


## 6. Fallo de aceptación real y reparación dirigida (10 noviembre 2026)

### Lo que mostró Android

El propietario completó primero el gate de lectura directa **Proyectos → Comprobar aislamiento CDF CLOUD y WorkBench**: captura con resultado `Verificado: CDF CLOUD y WorkBench están aislados. Dos diffs correctos, ninguna escritura o inferencia durante la comprobación.` Se valida así el puente GitHub interno, las dos ramas y el diff auténtico **sin agente**.

La segunda prueba fue un **bloqueo reproducible**: desde Android, sesión `ses_e396b5669ffeC76a36yl1T4BPv`, proyecto `cdf-cloud-engine`, modo **Revisión**, el agente intentó verificar la rama `opencode/g8-cdf-isolation-20261110` y produjo **10 herramientas fallidas y 0 completadas**. Capturas del titular muestran fallos de `github`, `ls`, `find`, `grep`, `read`, `inspect_linux` y `exec`, mensaje de permisos de Revisión que recomendaba cambiar a Desarrollar, y errores `File not found: /bundle/.git/HEAD`. El agente declaró correctamente que no pudo leer datos y que **no emitiría una revisión inventada**. La interfaz mostró incremento aproximado de cuenta OpenRouter de **0,0014 USD** (no factura exacta por tarea).

**Conclusión:** el gate G8 de operación real de herramientas **FALLÓ**, aunque el gate de verificación directa del puente sí había pasado. El modo Revisión se mantuvo sin escritura, lo cual es positivo; el problema fue su incapacidad de acceder al diff, no la ausencia de un repositorio en GitHub.

### Defectos identificados y correcciones

1. **Lista incompleta de operaciones de lectura.** En `src/tool-permissions.ts` las herramientas genéricas `ls`, `find` y `stat` no estaban en la allowlist del modo `plan`/Revisión. Se ampliaron **solo** los permisos de lectura y se conservaron las prohibiciones de shell, edición y escrituras. Test de regresión actualizado.
2. **Ruta falsa de checkout.** Las herramientas de archivo del Durable Object operan sobre otro workspace; `/bundle/.git/HEAD` **no representa** el repositorio GitHub seleccionado. Antes el agente intentó consultar esa ruta en vez de utilizar `GitHubBridge`. Se reforzaron las instrucciones de sistema para indicar explícitamente que las revisiones de repositorios deben usar GitHub remoto, no herramientas genéricas de archivos.
3. **Selección innecesaria del `repo` mediante el modelo.** `src/scoped-github.ts` proporciona acciones de lectura (`repo`, `read`, `review`) que obtienen el identificador **solo de la asociación inmutable en Durable Object según el `sessionID`**, no de argumentos del modelo. Reaplica la guardia de proyecto/repositorio antes de llamar a la API.
4. **Herramientas inequívocas de agente.** `src/workspace.ts` registra `repo_review`, `repo_info` y `repo_read` con argumentos limitados; `repo_review` solo necesita `branch`, y funciona en Revisión. Se preserva el puente GitHub anterior para funciones de edición acotadas, sin ampliar privilegios.
5. **Prompt inicial incorrecto para G8.** `src/client.tsx` ahora inicia nuevas conversaciones de repositorio en modo Revisión, limpia perfiles anteriores y precarga un mensaje concreto que usa exclusivamente `repo_review` para la rama G8 apropiada. No recomienda `ls`, `find`, `read`, `exec`, `inspect_linux` ni `/bundle` al revisar GitHub.

### Commits, validación y seguridad

- `872e4687b0ae7190bc51fb1cfa476de72ab37bd2`: permisos de lectura.
- `9a7ca164cd3960b83d8bb862111a26fb66e766da`: tests de Revisión.
- `7fad5199ac886c6ef9177481a7e6816ef26e5e7d`: operaciones de GitHub derivadas del ámbito confiable.
- `a9d4f184770817ea9b7e8136c6d1843ae03f6b5b`: herramientas `repo_review`, `repo_info`, `repo_read` e instrucciones.
- `bcf1138c32b81dd7ee8c13fa83894cc093f5471a`: obtención de repo vinculado desde Durable Object.
- `bdd1bf4af46850e0673b1e820034598f861838fb`: tests de binding y bloqueo cruzado con modelo `plan`.
- `3be3cda5298db96fed9790e7d170e7377f5f55f8`: una nueva conversación G8 inicia con prompt de revisión dirigido.
- **CI #237 y #238: `completed/success`**, TypeScript, pruebas y build. **Cloudflare Workers Builds: `success`** para `3be3cda5`; staging `7525611c-af5e-48a4-884e-569cac5f6d87`.
- Producción conservó `1d70eb77-316e-408d-bd14-5f19b171dedf`, Cron staging vacío, Cloudflare Access `self_hosted` con una política. PR #28 y PR de prueba CDF #160 / WorkBench #36 permanecen **borrador**, sin merge ni deploy productivo.

### Dictamen después de la reparación

**G8 SIGUE PENDIENTE de retest del agente real.** Se demostró por código y CI que la nueva ruta de `repo_review` usa el repositorio de la sesión y conserva el modo Revisión; no se ha recibido todavía evidencia de su funcionamiento bajo inferencia auténtica desde Android. No afirmar que G8 está aprobado. El gate directo de las dos ramas **sí está validado**; no repetirlo ni crear nuevas PR de prueba.

**Acción mínima del titular:** abrir staging desde Android, Proyectos → **Seleccionar repositorio y crear conversación** → elegir `aamvtrampa36-del/cdf-cloud-engine`. Esto crea **una nueva sesión**, con modo Revisión y un mensaje precargado para comparar la rama G8 mediante `repo_review`. Enviar el mensaje sin modificarlo y confirmar **al menos una herramienta `repo_review` completada** y un diff de un solo archivo `docs/opencode-g8/isolated-review-20261110.md`. Repetir para `aamvtrampa36-del/CDF-WorkBench-`, en **otra conversación nueva**. Si falla, compartir error específico y detener para no gastar más inferencia.

El siguiente hito es G9 — entrega y publicación controlada, **sin iniciarlo formalmente** hasta aprobar la prueba del agente en ambas sesiones. Ninguna de estas verificaciones autoriza despliegue productivo.


## 7. Reparación complementaria: exportación del historial desde Android (10 noviembre 2026)

**Incidente informado por el propietario:** después de intentar compartir el resultado de una revisión del agente de G8, el propietario indicó «No puedo descargar el chat. Hay un error en la página». No se recibió aún código HTTP ni detalle exacto del error. El fallo no demuestra una pérdida del historial persistido; la sesión sigue identificada como `ses_e3924f7e6ffedOa29YMzSIcVQ0`, espacio `2eb8e899-dd94-4733-b990-2fc99e0f7d5c`. El origen es una **hipótesis técnica plausible**, no un diagnóstico del navegador confirmado: el anterior `src/client.tsx` exportaba una copia JSON con URL `blob:` temporal y llamaba `URL.revokeObjectURL` inmediatamente después del clic, lo que puede cancelar descargas en navegadores móviles.

**Corrección de bajo alcance, sin modificar G8 ni datos:**
- `src/client.tsx`: se reemplazó el clic sobre `blob:` efímero por enlace nativo a descarga autenticada del mismo origen. Puede usarse aunque se haya interrumpido la conexión WebSocket.
- `src/server.ts`: `GET /api/session/export?object=…&session=…`; valida estrictamente UUID del espacio y formato de sesión, comprueba que la sesión existe, obtiene su historial guardado desde el Durable Object de OpenCode y responde `Content-Disposition: attachment`, `Content-Type: application/json`, sin caché. Se reutiliza Cloudflare Access, sin endpoints públicos adicionales ni nuevos permisos.
- `src/session-export.ts` y `src/session-export.test.ts`: validación de entradas, formato compatible `opencode-harness-session-v1`, metadatos, contenido, cabeceras, protección frente a nombres manipulados y no caché.
- El DO devuelve un JSON serializado como cadena para evitar profundización recursiva de tipos al cruzar el límite RPC. Ningún historial se escribió en GitHub ni en telemetría.

**Validación real:** GitHub Actions **#245** falló en tipado recursivo del RPC; se corrigió con JSON serializado. GitHub Actions **#247** (run `42884472537`) finalizó **`completed/success`**; Workers Builds final `success`, commit `87db6bfefa62869d96fb42d0e36aca0e6aa68bc3`; staging `4be0f4d7-4d56-4501-9e95-ae048ad82301`. Producción conserva `1d70eb77-316e-408d-bd14-5f19b171dedf`, sin merge.

**Aceptación pendiente:** abrir staging desde Brave/Android y pulsar nuevamente **Exportar sesión** en la conversación afectada. Comprobar que se descarga `opencode-session-ses_e3924f7e6ffedOa29YMzSIcVQ0.json` y que contiene el historial, sin reejecutar IA. No afirmar que la reparación ya funcionó en ese navegador hasta recibir evidencia. Si el error persiste, capturar la página o estado de respuesta, sin incluir cookies ni tokens.

**Estado de G8 inalterado:** el primer recorrido del agente falló; G8 continúa pendiente de revisión real satisfactoria con `repo_review` en CDF CLOUD y WorkBench. Esta reparación restaura una vía sencilla para aportar evidencia sin gastar tokens de IA.


## 8. Descarga de proyectos — corrección de respuesta inválida y prevención (10 noviembre 2026)

**Evidencia nueva:** el propietario aportó captura de Brave/Android `ERR_INVALID_RESPONSE` en `GET /api/dev/download/cdf-cloud-engine`. Esta es **la ruta de archivo de proyecto**, no `/api/session/export`. La corrección anterior de exportación de conversaciones (§7) no intervenía en esta ruta.

**Causas verificadas mediante lectura del código:** (1) `src/preview-server.ts` enviaba `200` y comenzaba a hacer `tar.stdout.pipe(res)` **antes de comprobar el código de salida de `tar`**; una compresión fallida podía abortar la respuesta o entregar contenido incompleto. (2) `src/server.ts` asignaba `application/gzip` y `Content-Disposition: attachment` **incluso ante respuestas de error** (404/500). (3) seleccionar un repositorio GitHub en la UI **no lo clona en el Container**; descargar el nombre virtual desde `/workspace/projects` podía devolver 404. Estos son defectos comprobados del diseño; **no hay una traza HTTP histórica** que permita atribuir con certeza el `ERR_INVALID_RESPONSE` específico a solo uno de ellos.

**Solución acotada y reversible:**
- `src/preview-server.ts`: genera `tar.gz` en disco temporal; **comprueba el fin satisfactorio de `tar` y el tamaño antes de emitir 200**, transmite mediante stream con `Content-Length` exacto y elimina el temporal al terminar/cerrar. Mantiene exclusión de dependencias, `.git` y secretos; error de archivo ausente = 404; error de `tar` = 500. Se limita a 256 MiB comprimidos para evitar agotar el Container.
- `src/download-response.ts`: un único límite HTTP para archivos binarios, separando 404/502 JSON de las descargas exitosas; no reenvía encabezados hop-by-hop, de compresión HTTP ni nombres de archivo arbitrarios.
- `src/github-download.ts` y `src/server.ts`: si el proyecto corresponde a un repo de la sesión, ofrece un **ZIP remoto** mediante el token de GitHub ya guardado en Configuración. El servidor recupera el repositorio del ámbito **inmutable** de esa sesión y comprueba la allowlist, sin enviarlo al Container o al modelo. La ruta local sigue ofreciendo `tar.gz` para archivos realmente guardados en Linux. No se añaden secretos ni conexiones.
- `src/client.tsx`: enlace de descarga nativo del navegador; para repo enlazado muestra **Descargar repo**, y para proyecto Linux **Descargar**. No abre ventanas emergentes ni usa URLs `blob:`.
- `src/dev-container.ts`, `src/preview-server.ts` y `scripts/test-preview.mjs`: comparten un puerto versionado del preview server (**4322**) para impedir reutilizar la instancia Node vieja, que puede seguir viva en el Container después de un despliegue. **No se reinicia ni borra el Container ni sus snapshots**. El tiempo permitido para preparar un archivo es mayor que el de servir HTML estático y sigue siendo finito.

**Pruebas realizadas:** `src/preview-server.test.ts` inicia un servidor Node **real**, solicita un archivo real por HTTP, compara `Content-Length` con los bytes, ejecuta `tar -tzf`, confirma contenido y exclusión de secretos; comprueba 404 de proyecto ausente y 500 legible si no existe `tar`. `src/download-response.test.ts` comprueba bytes binarios, errores sin encabezados de descarga, ZIP GitHub autorizado sin filtrar token, denegación por repo y no regresión del JSON de la conversación. El antiguo `scripts/test-preview.mjs` conserva el test E2E de archivos estáticos y se actualizó para usar el puerto compartido.

**Regresiones corregidas durante ejecución:** la primera CI #256 falló porque `ENOENT` de `spawn tar` se interpretaba como 404; se corrigió y la **CI #257 aprobó**. Tras actualizar el puerto, la CI #259 detectó que el antiguo smoke esperaba 4321; se corrigió y se unificó el puerto. La **CI #264** (run `42891616834`) finalizó `completed/success` con 92 tests, smoke del preview server y compilación aprobados. Cloudflare Workers Builds `success` para el commit `598aff1278e9f40304c07dc2f565d0078b66f0f5`; versión staging `1e26384c-a225-4ccf-a321-0cabceef470b`. Producción conservó `1d70eb77-316e-408d-bd14-5f19b171dedf`, Cron vacío, Access `self_hosted` con una política.

**Dictamen de descargas:** **reparación técnica implementada y validada automáticamente en staging**. La transmisión de un archivo tar íntegro se demostró en un servidor Node real de CI; no se ha podido reproducir una descarga desde la sesión privada del propietario bajo Cloudflare Access desde esta conexión. El ZIP privado real de GitHub quedó pendiente de prueba en Brave; los tests de su pasarela HTTP usan respuesta GitHub simulada. **No presentar como comprobado en Android** hasta recibir un archivo descargado válido.

**Prueba manual mínima:** desde Android, abrir la conversación que tenga seleccionado el repo `cdf-cloud-engine` y pulsar **Descargar repo**. Debe aparecer un ZIP que pueda abrirse y contenga el repositorio. Si ya se trata de un proyecto Linux local, usar **Descargar**, esperar el `.tar.gz` y comprobar que se abre. No hace falta volver a ejecutar ninguna IA. Si falla, conservar el mensaje HTTP exacto; no compartir credenciales.

**G8 sigue pendiente por separado:** la aceptación real de `repo_review` sobre los dos repositorios continúa sin completarse. Solucionar las descargas no equivale a aprobar G8 ni autoriza fusionar PR o publicar producción.


## 9. Aceptación de la descarga GitHub desde Brave/Android (10 noviembre 2026)

**Veredicto específico: APROBADA la descarga de repositorios GitHub vinculados a una conversación.**

El propietario confirmó «Exitoso» y adjuntó el archivo realmente descargado `cdf-cloud-engine-github (2).zip` desde Android después de aplicar la corrección descrita en §8. Se inspeccionó el ZIP adjunto en el entorno de verificación sin modificarlo: **897.332 bytes**, **234 entradas**, **204 archivos regulares**, **2.998.313 bytes descomprimidos**, `ZipFile.testzip()` sin errores CRC. Raíz del archivo: `aamvtrampa36-del-cdf-cloud-engine-f5967fe84e22c2e629ae60a8aedabcceff016735/`, con `README.md` de CDF Cloud Engine y estructura de proyecto. SHA-256 del ZIP: `af688885c1703bcafea989ddf6984ee1c1425c1fe71de602b00dbd6acbc9e4ec`.

Esto demuestra **descarga real e integridad del ZIP privado de GitHub bajo la sesión de Android**, resolviendo el `ERR_INVALID_RESPONSE` para la vía nueva **Descargar repo**. Como es un archivo del repositorio por defecto (`main`), el ZIP no incluye el marcador de la rama de prueba G8; esto **no es un defecto** ni demuestra que el agente `repo_review` pueda analizar la PR. Las comprobaciones del tar local en Linux continúan basadas en la CI real, no en una nueva captura Android.

**Estado de la incidencia de descargas:** cerrada para el recorrido privado GitHub probado, con tests de regresión del tar local y del historial de conversaciones en CI. No volver a pedir esta prueba salvo regresión real.

**Estado de G8:** todavía **PENDIENTE** exclusivamente por revisión del agente mediante `repo_review` en conversaciones reales separadas de CDF CLOUD y WorkBench. No se fusionaron PR ni se desplegó a producción. Siguiente hito, después de G8 aprobado: G9, entrega y publicación controlada.


## 10. Revalidación del gate G8 tras cierre de descarga (10 noviembre 2026)

**Fuente obligatoria verificada:** lectura íntegra del informe maestro OpenCode Cloud V1 (21 páginas, 1.524 líneas), plan V1, actas previas y estado GitHub/Cloudflare. No se reabrieron hitos G1–G7.

**Estado vigente:** G8 es el hito actual y G9 el siguiente. La descarga ZIP real de CDF CLOUD desde Brave ya se comprobó con el adjunto válido (§9); no volver a pedir esa prueba.

**Última recuperación de GitHub:**
- PR principal de OpenCode Cloud [#28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28) sigue **abierta en borrador** sobre rama `fix/repeatable-agent-verification-20261108`, sin fusionar a `main`.
- [CDF CLOUD PR #160](https://github.com/aamvtrampa36-del/cdf-cloud-engine/pull/160) sigue en borrador, **no fusionada**; modifica únicamente `docs/opencode-g8/isolated-review-20261110.md`. Para el commit de esta rama documental no aparecen runs de GitHub Actions.
- [WorkBench PR #36](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/36) sigue en borrador, **no fusionada**; modifica únicamente la misma ruta de prueba en su propio repositorio. GitHub Actions #161 `completed/success`.
- No se realizaron nuevas escrituras en CDF CLOUD ni WorkBench ni se modificaron documentos canónicos.

**Brecha de pruebas detectada:** el código `src/scoped-github.test.ts` comprobaba la función de ejecución aislada, pero no probaba que `workspacePlugin` registrase realmente las herramientas `repo_review`, `repo_info` y `repo_read` para el agente en modo Revisión. Para evitar pedir otra inferencia al usuario sin esa cobertura, se añadió `src/workspace-g8-integration.test.ts`: inicializa el plugin de OpenCode, comprueba los tres nombres de herramienta y `codemode:false`, invoca realmente el manejador registrado de `repo_review` con el agente `plan` y verifica que usa el repositorio ligado al `sessionID` y que la guardia de permisos se ejecuta. Caso negativo: sesión sin repositorio y escritura GitHub desde modo Revisión no pueden alcanzar el ejecutor. Este test **no llama a un modelo real ni utiliza una sesión protegida de Android**, por lo que no reemplaza el gate operativo.

- Commit de cobertura: `326ae61ace55d16cb3fd0ee62ec4fe898b1ad5e8`.
- GitHub Actions **#268** `completed/success`.
- Cloudflare Workers Builds `success` para el commit `326ae61`; Worker staging `1a7e45ab-e14e-43d3-af23-fddd740fbcc3`.
- Worker productivo preservado `1d70eb77-316e-408d-bd14-5f19b171dedf`; staging con Cloudflare Access `self_hosted` (una política) y sin Cron.
- Este commit añade tests; no cambia la lógica de producción ni exige reinstalar extensiones o configurar tokens.

### Matriz vigente y aceptación mínima

| Requisito | Resultado |
| --- | --- |
| Repositorio correcto y diff de prueba independiente para CDF CLOUD y WorkBench | APROBADO; dos PR draft, un único archivo no canónico por repo |
| Privilegios acotados por proyecto/sesión; sin escrituras fuera del repo | APROBADO por pruebas automatizadas de guardias e invariancia de sesión |
| Herramienta `repo_review` realmente registrada y accesible por el handler del plugin | APROBADO en nueva prueba de integración #268 con puente simulado |
| Compilación y regresiones de OpenCode; WorkBench CI documental | APROBADO |
| Reversibilidad | APROBADO técnicamente; ambas PR siguen sin merge y se pueden cerrar sin afectar `main` |
| Herramienta `repo_review` completada desde un **modelo real en dos sesiones autenticadas** | **PENDIENTE**, sin evidencia nueva posterior al fallo de diez herramientas de la prueba anterior |

**Dictamen: G8 NO APROBADO AÚN; técnicamente listo para una última aceptación funcional.** No repetir revisión manual de diffs, descargas, CI o el botón directo de aislamiento; ya están confirmados.

**Intervención mínima desde Android:** en staging → Proyectos → seleccionar `aamvtrampa36-del/cdf-cloud-engine` (nueva conversación en modo Revisión) → enviar el prompt precargado de `repo_review`; confirmar herramienta completada y único archivo `docs/opencode-g8/isolated-review-20261110.md`. Repetir una vez con `aamvtrampa36-del/CDF-WorkBench-` en otra nueva conversación. Detenerse y compartir el primer error si una falla, sin reiterar inferencias. Con evidencia positiva de ambas, documentar G8 como APROBADO EN STAGING e iniciar G9 conforme al plan (sin merge ni despliegue productivo automático).


## 11. Cierre de la brecha operativa: aceptación real G8 con una sola pulsación (10 noviembre 2026)

**Motivo:** el informe maestro V1 pide dos proyectos reales, aislamiento y evidencia de operaciones verificables. La CI previa demostró que el plugin registra `repo_review`, pero la aceptación operativa aún exigía a la persona propietaria iniciar dos conversaciones y escribir instrucciones. El navegador protegido no puede ser operado desde la conexión administrativa actual; la conexión Browser requiere una sesión originada desde una extensión conectada. No es lícito ni necesario retirar Cloudflare Access.

**Intervención mínima implementada — sin nuevo motor ni permisos:** se reutilizó `OpenCodeHarness`, el mismo `workspacePlugin`, las credenciales GitHub almacenadas y el ámbito inmutable por sesión para construir una prueba **real, iniciada expresamente por el propietario** desde Proyectos.

- `src/g8-live-agent.ts` define las dos pruebas exactas, no configurables desde el navegador: CDF CLOUD `opencode/g8-cdf-isolation-20261110` y WorkBench `opencode/g8-workbench-isolation-20261110`. `assessG8LiveHistory` inspecciona exclusivamente partes `tool` llamadas **`repo_review`**, con `status=completed` y respuesta JSON que indique repo/branch correctos, comparación con `main` y **un solo archivo añadido** `docs/opencode-g8/isolated-review-20261110.md`. Textos afirmativos del modelo, otros nombres de herramienta, errores o diffs ambiguos **no aprueban**.
- `src/server.ts`: `startG8LiveReview()` crea **dos sesiones nuevas y separadas** en el Durable Object, fija por servidor el repositorio autorizado de cada una y usa `handle.setAgent("plan")` (lectura) y modelo Cloudflare GPT-OSS 20B (sin exigir OpenRouter). Cada tarea solicita solo `repo_review`. `getG8LiveReview()` consulta el historial verdadero de las sesiones, evalúa ambos resultados y persiste **passed/failed y evidencias tipadas**. No edita archivos, no crea PR, no usa Linux, ni publica. Repetir el clic reutiliza el estado y evita duplicar gasto de inferencia. Se mantiene el límite técnico de seguridad de seis minutos por tarea para evitar ejecuciones descontroladas.
- API: `POST /api/dev/g8-agent-check?object=<uuid>` requiere petición JSON del mismo origen protegido por Access y no acepta repo/model/branch/prompt desde el cliente; `GET` consulta el estado y las evidencias sin repetir inferencia.
- `src/client.tsx`: botón **«Validar agente real G8 (una vez)»** dentro de Proyectos, progreso automático y resultado por repositorio. Se informa que consume una pequeña cantidad de Workers AI. No se requiere escoger modelo ni crear dos conversaciones manualmente.
- `src/g8-live-agent.test.ts`: casos de aceptación estricta de cada repositorio y rechazo de respuestas inventadas, herramientas erróneas, llamadas fallidas, ramas equivocadas, cambios extra o contenido canónico. **Estos tests son deterministas y no sustituyen el clic real**, como indica explícitamente el gate.

**Commits:** `de07dd67b4bc60312f5a010916a54a06492d3c6c` (evidencia); `95740818c1a753a7971449a00d5464b6d94a30c0` (orquestación real); `92f7f39127f73b06143683e6589b225702e993de` (interfaz); `4f86368f2c64ca33dc1779f8cba4a538016a1161`, `15db2e9ce3feee6b51493bddada56c44c2beb5c7` (conservar evidencia); `804e6ecfc0899c71225cad417f5c3b8baceb7e4c` (tests).

**Validación automática:** GitHub Actions **#276** `completed/success`; Cloudflare Workers Builds `success`, versión de staging `b0239bc0-7868-49c2-9057-a71612edcf8b`. Producción continúa `1d70eb77-316e-408d-bd14-5f19b171dedf`, Access `self_hosted` con una política y staging sin Cron.

**Dictamen actual: G8 BLOQUEADO PARA CIERRE por una sola evidencia externa.** El botón existe y está probado en código, pero **aún no ha sido pulsado con la sesión autenticada del propietario**. No afirmar que el modelo hizo las dos lecturas ni que G8 está aprobado. La intervención mínima pendiente es abrir staging desde Android, ir a **Proyectos → Validar agente real G8 (una vez)**, y compartir únicamente el mensaje final. Si indica 2/2 y `repo_review` correcto, G8 puede quedar **APROBADO EN STAGING** y se pasa a G9. Si falla, el sistema conserva el motivo concreto por repositorio; corregir ese defecto antes de volver a generar inferencia, sin repetir las pruebas ya superadas. No fusionar PR ni desplegar producción.


## 12. Cierre definitivo G8 — aceptación de ambos agentes desde Android (10 noviembre 2026)

**DICTAMEN: G8 APROBADO EN STAGING.** No confundir con la aprobación de la V1 ni con autorización de merge o despliegue a producción.

### Evidencia de aceptación del propietario

El propietario presentó una **captura de Brave/Android, 23:01**, desde la aplicación staging protegida por Cloudflare Access, con el botón **«Validar agente real G8 (una vez)»** deshabilitado después de su ejecución y este texto visible:

> G8 verificado: ambos agentes reales ejecutaron repo_review, devolvieron los diffs correctos y no modificaron archivos.

En la implementación revisada, la interfaz muestra ese mensaje exclusivamente cuando `GET /api/dev/g8-agent-check?object=<uuid>` devuelve `status: "passed"`. La ruta consulta el Durable Object que contiene las dos sesiones reales independientes, y `assessG8LiveHistory` solo acepta un bloque `tool` llamado **`repo_review`** con estado `completed` y JSON de resultado que corresponda al `repo` esperado, la rama esperada, `base: main`, sin diff truncado y **exactamente un archivo agregado** `docs/opencode-g8/isolated-review-20261110.md`. Una respuesta en prosa del modelo no aprueba la prueba. Se verifica el mecanismo por código y pruebas automatizadas.

**Alcance de la evidencia:** la captura acredita el resultado que devolvió la aplicación en la sesión del propietario. No se ha accedido directamente desde esta conexión a los historiales privados del Durable Object, porque ello requeriría su sesión de Cloudflare Access. El respaldo verificable es la captura más el contrato del verificador y su CI, no una supuesta lectura administrativa de esas conversaciones.

### Matriz de criterios de cierre

| Requisito | Evidencia | Estado |
| --- | --- | --- |
| Repo CDF CLOUD correcto | PR CDF CLOUD #160 y lectura directa del repositorio; el verificador de agente exige repo y rama exactos | **APROBADO** |
| Repo WorkBench correcto | PR WorkBench #36 y lectura directa del repositorio; el verificador de agente exige repo y rama exactos | **APROBADO** |
| Revisión de agente REAL en dos sesiones separadas | Captura Android del resultado del verificador y lógica `startG8LiveReview/getG8LiveReview/assessG8LiveHistory` | **APROBADO EN STAGING** |
| Diff no canónico correcto | PR #160 y #36: cada una cambia solo `docs/opencode-g8/isolated-review-20261110.md`, respecto de `main` | **APROBADO** |
| Aislamiento y permisos | Ámbito inmutable por `sessionID`, guardias sobre herramientas, test del plugin e incidentes corregidos (§2–§11) | **APROBADO** |
| Regresiones | CI OpenCode #278 `completed/success`; Workers Builds `success`; WorkBench #161 `completed/success`; la PR documental de CDF no disparó un nuevo workflow | **APROBADO EN EL ALCANCE DE LOS CAMBIOS** |
| Recuperación | PRs en borrador no fusionadas; ramas de prueba descartables; ZIP del repo descargado de manera íntegra en Android (§9) | **APROBADO EN EL ALCANCE PROBADO** |
| No modificar canon ni producción | Diffs con un único archivo no canónico; producción Worker sin cambios | **APROBADO** |

**Distinción necesaria:** los commits de prueba, los archivos no canónicos y las PR #160 y #36 fueron creados por el supervisor utilizando el conector GitHub, **no por los dos agentes de la prueba final**. Los agentes demostraron lectura y revisión reales mediante `repo_review`; no se les atribuye haber implementado, compilado ni creado aquellas PR. G9 debe incluir un flujo completo de edición, test, revisión y rama reversible ejecutado por un agente para la entrega V1.

### Estado confirmado de infraestructura y versiones

- Rama aislada OpenCode: `fix/repeatable-agent-verification-20261108`; PR [#28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28) **abierta en borrador, sin fusionar**.
- PR [CDF CLOUD #160](https://github.com/aamvtrampa36-del/cdf-cloud-engine/pull/160): borrador, un archivo de prueba, sin merge.
- PR [WorkBench #36](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/36): borrador, un archivo de prueba, sin merge.
- Última CI de código antes de esta actualización: GitHub Actions [#278](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42942603202), `completed/success`, commit `1b61a95c782534daa2c2bd7a36a8115b30b00776`. Cloudflare Workers Builds del mismo commit: `success`.
- Staging antes de esta actualización documental: versión `03034084-2d9a-44b9-95f8-ecbae3ddd9b5`, protegido por Cloudflare Access `self_hosted` (una política), sin Cron.
- Producción: versión `1d70eb77-316e-408d-bd14-5f19b171dedf`, **sin cambios**.
- No hubo nuevas modificaciones en CDF CLOUD ni WorkBench durante el cierre.

### Transición: G9 — Endurecimiento mínimo y entrega

**G9 ES EL HITO ACTUAL TRAS EL CIERRE DE G8 EN STAGING.**

Criterios expresos del `docs/V1_EXECUTION_PLAN.md`: eliminar solo código muerto/dependencias duplicadas/flags incompatibles realmente demostrados; ejecutar la batería E2E de **12 pruebas del encargo** registrando evidencias y límites; disponer de un tag/release reversible con gates P0 aprobados; demostrar que el propietario puede completar un cambio real de desarrollo sin asistencia administrativa. **La lista literal de las 12 pruebas no está íntegramente especificada en el informe maestro histórico**: recuperarla del encargo original antes de inventar una matriz exacta.

**Primera acción técnica de G9:** crear una matriz de entrega que reutilice las evidencias ya aprobadas G1–G8, identifique sin suposiciones las 12 pruebas E2E del encargo y determine únicamente las pruebas P0 y el ciclo agente → edición → test → diff → rama que falten realmente. Ejecutarlas en staging sin repetir los recorridos ya probados salvo regresión justificada. Preparar tag/release reversible **sin publicarlo en producción ni fusionar PR sin permiso**.

**Criterio de eficiencia:** cierre de G8 definitivo, sin más mejoras marginales ni repetir `repo_review`. El eventual merge de las PR documentales de prueba es opcional; no forma parte de la aprobación de G8 ni de la autorización productiva.
